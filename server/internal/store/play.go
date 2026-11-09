package store

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// PlayCharacter is what the game server loads to put a character in the world.
type PlayCharacter struct {
	ID         int64
	AccountID  int64
	Name       string
	Vocation   string
	Level      int
	Experience int64
	Health     int
	Mana       int
	// HasPos is false until the first save: the server then places the character at
	// its town's temple.
	HasPos bool
	X, Y   int
	Z      int
	Town   string
	// Role is the account's role (RolePlayer, RoleGM, RoleAdmin).
	Role string
	// Skills are the saved skills; a skill without a row is at its base level.
	Skills []Skill
	// Inventory is the equipped items with their content (inventory_items as a tree).
	Inventory []InventoryItem
	// Storage is the quest progress and flags (quest_state: key → value).
	Storage map[string]int64
	// Conditions are the saved conditions (characters.conditions, T3.2).
	Conditions []Condition
	// PvP is the character's skull, kill counter and recent unjustified kills (T5.2).
	PvP PvPState
}

// PvPState is the PvP state of a character (T5.2): characters.skull, skull_until and
// pvp_kills, and its pvp_unjust_kills rows (oldest first).
type PvPState struct {
	Skull      int
	SkullUntil time.Time // zero without a skull
	Kills      int
	Unjust     []time.Time
}

// unjustKillsHorizon bounds what a login reads of pvp_unjust_kills: the longest window
// balance.yaml allows (pvp.*.windows hours <= 1440).
const unjustKillsHorizon = 1440 * time.Hour

// Condition is one saved condition of a character (T3.2): its time left (to the next hit
// of a damage condition, or to its end) and, for damage, the hits left and their damage.
type Condition struct {
	ID     string `json:"id"`
	LeftMs int    `json:"left_ms"`
	Ticks  int    `json:"ticks,omitempty"`
	Damage int    `json:"damage,omitempty"`
}

// InventoryItem is one row of inventory_items with the rows inside it: Slot is the
// equipment slot of a top-level item and the index inside its container otherwise.
type InventoryItem struct {
	ItemID int             `json:"item_id"`
	Count  int             `json:"count"`
	Slot   int             `json:"slot,omitempty"`
	Items  []InventoryItem `json:"items,omitempty"`
}

// Skill is one row of character_skills.
type Skill struct {
	ID    string
	Level int
	Tries int64
}

// CharacterState is the part of a character the game loop saves (logout and autosave).
type CharacterState struct {
	ID         int64
	Level      int
	Experience int64
	Health     int
	Mana       int
	X, Y, Z    int
	// Skills are upserted with the character row, in the same transaction.
	Skills []Skill
	// Inventory replaces every inventory_items row of the character, in the same
	// transaction: an item is never saved twice nor lost between two snapshots.
	Inventory []InventoryItem
	// Storage replaces every quest_state row of the character, in the same transaction.
	Storage map[string]int64
	// Conditions replace the saved ones (T3.2).
	Conditions []Condition
	// PvP replaces the skull, the kill counter and every pvp_unjust_kills row (T5.2).
	PvP     PvPState
	SavedAt time.Time
}

// CharacterBelongsTo reports whether characterID is a character of accountID.
func (s *Store) CharacterBelongsTo(ctx context.Context, accountID, characterID int64) (bool, error) {
	ok, err := s.q.CharacterBelongsToAccount(ctx, db.CharacterBelongsToAccountParams{ID: characterID, AccountID: accountID})
	if err != nil {
		return false, fmt.Errorf("character belongs to account: %w", err)
	}
	return ok, nil
}

// ConsumeSession deletes the session for tokenHash and returns it, if it had the given
// kind, had not expired at now and its account is not disabled. Otherwise it returns
// ErrNotFound. A token can be consumed only once.
func (s *Store) ConsumeSession(ctx context.Context, tokenHash []byte, kind SessionKind, now time.Time) (Session, error) {
	row, err := s.q.ConsumeSession(ctx, db.ConsumeSessionParams{TokenHash: tokenHash, Kind: string(kind), Now: ts(now)})
	if err != nil {
		return Session{}, fmt.Errorf("consume session: %w", notFound(err))
	}
	return Session{
		TokenHash:   tokenHash,
		AccountID:   row.AccountID,
		Kind:        kind,
		CharacterID: row.CharacterID.Int64,
		ExpiresAt:   row.ExpiresAt.Time,
	}, nil
}

// PlayCharacter loads character id of account accountID (ErrNotFound if it is not theirs
// or the account is banned at now) and records the login time.
func (s *Store) PlayCharacter(ctx context.Context, accountID, id int64, now time.Time) (PlayCharacter, error) {
	row, err := s.q.GetCharacterForPlay(ctx, db.GetCharacterForPlayParams{ID: id, AccountID: accountID, Now: ts(now)})
	if err != nil {
		return PlayCharacter{}, fmt.Errorf("play character: %w", notFound(err))
	}
	if err := s.q.TouchCharacterLogin(ctx, db.TouchCharacterLoginParams{ID: id, At: ts(now)}); err != nil {
		return PlayCharacter{}, fmt.Errorf("touch character login: %w", err)
	}
	rows, err := s.q.GetCharacterSkills(ctx, id)
	if err != nil {
		return PlayCharacter{}, fmt.Errorf("character skills: %w", err)
	}
	skills := make([]Skill, len(rows))
	for i, r := range rows {
		skills[i] = Skill{ID: r.Skill, Level: int(r.Level), Tries: r.Tries}
	}
	inv, err := s.q.GetCharacterInventory(ctx, id)
	if err != nil {
		return PlayCharacter{}, fmt.Errorf("character inventory: %w", err)
	}
	qs, err := s.q.GetCharacterQuestState(ctx, id)
	if err != nil {
		return PlayCharacter{}, fmt.Errorf("character quest state: %w", err)
	}
	storage := make(map[string]int64, len(qs))
	for _, r := range qs {
		storage[r.Key] = r.Value
	}
	var conds []Condition
	if err := json.Unmarshal(row.Conditions, &conds); err != nil {
		return PlayCharacter{}, fmt.Errorf("character conditions: %w", err)
	}
	unjust, err := s.q.GetCharacterUnjustKills(ctx, db.GetCharacterUnjustKillsParams{CharacterID: id,
		Since: ts(now.Add(-unjustKillsHorizon))})
	if err != nil {
		return PlayCharacter{}, fmt.Errorf("character unjust kills: %w", err)
	}
	pvp := PvPState{Skull: int(row.Skull), Kills: int(row.PvpKills), Unjust: make([]time.Time, len(unjust))}
	if row.SkullUntil.Valid {
		pvp.SkullUntil = row.SkullUntil.Time
	}
	for i, k := range unjust {
		pvp.Unjust[i] = k.Time
	}
	return PlayCharacter{
		PvP:        pvp,
		Conditions: conds,
		Storage:    storage,
		Inventory:  inventoryTree(inv),
		Skills:     skills,
		ID:         row.ID,
		AccountID:  row.AccountID,
		Name:       row.Name,
		Vocation:   row.Vocation,
		Level:      int(row.Level),
		Experience: row.Experience,
		Health:     int(row.Health),
		Mana:       int(row.Mana),
		HasPos:     row.PosX.Valid,
		X:          int(row.PosX.Int32),
		Y:          int(row.PosY.Int32),
		Z:          int(row.PosZ.Int16),
		Town:       row.Town,
		Role:       row.Role,
	}, nil
}

// SaveCharacterState writes a snapshot of the character. ErrNotFound means the
// character no longer exists (deleted while online); there is nothing to retry.
func (s *Store) SaveCharacterState(ctx context.Context, c CharacterState) error {
	return s.inTx(ctx, func(q *db.Queries) error { return saveCharacterState(ctx, q, c) })
}

func saveCharacterState(ctx context.Context, q *db.Queries, c CharacterState) error {
	conds := c.Conditions
	if conds == nil {
		conds = []Condition{}
	}
	rawConds, err := json.Marshal(conds)
	if err != nil {
		return fmt.Errorf("encode conditions of character %d: %w", c.ID, err)
	}
	n, err := q.SaveCharacterState(ctx, db.SaveCharacterStateParams{
		Conditions: rawConds,
		ID:         c.ID,
		Level:      int32(c.Level),
		Experience: c.Experience,
		Health:     int32(c.Health),
		Mana:       int32(c.Mana),
		PosX:       pgtype.Int4{Int32: int32(c.X), Valid: true},
		PosY:       pgtype.Int4{Int32: int32(c.Y), Valid: true},
		PosZ:       pgtype.Int2{Int16: int16(c.Z), Valid: true},
		Skull:      int16(c.PvP.Skull),
		SkullUntil: tsOrNull(c.PvP.SkullUntil),
		PvpKills:   int32(c.PvP.Kills),
		SavedAt:    ts(c.SavedAt),
	})
	if err != nil {
		return fmt.Errorf("save character %d: %w", c.ID, err)
	}
	if n == 0 {
		return fmt.Errorf("save character %d: %w", c.ID, ErrNotFound)
	}
	if err := q.DeleteCharacterInventory(ctx, c.ID); err != nil {
		return fmt.Errorf("clear inventory of character %d: %w", c.ID, err)
	}
	if err := insertItems(ctx, q, c.ID, pgtype.Int8{}, c.Inventory); err != nil {
		return fmt.Errorf("save inventory of character %d: %w", c.ID, err)
	}
	if err := q.DeleteCharacterQuestState(ctx, c.ID); err != nil {
		return fmt.Errorf("clear quest state of character %d: %w", c.ID, err)
	}
	if len(c.Storage) > 0 {
		qp := db.SaveCharacterQuestStateParams{CharacterID: c.ID}
		for _, k := range slices.Sorted(maps.Keys(c.Storage)) {
			qp.Keys = append(qp.Keys, k)
			qp.Vals = append(qp.Vals, c.Storage[k])
		}
		if err := q.SaveCharacterQuestState(ctx, qp); err != nil {
			return fmt.Errorf("save quest state of character %d: %w", c.ID, err)
		}
	}
	if err := q.DeleteCharacterUnjustKills(ctx, c.ID); err != nil {
		return fmt.Errorf("clear unjust kills of character %d: %w", c.ID, err)
	}
	if len(c.PvP.Unjust) > 0 {
		kp := db.SaveCharacterUnjustKillsParams{CharacterID: c.ID, KilledAt: make([]pgtype.Timestamptz, len(c.PvP.Unjust))}
		for i, t := range c.PvP.Unjust {
			kp.KilledAt[i] = ts(t)
		}
		if err := q.SaveCharacterUnjustKills(ctx, kp); err != nil {
			return fmt.Errorf("save unjust kills of character %d: %w", c.ID, err)
		}
	}
	if len(c.Skills) == 0 {
		return nil
	}
	p := db.SaveCharacterSkillsParams{CharacterID: c.ID, Skills: make([]string, len(c.Skills)),
		Levels: make([]int32, len(c.Skills)), Tries: make([]int64, len(c.Skills))}
	for i, sk := range c.Skills {
		p.Skills[i], p.Levels[i], p.Tries[i] = sk.ID, int32(sk.Level), sk.Tries
	}
	if err := q.SaveCharacterSkills(ctx, p); err != nil {
		return fmt.Errorf("save skills of character %d: %w", c.ID, err)
	}
	return nil
}

// insertItems inserts items (and, depth first, their content) inside container.
func insertItems(ctx context.Context, q *db.Queries, charID int64, container pgtype.Int8, items []InventoryItem) error {
	for _, it := range items {
		id, err := q.InsertInventoryItem(ctx, db.InsertInventoryItemParams{CharacterID: charID, ContainerID: container,
			Slot: int16(it.Slot), ItemID: int32(it.ItemID), Count: int32(it.Count)})
		if err != nil {
			return err
		}
		if err := insertItems(ctx, q, charID, pgtype.Int8{Int64: id, Valid: true}, it.Items); err != nil {
			return err
		}
	}
	return nil
}

// inventoryTree rebuilds the item tree from inventory_items rows (top level first,
// then by slot). Rows whose container is missing are dropped.
func inventoryTree(rows []db.GetCharacterInventoryRow) []InventoryItem {
	children := map[int64][]db.GetCharacterInventoryRow{}
	var top []db.GetCharacterInventoryRow
	for _, r := range rows {
		if r.ContainerID.Valid {
			children[r.ContainerID.Int64] = append(children[r.ContainerID.Int64], r)
		} else {
			top = append(top, r)
		}
	}
	var build func(rs []db.GetCharacterInventoryRow, depth int) []InventoryItem
	build = func(rs []db.GetCharacterInventoryRow, depth int) []InventoryItem {
		if depth > 64 || len(rs) == 0 {
			return nil
		}
		out := make([]InventoryItem, len(rs))
		for i, r := range rs {
			out[i] = InventoryItem{ItemID: int(r.ItemID), Count: int(r.Count), Slot: int(r.Slot), Items: build(children[r.ID], depth+1)}
		}
		return out
	}
	return build(top, 0)
}

// tsOrNull is ts, or NULL for the zero time.
func tsOrNull(t time.Time) pgtype.Timestamptz {
	if t.IsZero() {
		return pgtype.Timestamptz{}
	}
	return ts(t)
}
