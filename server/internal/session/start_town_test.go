package session_test

import (
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// A character without a residence town wakes up at the start town's temple.
func TestStartTownTemple(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		".....",
		"..T..",
		".....",
	)
	h := newHarness(t, m, func(c *session.Config) { c.StartTown = "test" })
	_, p := h.join("Newcomer", nil)
	if got, want := p.Pos(), pos(2, 1); got != want {
		t.Fatalf("new character at %v, want the start town's temple %v", got, want)
	}
}

// A start town that is not an island of the map is a configuration error.
func TestStartTownMustExist(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7, "..T..")
	_, err := session.New(session.Config{
		Map:       m,
		StartTown: "nowhere",
		Balance:   testBalance(),
		Vocations: testVocations,
		Save:      func(session.Snapshot) bool { return true },
	})
	if err == nil || !strings.Contains(err.Error(), "nowhere") {
		t.Fatalf("New with an unknown start town: err = %v, want an error naming it", err)
	}
}
