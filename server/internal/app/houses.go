package app

import (
	"context"
	"fmt"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// HouseStore is the persistence of the player houses (T5.4). *store.Store implements it;
// the changes are written with the transfers (MarketStore.SaveTransfer).
type HouseStore interface {
	LoadHouses(ctx context.Context) (store.HouseData, error)
}

var _ HouseStore = (*store.Store)(nil)

// houseLoadTimeout bounds the read of the houses at start.
const houseLoadTimeout = 30 * time.Second

func loadHouses(hs HouseStore) (*session.HouseData, error) {
	ctx, cancel := context.WithTimeout(context.Background(), houseLoadTimeout)
	defer cancel()
	d, err := hs.LoadHouses(ctx)
	if err != nil {
		return nil, fmt.Errorf("load houses: %w", err)
	}
	out := &session.HouseData{Guests: d.Guests}
	for _, o := range d.Owners {
		out.Owners = append(out.Owners, session.HouseOwner{HouseID: o.HouseID, CharacterID: o.CharacterID,
			AccountID: o.AccountID, Name: o.Name, PaidUntil: o.PaidUntil, Since: o.Since, GuildAccess: o.GuildAccess})
	}
	for _, it := range d.Items {
		out.Items = append(out.Items, session.HouseItem{HouseID: it.HouseID,
			Pos: world.Pos{X: uint16(it.X), Y: uint16(it.Y), Z: uint8(it.Z)}, Seq: it.Seq, Item: sessionItem(it.Item)})
	}
	return out, nil
}

func storeHouseOp(op session.HouseOp) store.HouseOp {
	o := op.Owner
	out := store.HouseOp{Kind: store.HouseOpKind(op.Kind), House: op.House, CharacterID: op.CharacterID,
		PaidUntil: op.PaidUntil, GuildAccess: op.GuildAccess, Guests: op.Guests,
		Owner: store.HouseOwner{HouseID: o.HouseID, CharacterID: o.CharacterID, AccountID: o.AccountID, Name: o.Name,
			PaidUntil: o.PaidUntil, Since: o.Since, GuildAccess: o.GuildAccess}}
	for _, it := range op.Items {
		items := storeItems([]session.ItemState{it.Item})
		out.Items = append(out.Items, store.HouseItem{HouseID: it.HouseID, X: int(it.Pos.X), Y: int(it.Pos.Y),
			Z: int(it.Pos.Z), Seq: it.Seq, Item: items[0]})
	}
	return out
}
