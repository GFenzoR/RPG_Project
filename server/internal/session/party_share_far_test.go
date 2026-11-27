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

// The indicator follows the rule of the pot, not the view: a member out of the viewer's
// window but within share_distance shares (a kill next to the viewer pays both), and
// only one beyond share_distance is "too far". With nobody else left to share with, the
// viewer itself is ALONE, in a party of more than two as well.
func TestShareIndicatorFollowsShareDistance(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 64), func(c *session.Config) { c.Balance.Party.ShareDistance = 24 })
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(11, 10))
	cc, c := h.join("Cora", at(12, 10))
	h.form(ca, a, member{cb, b}, member{cc, c})
	// 20 tiles south: beyond the window (11 + 1 rows), within share_distance (24).
	h.do(func(ctx *game.TickContext) {
		h.w.Teleport(b, pos(10, 30))
		h.w.Teleport(c, pos(10, 40)) // 30 tiles: too far
		for _, p := range []*session.Player{a, b, c} {
			h.w.ContributeForTest(ctx, p)
		}
	})
	if a.Knows(b.ID()) {
		t.Fatal("Ana still sees Bruno: the test needs him out of view")
	}
	ca.take()
	h.sim.RunTicks(40)
	up := lastParty(ca.take())
	if up == nil {
		t.Fatal("no update")
	}
	if up.GetShared() != pb.SharedExperience_SHARED_EXPERIENCE_ACTIVE {
		t.Errorf("state %v, want ACTIVE", up.GetShared())
	}
	for _, m := range up.GetMembers() {
		if m.GetCreatureId() == b.ID() && m.GetInView() {
			t.Error("Bruno is in view")
		}
	}
	if sharing, block := blockOf(t, up, a.ID()); !sharing {
		t.Errorf("Ana: not sharing (%v)", block)
	}
	if sharing, block := blockOf(t, up, b.ID()); !sharing {
		t.Errorf("Bruno, out of view within share_distance: not sharing (%v)", block)
	}
	if sharing, block := blockOf(t, up, c.ID()); sharing || block != pb.ShareBlock_SHARE_BLOCK_FAR {
		t.Errorf("Cora, beyond share_distance: sharing %v, block %v", sharing, block)
	}
	// What the window says is what a kill next to Ana pays.
	xb, xc := b.Experience(), c.Experience()
	h.do(func(ctx *game.TickContext) { h.w.ShareForTest(ctx, a.Pos(), 1000, session.Share{P: a, Amount: 1}) })
	if b.Experience() == xb || c.Experience() != xc {
		t.Errorf("the kill paid Bruno %d and Cora %d", b.Experience()-xb, c.Experience()-xc)
	}

	h.do(func(ctx *game.TickContext) { b.SetHealthForTest(0) })
	h.sim.RunTicks(40)
	up = lastParty(ca.take())
	h.do(func(ctx *game.TickContext) { b.SetHealthForTest(1) })
	if up == nil {
		t.Fatal("no update after the death")
	}
	if up.GetShared() != pb.SharedExperience_SHARED_EXPERIENCE_INACTIVE {
		t.Errorf("state %v, want INACTIVE", up.GetShared())
	}
	want := map[uint32]pb.ShareBlock{
		a.ID(): pb.ShareBlock_SHARE_BLOCK_ALONE,
		b.ID(): pb.ShareBlock_SHARE_BLOCK_DEAD,
		c.ID(): pb.ShareBlock_SHARE_BLOCK_FAR,
	}
	for _, m := range up.GetMembers() {
		if m.GetSharing() || m.GetShareBlock() != want[m.GetCreatureId()] {
			t.Errorf("member %s: sharing %v, block %v, want %v", m.GetName(), m.GetSharing(), m.GetShareBlock(), want[m.GetCreatureId()])
		}
	}
}

// shareFloors is an open map of 40x40 on floors 6 and 7.
func shareFloors(t *testing.T) *world.Map {
	t.Helper()
	rows := make([]string, 40)
	for i := range rows {
		rows[i] = strings.Repeat(".", 40)
	}
	return worldtest.Floors(t, 0, 0, worldtest.Layer{Z: 6, Rows: rows}, worldtest.Layer{Z: 7, Rows: rows})
}

// A member on another floor is too far for the indicator, as it is for the pot, however
// close it stands and even if the viewer sees it.
func TestShareIndicatorOtherFloor(t *testing.T) {
	h := newHarness(t, shareFloors(t))
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(11, 10))
	cc, c := h.join("Cora", at(12, 10))
	h.form(ca, a, member{cb, b}, member{cc, c})
	h.do(func(ctx *game.TickContext) {
		h.w.Teleport(c, world.Pos{X: 12, Y: 10, Z: 6})
		for _, p := range []*session.Player{a, b, c} {
			h.w.ContributeForTest(ctx, p)
		}
	})
	ca.take()
	h.sim.RunTicks(40)
	up := lastParty(ca.take())
	if up == nil {
		t.Fatal("no update")
	}
	if sharing, block := blockOf(t, up, c.ID()); sharing || block != pb.ShareBlock_SHARE_BLOCK_FAR {
		t.Errorf("Cora, on another floor: sharing %v, block %v, want FAR", sharing, block)
	}
	if sharing, _ := blockOf(t, up, b.ID()); !sharing {
		t.Error("Bruno does not share")
	}
}

// Who gets the quest credit of a kill besides those that hit: the sharers of each party
// that hit, never a member on another floor, never the second character of an account,
// and the members of two parties that hit the same monster each with their own.
func TestQuestCreditPartners(t *testing.T) {
	h := newHarness(t, shareFloors(t), func(c *session.Config) { c.Balance.Party.MaxMembers = 6 })
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(11, 10)) // goes to the other floor
	cc, c := h.join("Cora", at(12, 10))  // shares
	nextChar++
	cx, alt := h.joinChar(session.Character{ID: nextChar, AccountID: c.AccountIDForTest(), Name: "Corita",
		Vocation: "guardian", Level: 1, Health: 145, Mana: 20, Pos: *at(13, 10), HasPos: true})
	cd, d := h.join("Dora", at(10, 12)) // another party
	ce, e := h.join("Elio", at(11, 12))
	_, g := h.join("Greta", at(12, 12)) // no party
	h.form(ca, a, member{cb, b}, member{cc, c}, member{cx, alt})
	h.form(cd, d, member{ce, e})
	h.do(func(ctx *game.TickContext) {
		h.w.Teleport(b, world.Pos{X: 11, Y: 10, Z: 6})
		for _, p := range []*session.Player{a, b, c, alt, d, e, g} {
			h.w.ContributeForTest(ctx, p)
		}
	})
	names := func(ps []*session.Player) []string {
		out := make([]string, len(ps))
		for i, p := range ps {
			out[i] = p.NameForTest()
		}
		slices.Sort(out)
		return out
	}
	var got []*session.Player
	h.do(func(ctx *game.TickContext) {
		got = h.w.ShareForTest(ctx, a.Pos(), 1000, session.Share{P: a, Amount: 1}, session.Share{P: d, Amount: 1},
			session.Share{P: g, Amount: 1})
	})
	if n := names(got); !slices.Equal(n, []string{"Cora", "Elio"}) {
		t.Fatalf("partners %v, want Cora and Elio", n)
	}
	// Both members of a party hit it: nobody is a partner twice, and who hit is none.
	h.do(func(ctx *game.TickContext) {
		got = h.w.ShareForTest(ctx, a.Pos(), 1000, session.Share{P: a, Amount: 1}, session.Share{P: c, Amount: 1},
			session.Share{P: alt, Amount: 1})
	})
	if len(got) != 0 {
		t.Fatalf("partners %v, want none", names(got))
	}
	// Only the member on the other floor hit it: it shares with nobody.
	h.do(func(ctx *game.TickContext) {
		got = h.w.ShareForTest(ctx, a.Pos(), 1000, session.Share{P: b, Amount: 1})
	})
	if len(got) != 0 {
		t.Fatalf("a hit from another floor: partners %v, want none", names(got))
	}
}

const oneKillQuest = `
id: onekill
name: quest.onekill.name
chapter: 2
steps:
  - { id: post, description: quest.onekill.post, complete_when: { kill: { monster: post, count: 1 } } }
rewards:
  - { xp: 5000 }
`

// The credit of a shared kill is a full one: it completes the step and pays the quest's
// reward to a sharer that never hit the monster. The loot stays one: nothing lands in
// the sharer's inventory.
func TestSharedQuestKillPaysTheReward(t *testing.T) {
	q, err := content.ParseQuest([]byte(oneKillQuest))
	if err != nil {
		t.Fatal(err)
	}
	target := &content.Monster{ID: "post", Health: 10, Experience: 20, Speed: 100}
	m := worldtest.Open(t, 0, 0, 64, 64)
	m.Islands()[0].Spawns = append(m.Islands()[0].Spawns, spawnAt("post", 20, 20, 0, 600))
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{target.ID: target}
		c.Items = testItems()
		c.Quests = content.Quests{q.ID: q}
	})
	ca, a := h.join("Ana", at(21, 20))
	cb, b := h.join("Bruno", at(23, 22))
	h.form(ca, a, member{cb, b})
	h.do(func(ctx *game.TickContext) {
		for _, p := range []*session.Player{a, b} {
			if !h.w.StartQuestForTest(p, "onekill") {
				t.Errorf("%s did not start the quest", p.NameForTest())
			}
			h.w.ContributeForTest(ctx, p)
		}
	})
	xb := b.Experience()
	post := h.w.Monsters()[0]
	h.do(func(ctx *game.TickContext) {
		post.SetHealth(1)
		h.w.DamageMonsterForTest(ctx, post, a, 1)
	})
	h.sim.RunTicks(2)
	for _, p := range []*session.Player{a, b} {
		if st := p.Storage("quest.onekill"); st != 2 {
			t.Errorf("%s: quest state %d, want 2 (completed)", p.NameForTest(), st)
		}
	}
	if got := b.Experience() - xb; got < 5000 {
		t.Errorf("Bruno gained %d experience, want the reward of 5000 and his part of the kill", got)
	}
}
