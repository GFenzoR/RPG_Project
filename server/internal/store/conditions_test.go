package store_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// characters.conditions (T3.2) is a JSON list; T5.2 adds the author of a condition and
// its holder's memory of that author's attack as optional keys: a condition without an
// author writes the same JSON as before, and a row written before reads as no author.
func TestConditionJSON(t *testing.T) {
	hit := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		c    store.Condition
		json string
	}{
		{"a monster's", store.Condition{ID: "poison", LeftMs: 500, Ticks: 3, Damage: 4},
			`{"id":"poison","left_ms":500,"ticks":3,"damage":4}`},
		{"a player's, remembered", store.Condition{ID: "poison", LeftMs: 500, Ticks: 3, Damage: 4, Author: 42, AuthorHit: hit,
			AuthorUnjust: true},
			`{"id":"poison","left_ms":500,"ticks":3,"damage":4,"author":42,"author_hit":"2026-11-15T10:00:00Z","author_unjust":true}`},
		{"a player's, from an arena", store.Condition{ID: "slowed", LeftMs: 900, Author: 42},
			`{"id":"slowed","left_ms":900,"author":42}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.c)
			if err != nil || string(b) != tc.json {
				t.Fatalf("marshal = %s, %v; want %s", b, err, tc.json)
			}
			var back store.Condition
			if err := json.Unmarshal(b, &back); err != nil || back.ID != tc.c.ID || back.Author != tc.c.Author ||
				!back.AuthorHit.Equal(tc.c.AuthorHit) || back.AuthorUnjust != tc.c.AuthorUnjust || back.Damage != tc.c.Damage {
				t.Fatalf("unmarshal = %+v, %v", back, err)
			}
		})
	}
}
