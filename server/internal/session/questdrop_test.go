package session_test

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
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
