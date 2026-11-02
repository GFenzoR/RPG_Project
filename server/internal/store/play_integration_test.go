//go:build integration

package store_test

import (
	"context"
	"errors"
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
	state.ID = 999999
	if err := st.SaveCharacterState(ctx, state); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("save of a missing character: %v", err)
	}
}
