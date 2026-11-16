package app

import (
	"reflect"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// A saved condition keeps its author and its holder's memory of the author's attack
// (T5.2): what the gateway gives back to the loop on the next login.
func TestStoreConditionsKeepAuthor(t *testing.T) {
	hit := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	got := storeConditions([]session.ConditionState{
		{ID: "poison", LeftMs: 900, Ticks: 3, Damage: 20, Author: 42, AuthorHit: hit, AuthorUnjust: true},
		{ID: "slowed", LeftMs: 100},
	})
	want := []store.Condition{
		{ID: "poison", LeftMs: 900, Ticks: 3, Damage: 20, Author: 42, AuthorHit: hit, AuthorUnjust: true},
		{ID: "slowed", LeftMs: 100},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("storeConditions = %+v, want %+v", got, want)
	}
}
