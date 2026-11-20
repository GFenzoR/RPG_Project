package session_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Statuses (status.go, docs/02 "Estados del personaje"): in_combat, pvp_locked and
// protection_zone go in PlayerConditions after the conditions, read from the player at
// flush.

// blockTicks is travel.combat_block_ms of blockMs in ticks (12 s).
const blockTicks = game.Tick(combatBlock / game.TickDuration)

// conditionLists returns every PlayerConditions in evs, in order.
func conditionLists(evs []*pb.ServerMessage) [][]*pb.ActiveCondition {
	var out [][]*pb.ActiveCondition
	for _, pc := range find(evs, (*pb.ServerMessage).GetPlayerConditions) {
		out = append(out, pc.GetConditions())
	}
	return out
}

// statusIn returns the entry id of list, or nil.
func statusIn(list []*pb.ActiveCondition, id string) *pb.ActiveCondition {
	for _, c := range list {
		if c.GetConditionId() == id {
			return c
		}
	}
	return nil
}

// hurtAt lands a 1-damage hit on p (a fight: markFight) and returns the tick it fell on.
func (h *harness) hurtAt(p *session.Player) game.Tick {
	h.t.Helper()
	var at game.Tick
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) {
		h.w.HurtForTest(ctx, p, 1)
		at = ctx.Tick
	}))
	h.sim.Step()
	return at
}

// runToTick steps the world until tick is the last processed one.
func (h *harness) runToTick(tick game.Tick) {
	h.t.Helper()
	for h.sim.Tick() < tick {
		h.sim.Step()
	}
}

// Standing in a protection zone is a status with no end: the client hears of it when the
// player steps in and out, not at every step inside, and a login on such a tile has it
// in its first list.
func TestStatusProtectionZone(t *testing.T) {
	m := worldtest.Open(t, 0, 0, 32, 32)
	for x := 10; x <= 12; x++ {
		worldtest.SetTile(t, m, pos(x, 10), worldtest.Grass, world.FlagProtection)
	}
	h := newHarness(t, m)
	cl, p := h.join("Ana", at(9, 10))
	h.sim.Step()
	if lists := conditionLists(cl.take()); len(lists) != 0 {
		t.Fatalf("outside any zone the client got %v", lists)
	}

	h.input(cl, walk(pb.Direction_DIRECTION_EAST))
	h.sim.RunTicks(condSecond)
	lists := conditionLists(cl.take())
	if p.Pos() != pos(10, 10) || len(lists) != 1 || len(lists[0]) != 1 {
		t.Fatalf("at %v after stepping in: lists %v, want one with protection_zone", p.Pos(), lists)
	}
	if c := lists[0][0]; c.GetConditionId() != "protection_zone" || c.GetRemainingMs() != 0 || c.GetTicks() != 0 {
		t.Fatalf("in the zone: %v, want protection_zone with no time", c)
	}

	h.input(cl, walk(pb.Direction_DIRECTION_EAST))
	h.sim.RunTicks(condSecond)
	if lists := conditionLists(cl.take()); p.Pos() != pos(11, 10) || len(lists) != 0 {
		t.Fatalf("a step inside the zone (to %v) sent %v", p.Pos(), lists)
	}

	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(5, 5)) }))
	h.sim.Step()
	if lists := conditionLists(cl.take()); len(lists) != 1 || len(lists[0]) != 0 {
		t.Fatalf("out of the zone: %v, want one empty list", lists)
	}

	other, _ := h.join("Bea", at(12, 10))
	h.sim.Step()
	if lists := conditionLists(other.take()); len(lists) != 1 || statusIn(lists[0], "protection_zone") == nil {
		t.Fatalf("a login in the zone got %v, want protection_zone", lists)
	}
}

// in_combat is the logout block: it starts with a fight with the block's whole time, a
// fight that goes on tells the client again only when the end moved a second or more
// (hits every half second: one list a second), and it ends exactly when the block does.
func TestStatusInCombatFollowsTheLogoutBlock(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), blockMs)
	cl, p := h.join("Ana", at(5, 5))
	h.sim.Step()
	cl.take()

	first := h.hurtAt(p)
	lists := conditionLists(cl.take())
	if len(lists) != 1 || !slices.Equal(condIDs(lists[0]), []string{"in_combat"}) {
		t.Fatalf("after a hit: %v, want [in_combat]", lists)
	}
	if got, want := lists[0][0].GetRemainingMs(), uint32(combatBlock.Milliseconds()); got != want {
		t.Fatalf("in_combat right after the hit: %d ms left, want %d", got, want)
	}

	last := first
	for range 4 {
		h.runToTick(last + 9)
		last = h.hurtAt(p) // every 10 ticks: half a second
	}
	lists = conditionLists(cl.take())
	if len(lists) != 2 {
		t.Fatalf("four hits half a second apart sent %d lists, want 2 (one a second)", len(lists))
	}
	for _, l := range lists {
		if c := statusIn(l, "in_combat"); c == nil || c.GetRemainingMs() != uint32(combatBlock.Milliseconds()) {
			t.Fatalf("a resent list: %v, want in_combat with the whole block left", l)
		}
	}

	h.runToTick(last + blockTicks - 1)
	if lists := conditionLists(cl.take()); len(lists) != 0 {
		t.Fatalf("while the block lasts: %v", lists)
	}
	if !h.w.InCombatForTest(p, last+blockTicks-1) || h.w.InCombatForTest(p, last+blockTicks) {
		t.Fatal("the test's idea of the block's end is not inCombat's")
	}
	h.sim.Step()
	if lists := conditionLists(cl.take()); len(lists) != 1 || len(lists[0]) != 0 {
		t.Fatalf("when the block ends: %v, want one empty list", lists)
	}
}

// A death ends the fight: the list without in_combat comes at once. The conditions go
// first, the statuses after them.
func TestStatusInCombatEndsWithDeathAndFollowsConditions(t *testing.T) {
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32), blockMs)
	cl, p := h.join("Ana", at(5, 5))
	h.sim.Step()
	h.hurtAt(p)
	h.apply(p, nil, content.ConditionApply{ID: "hasted", DurationMs: 4000})
	lists := conditionLists(cl.take())
	if len(lists) == 0 || !slices.Equal(condIDs(lists[len(lists)-1]), []string{"hasted", "in_combat"}) {
		t.Fatalf("hasted in a fight: %v, want [hasted in_combat]", lists)
	}

	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) { h.w.DieForTest(ctx, p) }))
	h.sim.Step()
	lists = conditionLists(cl.take())
	if len(lists) == 0 || statusIn(lists[len(lists)-1], "in_combat") != nil {
		t.Fatalf("after dying: %v, want no in_combat", lists)
	}
}

// pvp_locked is an attacker's lock (no protection zone, no logout); the victim's lock is
// only in_combat. Both carry the time to their end.
func TestStatusPvPLock(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), blockMs)
	acl, a := h.join("Ana", at(5, 5))
	vcl, v := h.join("Bea", at(7, 5))
	h.sim.Step()
	acl.take()
	vcl.take()

	var now game.Tick
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) {
		now = ctx.Tick
		h.w.SetAttackLockForTest(a, ctx.Tick+800) // 40 s
		h.w.SetPvPLockForTest(v, ctx.Tick+800)
	}))
	h.sim.Step()
	al, vl := conditionLists(acl.take()), conditionLists(vcl.take())
	if len(al) != 1 || !slices.Equal(condIDs(al[0]), []string{"in_combat", "pvp_locked"}) {
		t.Fatalf("attacker: %v, want [in_combat pvp_locked]", al)
	}
	for _, c := range al[0] {
		if c.GetRemainingMs() != 40_000 {
			t.Errorf("attacker's %s: %d ms left, want 40000", c.GetConditionId(), c.GetRemainingMs())
		}
	}
	if len(vl) != 1 || !slices.Equal(condIDs(vl[0]), []string{"in_combat"}) {
		t.Fatalf("victim: %v, want [in_combat]", vl)
	}

	h.runToTick(now + 800)
	if al := conditionLists(acl.take()); len(al) != 1 || len(al[0]) != 0 {
		t.Fatalf("attacker when the lock ends: %v, want one empty list", al)
	}
}

// A balance.yaml condition may not take a status's id.
func TestStatusIDsAreReserved(t *testing.T) {
	bal := testBalance()
	bal.Conditions = content.ConditionDefs{
		"in_combat": {ID: "in_combat", Kind: content.ConditionSpeed, SpeedPct: 10, MaxMs: 1000, Stacking: content.StackRefresh},
	}
	cfg := session.Config{Map: worldtest.Open(t, 0, 0, 8, 8), Balance: bal, Vocations: testVocations,
		Save: func(session.Snapshot) bool { return true }}
	(&harness{t: t}).wireEconomy(&cfg)
	if _, err := session.New(cfg); err == nil || !strings.Contains(err.Error(), "in_combat") {
		t.Fatalf("New with a condition named in_combat: %v", err)
	}
}

func condIDs(list []*pb.ActiveCondition) []string {
	out := []string{}
	for _, c := range list {
		out = append(out, c.GetConditionId())
	}
	return out
}
