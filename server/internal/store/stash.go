package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// Account stash (docs/02 "Baúl de la cuenta", migration 00025). The game loop owns the
// stash of an account while a character of it is online: PlayCharacter reads it with the
// character, and SaveTransfer writes each change (StashOp) with the snapshot of the
// character whose inventory it changed, in ONE transaction.

// StashOp replaces every account_stash_items row of AccountID with Items (cell i is
// Items[i]; Slot is ignored).
type StashOp struct {
	AccountID int64
	Items     []InventoryItem
}

// loadStash reads the stash of accountID, cells in order. A row whose item does not decode
// (only a hand edit of the database writes one) fails the login: dropping it would lose it
// at the next write of the stash.
func loadStash(ctx context.Context, q *db.Queries, accountID int64) ([]InventoryItem, error) {
	rows, err := q.LoadAccountStash(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("account stash: %w", err)
	}
	out := make([]InventoryItem, 0, len(rows))
	for _, r := range rows {
		var it InventoryItem
		if err := json.Unmarshal(r.Item, &it); err != nil {
			return nil, fmt.Errorf("account %d stash cell %d: %w", accountID, r.Slot, err)
		}
		it.Slot = int(r.Slot)
		out = append(out, it)
	}
	return out, nil
}

// applyStashOp writes op inside a transfer's transaction: one DELETE and one INSERT of
// every cell, whatever the size of the stash.
func applyStashOp(ctx context.Context, q *db.Queries, op StashOp) error {
	if err := q.DeleteAccountStash(ctx, op.AccountID); err != nil {
		return fmt.Errorf("clear stash of account %d: %w", op.AccountID, err)
	}
	if len(op.Items) == 0 {
		return nil
	}
	p := db.InsertAccountStashItemsParams{AccountID: op.AccountID,
		Slots: make([]int16, len(op.Items)), ItemIds: make([]int32, len(op.Items)),
		Items: make([][]byte, len(op.Items))}
	for i, it := range op.Items {
		it.Slot = 0 // the cell is the row's slot
		raw, err := json.Marshal(it)
		if err != nil {
			return fmt.Errorf("encode stash cell %d of account %d: %w", i, op.AccountID, err)
		}
		p.Slots[i], p.ItemIds[i], p.Items[i] = int16(i), int32(it.ItemID), raw
	}
	if err := q.InsertAccountStashItems(ctx, p); err != nil {
		return fmt.Errorf("save stash of account %d: %w", op.AccountID, err)
	}
	return nil
}
