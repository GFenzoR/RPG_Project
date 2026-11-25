package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
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
	// Explored is the minimap's explored sectors (character_explored, migration 00028):
	// every saved one.
	Explored []ExploredSector
	// Conditions are the saved conditions (characters.conditions, T3.2).
	Conditions []Condition
	// PvP is the character's skull, kill counter and recent unjustified kills (T5.2).
	PvP PvPState
	// Cosmetics are the equipped cosmetics and the account's shop state (T5.7).
	Cosmetics Cosmetics
	Owned     []string
	Premium   int64
	// PremiumSeq is the id of the account's newest premium_ledger row (0 = none).
	PremiumSeq int64
	// Look is the character's body (characters.look_*); empty fields for a character
	// created before looks existed (the game picks one from its id).
	Look Look
	// Stash is the account's stash (account_stash_items, docs/02 "Baúl de la cuenta"),
	// cells in order (Slot: the cell). The game uses it only when no character of the
	// account is in the world already (it owns the stash then).
	Stash []InventoryItem
}

// Look is the body of a character (characters.look_*, migrations 00021 and 00022): ids of
// data/looks.yaml, "" = none yet. Values are already validated when they are written.
type Look struct {
	Sex, Body, Skin, Hair, HairColor, Beard string
}

// Cosmetics are the equipped cosmetics of a character (characters.outfit, outfit_color,
// name_effect; content ids of data/cosmetics.yaml, "" = default look).
type Cosmetics struct {
	Outfit, Color, NameEffect string
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
// T5.2: Author is the character of the player that applied it (0: a monster or the
// world), AuthorHit when that player last hurt this character outside an arena,
// AuthorUnjust whether any of those hits was unjustified (zero: nothing remembered) and
// SavedAt when the game saved a condition with an Author (its time runs on while the
// character is away). The fields are optional in the JSON, so rows saved before them read
// as zero.
type Condition struct {
	ID           string    `json:"id"`
	LeftMs       int       `json:"left_ms"`
	Ticks        int       `json:"ticks,omitempty"`
	Damage       int       `json:"damage,omitempty"`
	Author       int64     `json:"author,omitempty"`
	AuthorHit    time.Time `json:"author_hit,omitzero"`
	AuthorUnjust bool      `json:"author_unjust,omitempty"`
	SavedAt      time.Time `json:"saved_at,omitzero"`
}

// InventoryItem is one row of inventory_items with the rows inside it: Slot is the
// equipment slot of a top-level item (its cell for one in the pockets, Pocket: migration
// 00020, docs/02 "Bolsillos") and the index inside its container otherwise. Mods is the
// instance's own data (inventory_items.attributes; nil: a plain item). A saved instance
// (market_mail_items.item, house_items.item) is never in the pockets.
type InventoryItem struct {
	ItemID int             `json:"item_id"`
	Count  int             `json:"count"`
	Slot   int             `json:"slot,omitempty"`
	Mods   *ItemMods       `json:"mods,omitempty"`
	Items  []InventoryItem `json:"items,omitempty"`
	Pocket bool            `json:"pocket,omitempty"`
}

// ItemMods is an item instance's own data (docs/02 "Atributos de items", docs/05
// ItemMods): its attribute (an id of data/attributes.yaml) with its value, and its refine
// level. Saved as a JSON object in inventory_items.attributes and market_offers.attributes
// ('{}' for a plain item, migration 00019) and as "mods" inside a saved instance
// (market_mail_items.item, house_items.item).
type ItemMods struct {
	Attribute string `json:"attribute,omitempty"`
	Value     int    `json:"value,omitempty"`
	Refine    int    `json:"refine,omitempty"`
}

// modsJSON is m as its column value: '{}' for nil or a zero m.
func modsJSON(m *ItemMods) []byte {
	if m == nil || *m == (ItemMods{}) {
		return []byte("{}")
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return []byte("{}") // unreachable: three plain fields
	}
	return raw
}

// readMods reads the attributes column of row id of table (modsOf). A value that does
// not decode (only a hand edit of the database writes one) must not keep a character
// from playing nor the market from loading: it is logged and read as a plain item, so an
// equipable rolls a new attribute when it loads and is saved with it.
func readMods(raw []byte, table string, id int64) *ItemMods {
	m, err := modsOf(raw)
	if err != nil {
		slog.Error("store: unreadable item attributes read as none", "table", table, "id", id, "err", err)
		return nil
	}
	return m
}

// modsOf reads a column written by modsJSON (nil: a plain item).
func modsOf(raw []byte) (*ItemMods, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var m ItemMods
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("item attributes: %w", err)
	}
	if m == (ItemMods{}) {
		return nil, nil
	}
	return &m, nil
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
	// Explored is the minimap's explored sectors (character_explored, migration 00028):
	// the ones to upsert (those that gained bits during the login).
	Explored []ExploredSector
	// Conditions replace the saved ones (T3.2).
	Conditions []Condition
	// PvP replaces the skull, the kill counter and every pvp_unjust_kills row (T5.2).
	PvP PvPState
	// Cosmetics are the equipped cosmetics (T5.7).
	Cosmetics Cosmetics
	// Look is the character's body (docs/02 "Apariencia").
	Look    Look
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
	tree := inventoryTree(inv)
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
	owned, err := s.q.ListAccountCosmetics(ctx, accountID)
	if err != nil {
		return PlayCharacter{}, fmt.Errorf("account cosmetics: %w", err)
	}
	stash, err := loadStash(ctx, s.q, accountID)
	if err != nil {
		return PlayCharacter{}, err
	}
	explored, err := s.q.GetCharacterExplored(ctx, id)
	if err != nil {
		return PlayCharacter{}, fmt.Errorf("character explored: %w", err)
	}
	return PlayCharacter{
		Explored:  exploredSectors(explored),
		Stash:     stash,
		Cosmetics: Cosmetics{Outfit: row.Outfit, Color: row.OutfitColor, NameEffect: row.NameEffect},
		Look: Look{Sex: row.LookSex, Body: row.LookBody, Skin: row.LookSkin, Hair: row.LookHair, HairColor: row.LookHairColor,
			Beard: row.LookBeard},
		Owned:      owned,
		Premium:    row.PremiumBalance,
		PremiumSeq: row.PremiumSeq,
		PvP:        pvp,
		Conditions: conds,
		Storage:    storage,
		Inventory:  tree,
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
		Conditions:    rawConds,
		ID:            c.ID,
		Level:         int32(c.Level),
		Experience:    c.Experience,
		Health:        int32(c.Health),
		Mana:          int32(c.Mana),
		PosX:          pgtype.Int4{Int32: int32(c.X), Valid: true},
		PosY:          pgtype.Int4{Int32: int32(c.Y), Valid: true},
		PosZ:          pgtype.Int2{Int16: int16(c.Z), Valid: true},
		Skull:         int16(c.PvP.Skull),
		SkullUntil:    tsOrNull(c.PvP.SkullUntil),
		PvpKills:      int32(c.PvP.Kills),
		Outfit:        c.Cosmetics.Outfit,
		OutfitColor:   c.Cosmetics.Color,
		NameEffect:    c.Cosmetics.NameEffect,
		LookBody:      c.Look.Body,
		LookSkin:      c.Look.Skin,
		LookHair:      c.Look.Hair,
		LookHairColor: c.Look.HairColor,
		LookBeard:     c.Look.Beard,
		LookSex:       c.Look.Sex,
		SavedAt:       ts(c.SavedAt),
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
	if err := saveExplored(ctx, q, c.ID, c.Explored); err != nil {
		return err
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

// insertItems inserts items (and, depth first, their content) inside container. Pocket
// counts only at the top level (the schema allows no pocket row inside a container).
func insertItems(ctx context.Context, q *db.Queries, charID int64, container pgtype.Int8, items []InventoryItem) error {
	for _, it := range items {
		id, err := q.InsertInventoryItem(ctx, db.InsertInventoryItemParams{CharacterID: charID, ContainerID: container,
			Slot: int16(it.Slot), ItemID: int32(it.ItemID), Count: int32(it.Count), Attributes: modsJSON(it.Mods),
			Pocket: it.Pocket && !container.Valid})
		if err != nil {
			return err
		}
		if err := insertItems(ctx, q, charID, pgtype.Int8{Int64: id, Valid: true}, it.Items); err != nil {
			return err
		}
	}
	return nil
}

// inventoryTree rebuilds the item tree from inventory_items rows (top level first, the
// equipment before the pockets, then by slot), with each row's attributes. Rows whose
// container is missing are dropped.
func inventoryTree(rows []db.GetCharacterInventoryRow) []InventoryItem {
	mods := make(map[int64]*ItemMods, len(rows))
	for _, r := range rows {
		mods[r.ID] = readMods(r.Attributes, "inventory_items", r.ID)
	}
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
			out[i] = InventoryItem{ItemID: int(r.ItemID), Count: int(r.Count), Slot: int(r.Slot), Mods: mods[r.ID],
				Items: build(children[r.ID], depth+1), Pocket: r.Pocket && !r.ContainerID.Valid}
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

// ExploredSector is one sector of the minimap's fog (server/internal/explore): floor Z,
// sector column SX and row SY (tile / 32) and its 128-byte bitset.
type ExploredSector struct {
	Z, SX, SY int
	Bits      []byte
}

// exploredBytes is the size of a sector's bitset (the table's CHECK).
const exploredBytes = 128

func exploredSectors(rows []db.GetCharacterExploredRow) []ExploredSector {
	out := make([]ExploredSector, 0, len(rows))
	for _, r := range rows {
		if len(r.Bits) != exploredBytes {
			continue
		}
		out = append(out, ExploredSector{Z: int(r.Z), SX: int(r.Sx), SY: int(r.Sy), Bits: r.Bits})
	}
	return out
}

// saveExplored upserts a snapshot's explored sectors (never deletes: bits only grow).
func saveExplored(ctx context.Context, q *db.Queries, charID int64, in []ExploredSector) error {
	if len(in) == 0 {
		return nil
	}
	p := db.SaveCharacterExploredParams{CharacterID: charID, Zs: make([]int16, 0, len(in)),
		Sxs: make([]int16, 0, len(in)), Sys: make([]int16, 0, len(in)), Bits: make([][]byte, 0, len(in))}
	for _, e := range in {
		if len(e.Bits) != exploredBytes || e.Z < 0 || e.Z > 15 || e.SX < 0 || e.SX > 4095 || e.SY < 0 || e.SY > 4095 {
			continue
		}
		p.Zs, p.Sxs, p.Sys, p.Bits = append(p.Zs, int16(e.Z)), append(p.Sxs, int16(e.SX)), append(p.Sys, int16(e.SY)), append(p.Bits, e.Bits)
	}
	if len(p.Zs) == 0 {
		return nil
	}
	if err := q.SaveCharacterExplored(ctx, p); err != nil {
		return fmt.Errorf("save explored sectors of character %d: %w", charID, err)
	}
	return nil
}
