package gateway

import (
	"reflect"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// A loaded condition keeps the author it was saved with (T5.2), so a player's condition
// is still that player's attack after its holder logs in again.
func TestToCharacterConditionAuthor(t *testing.T) {
	hit := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	c := toCharacter(store.PlayCharacter{ID: 7, Conditions: []store.Condition{
		{ID: "poison", LeftMs: 900, Ticks: 3, Damage: 20, Author: 42, AuthorHit: hit, AuthorUnjust: true},
		{ID: "slowed", LeftMs: 100},
	}})
	want := []session.ConditionState{
		{ID: "poison", LeftMs: 900, Ticks: 3, Damage: 20, Author: 42, AuthorHit: hit, AuthorUnjust: true},
		{ID: "slowed", LeftMs: 100},
	}
	if !reflect.DeepEqual(c.Conditions, want) {
		t.Fatalf("conditions = %+v, want %+v", c.Conditions, want)
	}
}
