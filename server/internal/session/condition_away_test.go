package session

import (
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
)

// elapse at the edges (T5.2): a damage condition due in 10 ticks, then every 20, with 5
// hits (at 10, 30, 50, 70 and 90 ticks); a timed one ending in 10 ticks.
func TestConditionElapse(t *testing.T) {
	damage := &content.ConditionDef{Kind: content.ConditionDamage}
	timed := &content.ConditionDef{Kind: content.ConditionSpeed}
	cases := []struct {
		def   *content.ConditionDef
		away  game.Tick
		left  game.Tick // after; 0 = it ran out
		ticks int       // hits left after (damage)
	}{
		{damage, 0, 10, 5},
		{damage, 9, 1, 5},   // one tick before the first hit
		{damage, 10, 20, 4}, // the first hit falls with the absence
		{damage, 29, 1, 4},
		{damage, 30, 20, 3},
		{damage, 89, 1, 1}, // one tick before the last hit
		{damage, 90, 0, 0}, // the last hit fell
		{damage, 500, 0, 0},
		{timed, 9, 1, 0},
		{timed, 10, 0, 0},
	}
	for _, tc := range cases {
		c := &condition{def: tc.def}
		if tc.def.Kind == content.ConditionDamage {
			c.every, c.ticks = 20, 5
		}
		left, ok := c.elapse(10, tc.away)
		if ok != (tc.left > 0) || left != tc.left || ok && c.ticks != tc.ticks {
			t.Errorf("%v away %d: left %d ok %v ticks %d, want left %d ticks %d", tc.def.Kind, tc.away, left, ok,
				c.ticks, tc.left, tc.ticks)
		}
	}
}

// awayTicks places a save on this server's clock, or reports that it cannot (the condition
// then ends): rounded up to whole ticks, never before this server's first tick, never in
// the future, never without a time.
func TestConditionAwayTicks(t *testing.T) {
	now := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	ctx := &game.TickContext{Tick: 100, Now: now} // the server is 100 ticks (5 s) old
	cases := []struct {
		saved time.Time
		want  game.Tick
		ok    bool
	}{
		{now, 0, true},
		{now.Add(-time.Second), 20, true},
		{now.Add(-time.Second - time.Millisecond), 21, true},
		{now.Add(-5 * time.Second), 100, true},
		{now.Add(-5*time.Second - time.Millisecond), 0, false}, // before the first tick
		{now.Add(time.Millisecond), 0, false},                  // a clock behind the save
		{time.Time{}, 0, false},                                // no time saved
	}
	for _, tc := range cases {
		got, ok := awayTicks(ctx, tc.saved)
		if got != tc.want || ok != tc.ok {
			t.Errorf("saved %v: %d %v, want %d %v", tc.saved, got, ok, tc.want, tc.ok)
		}
	}
}
