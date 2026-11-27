package session_test

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// blockOf is whether member id of up shares and, if not, why.
func blockOf(t *testing.T, up *pb.PartyUpdate, id uint32) (sharing bool, block pb.ShareBlock) {
	t.Helper()
	for _, m := range up.GetMembers() {
		if m.GetCreatureId() == id {
			return m.GetSharing(), m.GetShareBlock()
		}
	}
	t.Fatalf("member %d not in %v", id, up)
	return false, 0
}

// Two low levels share with up to level_gap_always (5) levels between them, whatever
// the percentage says (3 is 43 % of 7); one level more and the low one is left out, and
// the party window says it is the level.
func TestSharedExperienceLevelGapBoundary(t *testing.T) {
	for _, c := range []struct {
		low, high int
		share     bool
	}{
		{3, 7, true},
		{2, 7, true},
		{1, 7, false},
		{14, 20, true}, // 6 below, but 70 %
		{13, 20, false},
	} {
		h := partyHarness(t)
		ca, a := h.join("Ana", at(10, 10))
		cb, b := h.join("Bruno", at(12, 10))
		h.form(ca, a, member{cb, b})
		h.do(func(ctx *game.TickContext) {
			h.w.SetLevelForTest(a, c.high)
			h.w.SetLevelForTest(b, c.low)
			h.w.ContributeForTest(ctx, a)
			h.w.ContributeForTest(ctx, b)
		})
		xa, xb := a.Experience(), b.Experience()
		h.do(func(ctx *game.TickContext) {
			h.w.ShareForTest(ctx, pos(11, 10), 1000, session.Share{P: a, Amount: 1})
		})
		da, db := a.Experience()-xa, b.Experience()-xb
		if c.share && (da != 525 || db != 525) || !c.share && (da != 1000 || db != 0) {
			t.Errorf("levels %d and %d: experience %d %d", c.low, c.high, da, db)
		}
		h.do(func(ctx *game.TickContext) { // the experience may have raised a level
			h.w.SetLevelForTest(a, c.high)
			h.w.SetLevelForTest(b, c.low)
		})
		cb.take()
		h.sim.RunTicks(40)
		up := lastParty(cb.take())
		if up == nil {
			t.Fatalf("levels %d and %d: no update", c.low, c.high)
		}
		sharing, block := blockOf(t, up, b.ID())
		_, top := blockOf(t, up, a.ID())
		if c.share {
			if up.GetShared() != pb.SharedExperience_SHARED_EXPERIENCE_ACTIVE || !sharing || block != pb.ShareBlock_SHARE_BLOCK_UNSPECIFIED {
				t.Errorf("levels %d and %d: indicator %v %v %v", c.low, c.high, up.GetShared(), sharing, block)
			}
		} else if up.GetShared() != pb.SharedExperience_SHARED_EXPERIENCE_INACTIVE || sharing ||
			block != pb.ShareBlock_SHARE_BLOCK_LEVEL || top != pb.ShareBlock_SHARE_BLOCK_ALONE {
			t.Errorf("levels %d and %d: indicator %v %v %v, the highest %v", c.low, c.high, up.GetShared(), sharing, block, top)
		}
	}
}

// The party window tells why each member does not share: out of view, dead, idle (did
// not fight); and nothing while shared experience is off.
func TestShareBlockReasons(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 64), func(c *session.Config) { c.Balance.Party.MaxMembers = 6 })
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	cc, c := h.join("Cora", at(11, 11))
	cd, d := h.join("Dario", at(12, 12))
	ce, e := h.join("Elsa", at(10, 12))
	h.form(ca, a, member{cb, b}, member{cc, c}, member{cd, d}, member{ce, e})
	h.do(func(ctx *game.TickContext) { h.w.Teleport(d, pos(60, 60)) })
	sharers := map[uint32]bool{a.ID(): true, b.ID(): true}
	want := map[uint32]pb.ShareBlock{
		c.ID(): pb.ShareBlock_SHARE_BLOCK_IDLE,
		d.ID(): pb.ShareBlock_SHARE_BLOCK_FAR,
		e.ID(): pb.ShareBlock_SHARE_BLOCK_DEAD,
	}
	h.do(func(ctx *game.TickContext) {
		for _, p := range []*session.Player{a, b, d, e} { // Cora did not fight
			h.w.ContributeForTest(ctx, p)
		}
		e.SetHealthForTest(0)
	})
	ca.take()
	h.sim.RunTicks(40)
	up := lastParty(ca.take())
	if up == nil {
		t.Fatal("no update")
	}
	h.do(func(ctx *game.TickContext) { e.SetHealthForTest(1) })
	for _, m := range up.GetMembers() {
		id := m.GetCreatureId()
		if m.GetSharing() != sharers[id] || m.GetShareBlock() != want[id] {
			t.Errorf("member %s: sharing %v, block %v, want %v", m.GetName(), m.GetSharing(), m.GetShareBlock(), want[id])
		}
	}
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_SHARE_OFF, 0))
	h.sim.RunTicks(40)
	if up = lastParty(ca.take()); up == nil {
		t.Fatal("no update after turning it off")
	}
	for _, m := range up.GetMembers() {
		if m.GetSharing() || m.GetShareBlock() != pb.ShareBlock_SHARE_BLOCK_UNSPECIFIED {
			t.Errorf("shared off: member %v", m)
		}
	}
}

const huntQuest = `
id: hunt
name: quest.hunt.name
chapter: 2
steps:
  - { id: posts, description: quest.hunt.posts, complete_when: { kill: { monster: post, count: 9 } } }
rewards:
  - { xp: 100 }
`

// A kill counts for the kill objectives of the members that share its experience with
// the killer, once each: not for a member that is too far, dead, idle or out of level
// range, not for a stranger, and for nobody but the killer once the leader turns shared
// experience off.
func TestSharedQuestKill(t *testing.T) {
	q, err := content.ParseQuest([]byte(huntQuest))
	if err != nil {
		t.Fatal(err)
	}
	target := &content.Monster{ID: "post", Health: 10, Experience: 20, Speed: 100}
	m := worldtest.Open(t, 0, 0, 64, 64)
	for i, at := range [][2]int{{20, 20}, {20, 17}, {17, 20}, {17, 17}, {23, 17}} { // one per kill
		sp := spawnAt("post", at[0], at[1], 0, 600)
		sp.ID += string(rune('a' + i))
		m.Islands()[0].Spawns = append(m.Islands()[0].Spawns, sp)
	}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{target.ID: target}
		c.Items = testItems()
		c.Quests = content.Quests{q.ID: q}
		c.Balance.Party.MaxMembers = 6
	})
	ca, a := h.join("Ana", at(21, 20))   // the killer
	cb, b := h.join("Bruno", at(23, 22)) // shares
	cc, c := h.join("Cora", at(22, 22))  // too far
	cd, d := h.join("Dario", at(22, 21)) // dead
	ce, e := h.join("Elsa", at(19, 21))  // did not fight
	cf, f := h.join("Fidel", at(21, 22)) // level out of range
	_, g := h.join("Greta", at(19, 19))  // not in the party
	all := []*session.Player{a, b, c, d, e, f, g}
	h.form(ca, a, member{cb, b}, member{cc, c}, member{cd, d}, member{ce, e}, member{cf, f})
	h.do(func(ctx *game.TickContext) { h.w.Teleport(c, pos(60, 60)) })
	kill := func(hitters ...*session.Player) {
		t.Helper()
		left := len(h.w.Monsters())
		post := h.w.Monsters()[0]
		h.do(func(ctx *game.TickContext) {
			h.w.SetLevelForTest(a, 20)
			h.w.SetLevelForTest(b, 15)
			h.w.SetLevelForTest(f, 5)
			for _, p := range []*session.Player{a, b, c, d, f} {
				h.w.ContributeForTest(ctx, p)
			}
			d.SetHealthForTest(0)
			post.SetHealth(len(hitters))
			for _, p := range hitters {
				h.w.DamageMonsterForTest(ctx, post, p, 1)
			}
			d.SetHealthForTest(1)
		})
		if n := len(h.w.Monsters()); n != left-1 {
			t.Fatalf("%d monsters left of %d", n, left)
		}
	}
	check := func(when string, want ...int64) {
		t.Helper()
		for i, p := range all {
			if got := p.Storage("quest.hunt.kills"); got != want[i] {
				t.Fatalf("%s: player %d counts %d kills, want %v", when, i, got, want)
			}
		}
	}
	h.do(func(ctx *game.TickContext) {
		for _, p := range all {
			if !h.w.StartQuestForTest(p, "hunt") {
				t.Errorf("%d did not start the quest", p.ID())
			}
		}
	})
	kill(a)
	check("a kill of Ana", 1, 1, 0, 0, 0, 0, 0)
	// Both hit it: one kill each, never two.
	kill(a, b)
	check("a kill of both", 2, 2, 0, 0, 0, 0, 0)
	// Fidel (out of level range) kills: his own kill only, he shares with nobody.
	kill(f)
	check("a kill of Fidel", 2, 2, 0, 0, 0, 1, 0)
	// A stranger's kill is the stranger's.
	kill(g)
	check("a kill of Greta", 2, 2, 0, 0, 0, 1, 1)
	h.sim.RunTicks(300) // the invitations spent the leader's chat allowance
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_SHARE_OFF, 0))
	h.sim.Step()
	if _, _, shared := a.PartyForTest(); shared {
		t.Fatal("still shared")
	}
	kill(a)
	check("shared off", 3, 2, 0, 0, 0, 1, 1)
}
