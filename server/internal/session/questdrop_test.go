package session_test

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// The forge seal is a quest drop (loot each_player, content audit m9): when a group kills
// the slagbound warden, everyone who hurt it and is on ch3_warden gets a seal of its own;
// a helper without the quest gets none, and none is left in the remains.
func TestQuestDropForEveryoneWhoNeedsIt(t *testing.T) {
	h := chapterThreeHarness(t)
	join := func(id int64, name string, x int) (*fakeClient, *session.Player) {
		c := session.Character{ID: id, AccountID: id, Name: name, Vocation: "guardian", Level: 44, Health: 1000, Mana: 100}
		return h.joinFresh(c, pos(x, 44))
	}
	_, a := join(941, "Anvil", 29)
	_, b := join(942, "Bellows", 31)
	_, helper := join(943, "Tongs", 30)
	h.sim.Command(gameFunc(func() {
		for _, p := range []*session.Player{a, b} {
			p.SetStorageForTest("quest.ch3_warden", 1) // in progress
			p.SetStorageForTest("quest.ch3_warden.step", 0)
		}
	}))
	h.sim.Step()
	var warden *session.Monster
	for _, m := range h.w.Monsters() {
		if m.Kind() == "slagbound_warden" {
			warden = m
		}
	}
	if warden == nil {
		t.Fatal("no warden")
	}
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) {
		warden.SetHealth(30)
		h.w.DamageMonsterForTest(ctx, warden, helper, 10)
		h.w.DamageMonsterForTest(ctx, warden, b, 10)
		h.w.DamageMonsterForTest(ctx, warden, a, 10) // the killing blow
	}))
	h.sim.Step()
	for _, p := range []*session.Player{a, b} {
		_, step := h.w.QuestState(p, "ch3_warden")
		if n := h.w.CountItem(p, "forge_seal"); n != 1 || step != "return_seal" {
			t.Errorf("player %d: %d seals, step %q (want 1 and return_seal)", p.ID(), n, step)
		}
	}
	if n := h.w.CountItem(helper, "forge_seal"); n != 0 {
		t.Errorf("the helper without the quest got %d seals", n)
	}
	for _, it := range h.w.GroundAt(warden.Pos()) {
		for _, in := range it.Items() {
			if in.Def().ID == "forge_seal" {
				t.Error("a seal was left in the remains")
			}
		}
	}
}

// A quest drop comes back: whoever lost the seal before handing it in (a death, a drop)
// gets another from the next warden (quest.Engine.Needs counts the done take_seal step),
// one who still holds it gets none, and one whose pack cannot take it finds it at its
// feet (take_seal waits until it is picked up; the economy ledger reconciles every tick).
func TestQuestDropAgainAfterLosingIt(t *testing.T) {
	h := chapterThreeHarness(t)
	join := func(id int64, name string, x int) *session.Player {
		c := session.Character{ID: id, AccountID: id, Name: name, Vocation: "guardian", Level: 44, Health: 1000, Mana: 100}
		_, p := h.joinFresh(c, pos(x, 44))
		return p
	}
	lost, holder, full := join(951, "Ashen", 29), join(952, "Ember", 31), join(953, "Cinder", 30)
	h.sim.Command(gameFunc(func() {
		for _, p := range []*session.Player{lost, holder, full} {
			p.SetStorageForTest("quest.ch3_warden", 1)
			p.SetStorageForTest("quest.ch3_warden.step", 0)
		}
	}))
	h.sim.Step()
	kill := func(by ...*session.Player) {
		t.Helper()
		// Far from the spawn: a monster does not respawn under a player's eyes.
		h.sim.Command(gameFunc(func() {
			for i, p := range []*session.Player{lost, holder, full} {
				h.w.Teleport(p, pos(18+i, 12))
			}
		}))
		h.sim.Step()
		var warden *session.Monster
		h.sim.RunUntil(func() bool {
			for _, m := range h.w.Monsters() {
				if m.Kind() == "slagbound_warden" {
					warden = m
				}
			}
			return warden != nil
		}, sim.MaxSeconds(700))
		h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) {
			warden.SetHealth(10 * len(by))
			for _, p := range by {
				h.w.DamageMonsterForTest(ctx, warden, p, 10)
			}
		}))
		h.sim.Step()
	}
	kill(lost, holder)
	for _, m := range h.w.Monsters() {
		if m.Kind() == "slagbound_warden" {
			t.Fatal("the warden survived the first kill")
		}
	}
	if h.w.CountItem(lost, "forge_seal") != 1 || h.w.CountItem(holder, "forge_seal") != 1 {
		t.Fatal("no seals from the first kill")
	}
	h.sim.Command(gameFunc(func() { h.w.TakeForTest(lost, "forge_seal", 1) })) // lost on the way
	h.sim.Step()
	h.sim.Command(gameFunc(func() { h.w.SetCapacityForTest(full, 0) }))
	h.sim.Step()
	kill(full, holder, lost)
	if _, step := h.w.QuestState(lost, "ch3_warden"); h.w.CountItem(lost, "forge_seal") != 1 || step != "return_seal" {
		t.Errorf("the one who lost it: %d seals, step %q", h.w.CountItem(lost, "forge_seal"), step)
	}
	if n := h.w.CountItem(holder, "forge_seal"); n != 1 {
		t.Errorf("the one who still held it has %d seals, want 1", n)
	}
	_, step := h.w.QuestState(full, "ch3_warden")
	onFloor := 0
	for _, it := range h.w.GroundAt(full.Pos()) {
		if it.Def().ID == "forge_seal" {
			onFloor += it.Count()
		}
	}
	if h.w.CountItem(full, "forge_seal") != 0 || onFloor != 1 || step != "take_seal" {
		t.Errorf("full pack: %d seals carried, %d at its feet, step %q (want 0, 1, take_seal)",
			h.w.CountItem(full, "forge_seal"), onFloor, step)
	}
}

// The leash and the quest drop: a warden that gives up its fight (its target left its
// leash area and its reach, docs/02 "Correa") forgets who hurt it, so the seal goes only
// to whoever hurts it after that. Here the runner hits it, draws it to the east wall of
// the forge and steps out of its leash in its sight; a second player kills it later.
func TestQuestDropForgottenWhenTheWardenGivesUp(t *testing.T) {
	h := chapterThreeHarness(t)
	join := func(id int64, name string, at world.Pos) *session.Player {
		c := session.Character{ID: id, AccountID: id, Name: name, Vocation: "guardian", Level: 44, Health: 1000, Mana: 100}
		_, p := h.joinFresh(c, at)
		return p
	}
	// The warden's spawn: center 30,44, radius 1; its leash area reaches 7 tiles (radius +
	// combat.monster_leash_tiles 6). The forge's walls are x 26 and 34, y 40 and 48.
	runner := join(961, "Bolt", pos(33, 44))
	h.sim.Command(gameFunc(func() {
		runner.SetStorageForTest("quest.ch3_warden", 1)
		runner.SetStorageForTest("quest.ch3_warden.step", 0)
	}))
	h.sim.Step()
	var warden *session.Monster
	for _, m := range h.w.Monsters() {
		if m.Kind() == "slagbound_warden" {
			warden = m
		}
	}
	if warden == nil {
		t.Fatal("no warden")
	}
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) {
		h.w.DamageMonsterForTest(ctx, warden, runner, 10)
	}))
	h.sim.Step()
	h.sim.RunUntil(func() bool {
		return warden.TargetID() == runner.ID() && chebyshev(warden.Pos(), runner.Pos()) == 1
	}, sim.MaxSeconds(10))
	if warden.DamageShareForTest(runner.ID()) != 10 {
		t.Fatalf("the warden remembers %d damage from the runner, want 10", warden.DamageShareForTest(runner.ID()))
	}
	// Out of the leash (9 from the center), out of its reach (spell range 4) and in its
	// sight (the warden stands at x 32 or more): it gives up, heals and forgets.
	h.sim.Command(gameFunc(func() { h.w.Teleport(runner, pos(39, 44)) }))
	h.sim.Step()
	h.sim.RunUntil(func() bool { return warden.TargetID() == 0 }, sim.MaxSeconds(5))
	if cur, full := warden.Health(); cur != full || warden.DamageShareForTest(runner.ID()) != 0 {
		t.Fatalf("after giving up: health %d/%d, runner's damage %d (want full and 0)",
			cur, full, warden.DamageShareForTest(runner.ID()))
	}
	// Far from the forge (no respawn under anyone's eyes is needed: the warden lives).
	h.sim.Command(gameFunc(func() { h.w.Teleport(runner, pos(18, 12)) }))
	h.sim.Step()
	killer := join(962, "Quench", pos(29, 41))
	h.sim.Command(gameFunc(func() {
		killer.SetStorageForTest("quest.ch3_warden", 1)
		killer.SetStorageForTest("quest.ch3_warden.step", 0)
	}))
	h.sim.Step()
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) {
		warden.SetHealth(10)
		h.w.DamageMonsterForTest(ctx, warden, killer, 10)
	}))
	h.sim.Step()
	if n := h.w.CountItem(killer, "forge_seal"); n != 1 {
		t.Errorf("the killer got %d seals, want 1", n)
	}
	if n := h.w.CountItem(runner, "forge_seal"); n != 0 {
		t.Errorf("the runner, forgotten when the warden gave up, got %d seals", n)
	}
}
