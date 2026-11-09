package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// Player houses (T5.4, docs/01 "Persistencia"). The game loop owns the houses: LoadHouses
// reads owners, guests and items once at start, and SaveTransfer writes each change the
// loop decided (HouseOps) with the snapshots of the characters it touched, in ONE
// transaction, from the persistence goroutine.

// ErrHouseConflict reports a house change the database cannot apply (an owner that is
// not the one the loop believes). The whole transfer is rolled back: permanent.
var ErrHouseConflict = errors.New("store: house change conflicts with the database")

// HouseOpKind is the kind of a HouseOp (same values as session.HouseOpKind).
type HouseOpKind uint8

// House changes.
const (
	HouseOwnerAdd HouseOpKind = iota + 1
	HouseOwnerChange
	HouseOwnerRemove
	HousePaid
	HouseAccess
	HouseItems
)

// HouseOwner is a row of house_owners (Name: the character's, on load).
type HouseOwner struct {
	HouseID                string
	CharacterID, AccountID int64
	Name                   string
	PaidUntil, Since       time.Time
	GuildAccess            bool
}

// HouseItem is a row of house_items: Item is the instance (InventoryItem).
type HouseItem struct {
	HouseID string
	X, Y, Z int
	Seq     int
	Item    InventoryItem
}

// HouseOp is one house change of a Transfer.
type HouseOp struct {
	Kind        HouseOpKind
	House       string
	CharacterID int64
	Owner       HouseOwner
	PaidUntil   time.Time
	GuildAccess bool
	Guests      []string
	Items       []HouseItem
}

// HouseData is every house row as loaded at start.
type HouseData struct {
	Owners []HouseOwner
	Guests map[string][]string
	Items  []HouseItem
}

// PublicHouseOwner is a rented house on /api/houses; Name is empty when the owner may not
// be shown (staff, disabled or banned account).
type PublicHouseOwner struct {
	HouseID, Name string
}

func applyHouseOp(ctx context.Context, q *db.Queries, op HouseOp) error {
	guarded := func(n int64, err error) error {
		if err == nil && n == 0 {
			return ErrHouseConflict
		}
		return err
	}
	switch op.Kind {
	case HouseOwnerAdd:
		o := op.Owner
		return q.InsertHouseOwner(ctx, db.InsertHouseOwnerParams{HouseID: op.House, CharacterID: o.CharacterID,
			AccountID: o.AccountID, PaidUntil: ts(o.PaidUntil), Since: ts(o.Since), GuildAccess: o.GuildAccess})
	case HouseOwnerChange:
		o := op.Owner
		if err := guarded(q.ChangeHouseOwner(ctx, db.ChangeHouseOwnerParams{ToCharacter: o.CharacterID,
			ToAccount: o.AccountID, PaidUntil: ts(o.PaidUntil), Since: ts(o.Since), HouseID: op.House,
			FromCharacter: op.CharacterID})); err != nil {
			return err
		}
		return q.DeleteHouseGuests(ctx, op.House)
	case HouseOwnerRemove:
		return guarded(q.DeleteHouseOwner(ctx, db.DeleteHouseOwnerParams{HouseID: op.House, CharacterID: op.CharacterID}))
	case HousePaid:
		return guarded(q.SetHousePaid(ctx, db.SetHousePaidParams{HouseID: op.House, CharacterID: op.CharacterID,
			PaidUntil: ts(op.PaidUntil)}))
	case HouseAccess:
		if err := guarded(q.SetHouseGuildAccess(ctx, db.SetHouseGuildAccessParams{HouseID: op.House,
			CharacterID: op.CharacterID, GuildAccess: op.GuildAccess})); err != nil {
			return err
		}
		if err := q.DeleteHouseGuests(ctx, op.House); err != nil {
			return err
		}
		for _, g := range op.Guests {
			if err := q.InsertHouseGuest(ctx, db.InsertHouseGuestParams{HouseID: op.House, Name: g}); err != nil {
				return err
			}
		}
		return nil
	case HouseItems:
		if err := q.DeleteHouseItems(ctx, op.House); err != nil {
			return err
		}
		if len(op.Items) == 0 {
			return nil
		}
		rows := make([]db.InsertHouseItemsParams, 0, len(op.Items))
		for _, it := range op.Items {
			raw, err := json.Marshal(it.Item)
			if err != nil {
				return err
			}
			rows = append(rows, db.InsertHouseItemsParams{HouseID: op.House, X: int32(it.X), Y: int32(it.Y),
				Z: int16(it.Z), Seq: int16(it.Seq), ItemID: int32(it.Item.ItemID), Item: raw})
		}
		_, err := q.InsertHouseItems(ctx, rows)
		return err
	}
	return fmt.Errorf("unknown house change %d: %w", op.Kind, ErrHouseConflict)
}

// LoadHouses reads every owner, guest and house item.
func (s *Store) LoadHouses(ctx context.Context) (HouseData, error) {
	d := HouseData{Guests: map[string][]string{}}
	err := s.inTx(ctx, func(q *db.Queries) error {
		owners, err := q.LoadHouseOwners(ctx)
		if err != nil {
			return fmt.Errorf("house owners: %w", err)
		}
		for _, o := range owners {
			d.Owners = append(d.Owners, HouseOwner{HouseID: o.HouseID, CharacterID: o.CharacterID,
				AccountID: o.AccountID, Name: o.Name, PaidUntil: o.PaidUntil.Time, Since: o.Since.Time,
				GuildAccess: o.GuildAccess})
		}
		guests, err := q.LoadHouseGuests(ctx)
		if err != nil {
			return fmt.Errorf("house guests: %w", err)
		}
		for _, g := range guests {
			d.Guests[g.HouseID] = append(d.Guests[g.HouseID], g.Name)
		}
		items, err := q.LoadHouseItems(ctx)
		if err != nil {
			return fmt.Errorf("house items: %w", err)
		}
		for _, it := range items {
			var inst InventoryItem
			if err := json.Unmarshal(it.Item, &inst); err != nil {
				return fmt.Errorf("house %s item %d,%d,%d: %w", it.HouseID, it.X, it.Y, it.Z, err)
			}
			d.Items = append(d.Items, HouseItem{HouseID: it.HouseID, X: int(it.X), Y: int(it.Y), Z: int(it.Z),
				Seq: int(it.Seq), Item: inst})
		}
		return nil
	})
	return d, err
}

// PublicHouses returns the rented houses for /api/houses; the owner's name is left out
// for staff, disabled and banned accounts (like the highscores).
func (s *Store) PublicHouses(ctx context.Context, now time.Time) ([]PublicHouseOwner, error) {
	rows, err := s.q.PublicHouses(ctx, ts(now))
	if err != nil {
		return nil, fmt.Errorf("public houses: %w", err)
	}
	out := make([]PublicHouseOwner, 0, len(rows))
	for _, r := range rows {
		o := PublicHouseOwner{HouseID: r.HouseID}
		if r.Visible {
			o.Name = r.Name
		}
		out = append(out, o)
	}
	return out, nil
}
