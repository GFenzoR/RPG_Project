package session_test

import (
	"fmt"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// bigPartyHarness is partyHarness with the real party size and bonus steps of
// data/balance.yaml (6 members; +5, +10, +15 and +20 % for 2, 3, 4 and 5 or more).
func bigPartyHarness(t *testing.T) *harness {
	t.Helper()
	return newHarness(t, worldtest.Open(t, 0, 0, 64, 64), func(c *session.Config) {
		c.Balance.Party.MaxMembers = 6
		c.Balance.Party.BonusPctBySharers = []int{5, 10, 15, 20}
	})
}

// xpTexts returns the experience floating texts in evs.
func xpTexts(evs []*pb.ServerMessage) []*pb.FloatingText {
	var out []*pb.FloatingText
	for _, f := range find(evs, (*pb.ServerMessage).GetFloatingText) {
		if f.GetKind() == pb.FloatingTextKind_FLOATING_TEXT_KIND_EXPERIENCE {
			out = append(out, f)
		}
	}
	return out
}

// The bonus grows with the number of sharers, step by step, and stops at the last step
// (20 %) however many share: each sharer gets pot × (100 + bonus) / 100 / n. The
// floating number of each sharer carries the bonus part apart; the party window's
// update says the bonus %.
func TestSharedExperienceBonusSteps(t *testing.T) {
	h := bigPartyHarness(t)
	cls := make([]*fakeClient, 6)
	ps := make([]*session.Player, 6)
	for i := range ps {
		cls[i], ps[i] = h.join(fmt.Sprintf("P%d", i), at(10+i, 10))
	}
	others := make([]member, 0, 5)
	for i := 1; i < 6; i++ {
		others = append(others, member{cls[i], ps[i]})
	}
	h.form(cls[0], ps[0], others...)
	// One level for all, far above what the test's experience reaches: nobody levels up
	// and falls out of the others' level range (anti-carry).
	h.do(func(*game.TickContext) {
		for _, p := range ps {
			h.w.SetLevelForTest(p, 40)
		}
	})
	kill := pos(12, 10)
	far := pos(40, 40) // beyond share_distance (10) and out of view
	want := map[int]int64{2: 5, 3: 10, 4: 15, 5: 20, 6: 20}
	for n := 2; n <= 6; n++ {
		// The first n stand by the kill and fight; the rest wait far away.
		h.do(func(ctx *game.TickContext) {
			for i, p := range ps {
				if i < n {
					h.w.Teleport(p, pos(10+i, 10))
					h.w.ContributeForTest(ctx, p)
				} else {
					h.w.Teleport(p, far)
				}
			}
		})
		for _, cl := range cls {
			cl.take()
		}
		before := make([]int64, 6)
		for i, p := range ps {
			before[i] = p.Experience()
		}
		const xp = 1200
		h.do(func(ctx *game.TickContext) {
			h.w.ShareForTest(ctx, kill, xp, session.Share{P: ps[0], Amount: 1})
		})
		each := xp * (100 + want[n]) / 100 / int64(n)
		bonus := each - xp/int64(n)
		for i, p := range ps {
			got := p.Experience() - before[i]
			switch {
			case i < n && got != each:
				t.Fatalf("%d sharers: sharer %d got %d, want %d", n, i, got, each)
			case i >= n && got != 0:
				t.Fatalf("%d sharers: far member %d got %d", n, i, got)
			}
		}
		own := xpTexts(cls[1].take())
		if len(own) == 0 {
			t.Fatalf("%d sharers: no floating number", n)
		}
		if f := own[len(own)-1]; f.GetAmount() != uint64(each) || f.GetBonus() != uint64(bonus) {
			t.Fatalf("%d sharers: floating %d (+%d), want %d (+%d)", n, f.GetAmount(), f.GetBonus(), each, bonus)
		}
		h.sim.RunTicks(20)
		if up := lastParty(cls[0].take()); up == nil || up.GetBonusPercent() != uint32(want[n]) ||
			up.GetShared() != pb.SharedExperience_SHARED_EXPERIENCE_ACTIVE {
			t.Fatalf("%d sharers: update %v", n, up)
		}
	}
}

// The bonus part travels only to the party: a stranger next to a sharer sees the total.
func TestSharedExperienceBonusOnlyToParty(t *testing.T) {
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	cc, _ := h.join("Cora", at(11, 11)) // not in the party
	h.form(ca, a, member{cb, b})
	h.do(func(ctx *game.TickContext) {
		h.w.ContributeForTest(ctx, a)
		h.w.ContributeForTest(ctx, b)
	})
	ca.take()
	cc.take()
	h.do(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, pos(11, 10), 200, session.Share{P: a, Amount: 1})
	})
	// 200 × 1.05 / 2 = 105, of which 5 is the bonus.
	for _, f := range xpTexts(ca.take()) {
		if f.GetAmount() != 105 || f.GetBonus() != 5 {
			t.Fatalf("member saw %d (+%d)", f.GetAmount(), f.GetBonus())
		}
	}
	got := xpTexts(cc.take())
	if len(got) != 2 {
		t.Fatalf("stranger saw %d floating numbers", len(got))
	}
	for _, f := range got {
		if f.GetAmount() != 105 || f.GetBonus() != 0 {
			t.Fatalf("stranger saw %d (+%d)", f.GetAmount(), f.GetBonus())
		}
	}
	// A kill without a bonus (a solo player's) has none.
	h.do(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, pos(11, 10), 50, session.Share{P: a, Amount: 1})
	})
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_LEAVE, 0))
	h.sim.Step()
	ca.take()
	h.do(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, pos(11, 10), 50, session.Share{P: a, Amount: 1})
	})
	if f := xpTexts(ca.take()); len(f) != 1 || f[0].GetAmount() != 50 || f[0].GetBonus() != 0 {
		t.Fatalf("solo kill: %v", f)
	}
}

// Anti-farming: two characters of one account are one sharer. An alt in the party never
// grows the bonus nor takes a part of the pot (it keeps only what its own damage earned),
// and a party of a character and its alt does not share at all.
func TestSharedExperienceSameAccountAlts(t *testing.T) {
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	nextChar++
	cx, alt := h.joinChar(session.Character{ID: nextChar, AccountID: a.AccountIDForTest(), Name: "Anita",
		Vocation: "guardian", Level: 1, Health: 145, Mana: 20, Pos: *at(11, 10), HasPos: true})
	h.form(ca, a, member{cx, alt})
	h.do(func(ctx *game.TickContext) {
		h.w.ContributeForTest(ctx, a)
		h.w.ContributeForTest(ctx, alt)
	})
	xa, xx := a.Experience(), alt.Experience()
	h.do(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, pos(11, 10), 1000, session.Share{P: a, Amount: 9}, session.Share{P: alt, Amount: 1})
	})
	if da, dx := a.Experience()-xa, alt.Experience()-xx; da != 900 || dx != 100 {
		t.Fatalf("character and alt: %d %d, want 900 100 (no sharing)", da, dx)
	}
	h.sim.RunTicks(20)
	if up := lastParty(ca.take()); up.GetShared() != pb.SharedExperience_SHARED_EXPERIENCE_INACTIVE || up.GetBonusPercent() != 0 {
		t.Fatalf("indicator %v", up)
	}

	// A third player of another account: Ana and Bruno share (+5 %, two sharers, not
	// three); the alt keeps its own damage share and is not marked as sharing.
	cb, b := h.join("Bruno", at(12, 10))
	h.form(ca, a, member{cb, b})
	h.do(func(ctx *game.TickContext) {
		for _, p := range []*session.Player{a, alt, b} {
			h.w.ContributeForTest(ctx, p)
		}
	})
	xa, xx, xb := a.Experience(), alt.Experience(), b.Experience()
	h.do(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, pos(11, 10), 1000, session.Share{P: a, Amount: 8}, session.Share{P: alt, Amount: 1},
			session.Share{P: b, Amount: 1})
	})
	// Pot: 800 + 100 = 900 × 1.05 / 2 = 472 each.
	if da, dx, db := a.Experience()-xa, alt.Experience()-xx, b.Experience()-xb; da != 472 || dx != 100 || db != 472 {
		t.Fatalf("with a third: %d %d %d", da, dx, db)
	}
	h.sim.RunTicks(20)
	up := lastParty(cb.take())
	if up.GetBonusPercent() != 5 {
		t.Fatalf("bonus %d, want 5", up.GetBonusPercent())
	}
	for _, m := range up.GetMembers() {
		if m.GetCreatureId() == alt.ID() && m.GetSharing() {
			t.Fatal("the alt is marked as sharing")
		}
	}
}
