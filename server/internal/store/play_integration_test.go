//go:build integration

package store_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

func TestPlayTokensAndCharacterState(t *testing.T) {
	ctx := context.Background()
	st := storetest.Open(t, "it_store_play", true)
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	acc, _ := st.CreateAccount(ctx, "ana@example.org", "$argon2id$x")
	other, _ := st.CreateAccount(ctx, "bob@example.org", "$argon2id$x")
	c, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: acc, Name: "Mira", Vocation: "guardian", Health: 145, Mana: 20}, 10)
	if err != nil {
		t.Fatal(err)
	}

	if ok, _ := st.CharacterBelongsTo(ctx, acc, c.ID); !ok {
		t.Fatal("own character not found")
	}
	if ok, _ := st.CharacterBelongsTo(ctx, other, c.ID); ok {
		t.Fatal("other account owns the character")
	}

	// A play token is consumed exactly once, and only before it expires.
	sess := store.Session{TokenHash: hash("play"), AccountID: acc, Kind: store.SessionPlay, CharacterID: c.ID, CreatedAt: now, ExpiresAt: now.Add(time.Minute)}
	if err := st.CreateSession(ctx, sess); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ConsumeSession(ctx, hash("play"), store.SessionAccount, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("wrong kind: %v", err)
	}
	got, err := st.ConsumeSession(ctx, hash("play"), store.SessionPlay, now)
	if err != nil || got.AccountID != acc || got.CharacterID != c.ID {
		t.Fatalf("consume = %+v, %v", got, err)
	}
	if _, err := st.ConsumeSession(ctx, hash("play"), store.SessionPlay, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second consume: %v", err)
	}
	sess.TokenHash = hash("late")
	_ = st.CreateSession(ctx, sess)
	if _, err := st.ConsumeSession(ctx, hash("late"), store.SessionPlay, now.Add(time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired consume: %v", err)
	}
	// The schema refuses a play token for another account's character.
	bad := store.Session{TokenHash: hash("bad"), AccountID: other, Kind: store.SessionPlay, CharacterID: c.ID, CreatedAt: now, ExpiresAt: now.Add(time.Minute)}
	if err := st.CreateSession(ctx, bad); err == nil {
		t.Fatal("play token for another account's character accepted")
	}

	// New characters have no position; a save sets it.
	pc, err := st.PlayCharacter(ctx, acc, c.ID, now)
	if err != nil || pc.HasPos || pc.Name != "Mira" || pc.Health != 145 || pc.Level != 1 {
		t.Fatalf("play character = %+v, %v", pc, err)
	}
	if _, err := st.PlayCharacter(ctx, other, c.ID, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("other account loads it: %v", err)
	}
	state := store.CharacterState{ID: c.ID, Level: 2, Experience: 30, Health: 100, Mana: 5, X: 1056, Y: 1057, Z: 7, SavedAt: now}
	if err := st.SaveCharacterState(ctx, state); err != nil {
		t.Fatal(err)
	}
	pc, _ = st.PlayCharacter(ctx, acc, c.ID, now)
	if !pc.HasPos || pc.X != 1056 || pc.Y != 1057 || pc.Z != 7 || pc.Level != 2 || pc.Experience != 30 || pc.Health != 100 || pc.Mana != 5 {
		t.Fatalf("after save %+v", pc)
	}
	if len(pc.Skills) != 0 {
		t.Fatalf("skills before any skill save: %+v", pc.Skills)
	}

	// Skills are upserted with the state: inserted the first time, updated after.
	state.Skills = []store.Skill{{ID: "fist", Level: 11, Tries: 7}, {ID: "shield", Level: 10, Tries: 3}}
	if err := st.SaveCharacterState(ctx, state); err != nil {
		t.Fatal(err)
	}
	state.Skills = []store.Skill{{ID: "fist", Level: 12, Tries: 0}, {ID: "shield", Level: 10, Tries: 9}}
	if err := st.SaveCharacterState(ctx, state); err != nil {
		t.Fatal(err)
	}
	pc, _ = st.PlayCharacter(ctx, acc, c.ID, now)
	if len(pc.Skills) != 2 || pc.Skills[0] != (store.Skill{ID: "fist", Level: 12}) || pc.Skills[1] != (store.Skill{ID: "shield", Level: 10, Tries: 9}) {
		t.Fatalf("skills after save: %+v", pc.Skills)
	}
	// The inventory tree is replaced by every save, nested containers included.
	bag := store.InventoryItem{ItemID: 7, Count: 1, Slot: 1, Items: []store.InventoryItem{{ItemID: 8, Count: 30, Slot: 0}}}
	state.Inventory = []store.InventoryItem{
		{ItemID: 5, Count: 1, Slot: 3, Items: []store.InventoryItem{{ItemID: 8, Count: 12, Slot: 0}, bag}},
		{ItemID: 6, Count: 1, Slot: 5},
	}
	for range 2 {
		if err := st.SaveCharacterState(ctx, state); err != nil {
			t.Fatal(err)
		}
	}
	pc, _ = st.PlayCharacter(ctx, acc, c.ID, now)
	if !reflect.DeepEqual(pc.Inventory, state.Inventory) {
		t.Fatalf("inventory after save:\n got %+v\nwant %+v", pc.Inventory, state.Inventory)
	}
	state.Inventory = nil
	if err := st.SaveCharacterState(ctx, state); err != nil {
		t.Fatal(err)
	}
	if pc, _ = st.PlayCharacter(ctx, acc, c.ID, now); len(pc.Inventory) != 0 {
		t.Fatalf("inventory after emptying: %+v", pc.Inventory)
	}
	// Storage values (quest_state) are replaced by every save too.
	state.Storage = map[string]int64{"quest.ch1_shipwreck": 1, "quest.ch1_shipwreck.step": 2, "flag.x": -3}
	for range 2 {
		if err := st.SaveCharacterState(ctx, state); err != nil {
			t.Fatal(err)
		}
	}
	if pc, _ = st.PlayCharacter(ctx, acc, c.ID, now); !reflect.DeepEqual(pc.Storage, state.Storage) {
		t.Fatalf("storage after save: %v", pc.Storage)
	}
	state.Storage = map[string]int64{"quest.ch1_shipwreck": 2}
	if err := st.SaveCharacterState(ctx, state); err != nil {
		t.Fatal(err)
	}
	if pc, _ = st.PlayCharacter(ctx, acc, c.ID, now); !reflect.DeepEqual(pc.Storage, state.Storage) {
		t.Fatalf("storage after replacing: %v", pc.Storage)
	}
	// Conditions (T3.2) are replaced by every save; none is an empty list.
	if len(pc.Conditions) != 0 {
		t.Fatalf("conditions before any: %+v", pc.Conditions)
	}
	state.Conditions = []store.Condition{{ID: "poison", LeftMs: 1200, Ticks: 4, Damage: 3}, {ID: "slowed", LeftMs: 5000}}
	if err := st.SaveCharacterState(ctx, state); err != nil {
		t.Fatal(err)
	}
	if pc, _ = st.PlayCharacter(ctx, acc, c.ID, now); !reflect.DeepEqual(pc.Conditions, state.Conditions) {
		t.Fatalf("conditions after save: %+v", pc.Conditions)
	}
	state.Conditions = nil
	if err := st.SaveCharacterState(ctx, state); err != nil {
		t.Fatal(err)
	}
	if pc, _ = st.PlayCharacter(ctx, acc, c.ID, now); len(pc.Conditions) != 0 {
		t.Fatalf("conditions after clearing: %+v", pc.Conditions)
	}
	state.ID = 999999
	if err := st.SaveCharacterState(ctx, state); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("save of a missing character: %v", err)
	}
}
