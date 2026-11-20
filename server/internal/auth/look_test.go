package auth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// A new character's look (docs/02 "Apariencia"): a player's choice of data/looks.yaml is
// stored, anything else is refused, and none leaves it to the game (picked from the id).
func TestCreateCharacterLook(t *testing.T) {
	ctx := context.Background()
	looks, err := content.LoadLooks("../../../data")
	if err != nil || looks == nil {
		t.Fatalf("looks: %v", err)
	}
	repo := authtest.NewRepo()
	svc, err := auth.New(auth.Config{
		Repo: repo, Clock: clock.NewFake(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)),
		Vocations: testVocations, Looks: looks, MaxCharacters: 5,
		Hash: auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	acc, _ := svc.Register(ctx, "look@example.org", "secreto123")

	chosen := content.Look{Body: "slender", Skin: "deep", Hair: "curly", HairColor: "white", Beard: "none"}
	c, err := svc.CreateCharacter(ctx, acc, "Lirio", "guardian", &chosen)
	if err != nil {
		t.Fatal(err)
	}
	want := store.Look{Body: "slender", Skin: "deep", Hair: "curly", HairColor: "white", Beard: "none"}
	if got := repo.CharacterLook(c.ID); got != want {
		t.Fatalf("stored look %+v, want %+v", got, want)
	}

	for name, bad := range map[string]content.Look{
		"a creatures-only skin": {Body: "sturdy", Skin: "drowned", Hair: "short", HairColor: "black", Beard: "none"},
		"an unknown hair":       {Body: "sturdy", Skin: "fair", Hair: "spikes", HairColor: "black", Beard: "none"},
		"nothing":               {},
	} {
		if _, err := svc.CreateCharacter(ctx, acc, "Otro", "guardian", &bad); !errors.Is(err, auth.ErrInvalidLook) {
			t.Errorf("%s: %v, want ErrInvalidLook", name, err)
		}
	}

	none, err := svc.CreateCharacter(ctx, acc, "Sin Look", "guardian", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := repo.CharacterLook(none.ID); got != (store.Look{}) {
		t.Fatalf("no look sent: stored %+v, want none", got)
	}
}
