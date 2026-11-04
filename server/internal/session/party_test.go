package session_test

import (
	"slices"
	"testing"

	"google.golang.org/protobuf/reflect/protoreflect"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

func partyCmd(a pb.PartyAction, id uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_PartyCommand{PartyCommand: &pb.PartyCommand{Action: a, CreatureId: id}}}
}

func partyHarness(t *testing.T) *harness {
	t.Helper()
	return newHarness(t, worldtest.Open(t, 0, 0, 64, 64))
}

// lastParty returns the last PartyUpdate in evs, or nil.
func lastParty(evs []*pb.ServerMessage) *pb.PartyUpdate {
	ups := find(evs, (*pb.ServerMessage).GetPartyUpdate)
	if len(ups) == 0 {
		return nil
	}
	return ups[len(ups)-1]
}

type member struct {
	cl *fakeClient
	p  *session.Player
}

// form makes leader invite the others and each accept, one by one.
func (h *harness) form(leader *fakeClient, lp *session.Player, others ...member) {
	h.t.Helper()
	for _, o := range others {
		h.input(leader, partyCmd(pb.PartyAction_PARTY_ACTION_INVITE, o.p.ID()))
		h.sim.Step()
		h.input(o.cl, partyCmd(pb.PartyAction_PARTY_ACTION_ACCEPT, lp.ID()))
		h.sim.Step()
	}
	for _, o := range others {
		if m, _, _ := o.p.PartyForTest(); m == nil {
			h.t.Fatalf("%d did not join", o.p.ID())
		}
	}
}

// do runs fn on the loop in the next tick.
func (h *harness) do(fn func(ctx *game.TickContext)) {
	h.sim.Command(game.CommandFunc(fn))
	h.sim.Step()
}

// A leader invites, the invited player sees the invitation and accepts: both get the
// party. A third joins; the leader passes the lead, the new leader kicks the third, and
// when the first one leaves the party of one is disbanded.
func TestPartyInviteAcceptKickLeaderLeave(t *testing.T) {
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	cc, c := h.join("Cora", at(10, 12))
	ca.take()
	cb.take()
	cc.take()

	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_INVITE, b.ID()))
	h.sim.Step()
	inv := find(cb.take(), (*pb.ServerMessage).GetPartyInvitation)
	if len(inv) != 1 || inv[0].GetInviterId() != a.ID() || inv[0].GetInviterName() != "Ana" || inv[0].GetExpiresMs() != 5000 {
		t.Fatalf("invitation %v", inv)
	}
	if k := systemKeys(ca.take()); k["party.invited"] != 1 {
		t.Fatalf("inviter heard %v", k)
	}
	h.input(cb, partyCmd(pb.PartyAction_PARTY_ACTION_ACCEPT, a.ID()))
	h.sim.Step()
	members, leader, _ := b.PartyForTest()
	if !slices.Equal(members, []uint32{a.ID(), b.ID()}) || leader != a.ID() {
		t.Fatalf("party %v led by %d", members, leader)
	}
	up := lastParty(ca.take())
	if up == nil || up.GetLeaderId() != a.ID() || len(up.GetMembers()) != 2 || up.GetShared() != pb.SharedExperience_SHARED_EXPERIENCE_OFF {
		t.Fatalf("leader's update %v", up)
	}
	if h.w.InvitesForTest() != 0 {
		t.Fatal("accepted invitation still pending")
	}

	h.form(ca, a, member{cc, c})
	if m, _, _ := c.PartyForTest(); len(m) != 3 {
		t.Fatalf("third member: %v", m)
	}
	// Only the leader invites; the party is full at max_members (3).
	cb.take()
	h.input(cb, partyCmd(pb.PartyAction_PARTY_ACTION_KICK, c.ID()))
	h.sim.Step()
	if k := systemKeys(cb.take()); k["party.not_leader"] != 1 {
		t.Fatalf("non-leader kick: %v", k)
	}

	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_PASS_LEADER, b.ID()))
	h.sim.Step()
	if _, l, _ := a.PartyForTest(); l != b.ID() {
		t.Fatalf("leader %d, want %d", l, b.ID())
	}
	cc.take()
	h.input(cb, partyCmd(pb.PartyAction_PARTY_ACTION_KICK, c.ID()))
	h.sim.Step()
	if m, _, _ := c.PartyForTest(); m != nil {
		t.Fatalf("kicked member still in %v", m)
	}
	evs := cc.take()
	if k := systemKeys(evs); k["party.you_were_kicked"] != 1 {
		t.Fatalf("kicked heard %v", k)
	}
	if up := lastParty(evs); up == nil || len(up.GetMembers()) != 0 {
		t.Fatalf("kicked member's last update %v", up)
	}

	cb.take()
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_LEAVE, 0))
	h.sim.Step()
	if m, _, _ := b.PartyForTest(); m != nil {
		t.Fatalf("party of one not disbanded: %v", m)
	}
	if k := systemKeys(cb.take()); k["party.disbanded"] != 1 {
		t.Fatalf("last member heard %v", k)
	}
}

// An invitation expires after party.invite_ms (5 s = 100 ticks of the fake clock): a
// late accept joins nothing. Declining tells the inviter.
func TestPartyInviteExpiresAndDecline(t *testing.T) {
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_INVITE, b.ID()))
	h.sim.RunTicks(101) // the invite runs on the first tick, its expiry 100 ticks later
	if h.w.InvitesForTest() != 0 {
		t.Fatal("expired invitation still pending")
	}
	cb.take()
	h.input(cb, partyCmd(pb.PartyAction_PARTY_ACTION_ACCEPT, a.ID()))
	h.sim.Step()
	if m, _, _ := b.PartyForTest(); m != nil {
		t.Fatalf("joined after expiry: %v", m)
	}
	if k := systemKeys(cb.take()); k["party.invite_gone"] != 1 {
		t.Fatalf("late accept heard %v", k)
	}

	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_INVITE, b.ID()))
	h.sim.RunTicks(99) // one tick before expiry it still works... but declined
	ca.take()
	h.input(cb, partyCmd(pb.PartyAction_PARTY_ACTION_DECLINE, a.ID()))
	h.sim.Step()
	if k := systemKeys(ca.take()); k["party.declined"] != 1 {
		t.Fatalf("inviter heard %v", k)
	}
	if h.w.InvitesForTest() != 0 {
		t.Fatal("declined invitation still pending")
	}
}

// A party is no way to find players: inviting someone out of view (by id or with
// /invite) answers like an unknown name.
func TestPartyInviteNeedsSight(t *testing.T) {
	h := partyHarness(t)
	ca, _ := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(40, 40))
	ca.take()
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_INVITE, b.ID()))
	h.input(ca, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/invite Bruno"))
	h.input(ca, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/invite Nobody"))
	h.sim.Step()
	k := systemKeys(ca.take())
	if k["party.player_not_seen"] != 1 || k["party.player_not_found"] != 2 {
		t.Fatalf("heard %v", k)
	}
	if len(find(cb.take(), (*pb.ServerMessage).GetPartyInvitation)) != 0 || h.w.InvitesForTest() != 0 {
		t.Fatal("an unseen player was invited")
	}
	// In view, /invite works.
	h.join("Cora", at(11, 10))
	h.input(ca, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/invite cora"))
	h.sim.Step()
	if h.w.InvitesForTest() != 1 {
		t.Fatal("/invite did not invite a player in view")
	}
}

// Shared experience splits the pot of the sharers' damage shares equally, plus 6 % per
// sharer beyond the first; off, far away or idle members get nothing of it.
func TestSharedExperience(t *testing.T) {
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	_, c := h.join("Cora", at(40, 40)) // not in the party
	h.form(ca, a, member{cb, b})
	kill := pos(11, 10)
	gain := func(fn func(ctx *game.TickContext)) (int64, int64, int64) {
		xa, xb, xc := a.Experience(), b.Experience(), c.Experience()
		h.do(fn)
		return a.Experience() - xa, b.Experience() - xb, c.Experience() - xc
	}
	both := func(ctx *game.TickContext) {
		h.w.ContributeForTest(ctx, a)
		h.w.ContributeForTest(ctx, b)
	}

	// Off: by damage, as without a party (Cora is outside and keeps her share).
	h.do(both)
	if da, db, dc := gain(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, kill, 100, session.Share{P: a, Amount: 30}, session.Share{P: c, Amount: 10})
	}); da != 75 || db != 0 || dc != 25 {
		t.Fatalf("off: %d %d %d", da, db, dc)
	}

	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_SHARE_ON, 0))
	h.sim.Step()
	if _, _, on := a.PartyForTest(); !on {
		t.Fatal("shared experience not on")
	}
	// On, both near and active: Ana's 75 of 100 → pot 75 × 1.06 = 79 / 2 = 39 each.
	if da, db, dc := gain(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, kill, 100, session.Share{P: a, Amount: 30}, session.Share{P: c, Amount: 10})
	}); da != 39 || db != 39 || dc != 25 {
		t.Fatalf("on: %d %d %d", da, db, dc)
	}
	// Bruno far from the kill (more than share_distance 10): Ana alone, no sharing.
	if da, db, _ := gain(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, pos(30, 10), 100, session.Share{P: a, Amount: 30})
	}); da != 100 || db != 0 {
		t.Fatalf("far: %d %d", da, db)
	}
	// Bruno idle for longer than contribution_ms (60 s): no sharing.
	h.sim.RunTicks(1200)
	h.do(func(ctx *game.TickContext) { h.w.ContributeForTest(ctx, a) })
	if da, db, _ := gain(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, kill, 100, session.Share{P: a, Amount: 30})
	}); da != 100 || db != 0 {
		t.Fatalf("idle: %d %d", da, db)
	}
	// A sharer that did no damage (a healer) still gets its part.
	if da, db, _ := gain(func(ctx *game.TickContext) {
		both(ctx)
		h.w.ShareForTest(ctx, kill, 100, session.Share{P: a, Amount: 30})
	}); da != 53 || db != 53 {
		t.Fatalf("healer: %d %d", da, db)
	}
	// The indicator follows: active while both qualify.
	h.sim.RunTicks(20)
	if up := lastParty(cb.take()); up == nil || up.GetShared() != pb.SharedExperience_SHARED_EXPERIENCE_ACTIVE {
		t.Fatalf("indicator %v", up)
	}
}

// Anti-carry: a member below level_range_pct (70 %) of the highest sharer is left out,
// and a pair that leaves one sharer is no sharing at all: the high level keeps its own
// experience and the low level gets only what its own damage earned.
func TestSharedExperienceAntiCarry(t *testing.T) {
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	cc, c := h.join("Cora", at(11, 11))
	h.form(ca, a, member{cb, b}, member{cc, c})
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_SHARE_ON, 0))
	h.do(func(ctx *game.TickContext) {
		h.w.SetLevelForTest(a, 50)
		h.w.SetLevelForTest(b, 10)
		h.w.SetLevelForTest(c, 34) // 68 % of 50: out
		h.w.ContributeForTest(ctx, a)
		h.w.ContributeForTest(ctx, b)
		h.w.ContributeForTest(ctx, c)
	})
	xa, xb, xc := a.Experience(), b.Experience(), c.Experience()
	h.do(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, pos(11, 10), 1000, session.Share{P: a, Amount: 99}, session.Share{P: b, Amount: 1})
	})
	if da, db, dc := a.Experience()-xa, b.Experience()-xb, c.Experience()-xc; da != 990 || db != 10 || dc != 0 {
		t.Fatalf("carry: %d %d %d", da, db, dc)
	}
	h.sim.RunTicks(20)
	up := lastParty(cb.take())
	if up.GetShared() != pb.SharedExperience_SHARED_EXPERIENCE_INACTIVE {
		t.Fatalf("indicator %v", up.GetShared())
	}
	// Cora at 35 (70 %) shares with Ana: the pot is theirs; Bruno keeps his own share.
	h.do(func(ctx *game.TickContext) { h.w.SetLevelForTest(c, 35) })
	xa, xb, xc = a.Experience(), b.Experience(), c.Experience()
	h.do(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, pos(11, 10), 1000, session.Share{P: a, Amount: 99}, session.Share{P: b, Amount: 1})
	})
	if da, db, dc := a.Experience()-xa, b.Experience()-xb, c.Experience()-xc; da != 524 || db != 10 || dc != 524 {
		t.Fatalf("in range: %d %d %d", da, db, dc) // 990 × 1.06 / 2
	}
}

// A real kill through the combat code: the killer's share goes to the party pot.
func TestSharedExperienceOnKill(t *testing.T) {
	target := &content.Monster{ID: "post", Health: 1, Experience: 28, Speed: 100}
	h := monsterHarness(t, []*content.Monster{target}, spawnAt("post", 20, 20, 0, 60))
	ca, a := h.join("Ana", at(21, 20))
	cb, b := h.join("Bruno", at(23, 22))
	h.form(ca, a, member{cb, b})
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_SHARE_ON, 0))
	h.do(func(ctx *game.TickContext) { h.w.ContributeForTest(ctx, b) })
	post := onlyMonster(t, h)
	h.input(ca, setTarget(post.ID()))
	h.sim.RunUntil(func() bool { return len(h.w.Monsters()) == 0 }, sim.MaxSeconds(60))
	// 28 × 1.06 / 2 = 14 each.
	if a.Experience() != 14 || b.Experience() != 14 {
		t.Fatalf("experience %d %d", a.Experience(), b.Experience())
	}
}

// Leaving the world leaves the party: a leader that disconnects hands it to the oldest
// member; its invitations are dropped.
func TestPartyDisconnect(t *testing.T) {
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	cc, c := h.join("Cora", at(11, 11))
	_, d := h.join("Dario", at(11, 12))
	h.form(ca, a, member{cb, b}, member{cc, c})
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_INVITE, d.ID()))
	h.sim.Step()
	cb.take()
	h.sim.Command(h.w.Leave(ca))
	h.sim.Step()
	members, leader, _ := b.PartyForTest()
	if !slices.Equal(members, []uint32{b.ID(), c.ID()}) || leader != b.ID() {
		t.Fatalf("after leader left: %v led by %d", members, leader)
	}
	evs := cb.take()
	if k := systemKeys(evs); k["party.left"] != 1 || k["party.new_leader"] != 1 {
		t.Fatalf("heard %v", k)
	}
	if up := lastParty(evs); up == nil || up.GetLeaderId() != b.ID() || len(up.GetMembers()) != 2 {
		t.Fatalf("update %v", up)
	}
	if h.w.InvitesForTest() != 0 {
		t.Fatal("the gone leader's invitation is pending")
	}
	h.sim.Command(h.w.Leave(cc))
	h.sim.Step()
	if m, _, _ := b.PartyForTest(); m != nil {
		t.Fatalf("party of one: %v", m)
	}
}

// Information audit (docs/01-architecture.md, "Trampas y anti-bot"): a member sees the
// health and mana of the others only while they are in its view; out of view (or
// invisible) only the island travels. PartyMember has no position field at all.
func TestPartyInfoAudit(t *testing.T) {
	fields := (&pb.PartyMember{}).ProtoReflect().Descriptor().Fields()
	for i := range fields.Len() {
		if f := fields.Get(i); f.Kind() == protoreflect.MessageKind {
			t.Fatalf("PartyMember.%s carries a message (a position?)", f.Name())
		}
	}
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	h.form(ca, a, member{cb, b})
	island := h.w.Map().Islands()[0].ID
	memberOf := func(up *pb.PartyUpdate, id uint32) *pb.PartyMember {
		for _, m := range up.GetMembers() {
			if m.GetCreatureId() == id {
				return m
			}
		}
		t.Fatalf("member %d missing in %v", id, up)
		return nil
	}
	h.sim.RunTicks(20)
	ca.take()
	h.do(func(*game.TickContext) { b.SetHealthForTest(70) })
	h.sim.RunTicks(20)
	bm := memberOf(lastParty(ca.take()), b.ID())
	if !bm.GetInView() || bm.GetHealthPercent() == 0 || bm.GetHealthPercent() == 100 || bm.GetManaPercent() == 0 {
		t.Fatalf("in view: %v", bm)
	}

	// Bruno walks east out of Ana's view (more than 8 tiles).
	for range 10 {
		h.input(cb, walk(pb.Direction_DIRECTION_EAST))
		h.sim.RunTicks(25)
	}
	if b.Pos().X < 20 {
		t.Fatalf("Bruno did not walk away: %v", b.Pos())
	}
	h.sim.RunTicks(20)
	up := lastParty(ca.take())
	if up == nil {
		t.Fatal("no update after Bruno left the view")
	}
	bm = memberOf(up, b.ID())
	if bm.GetInView() || bm.GetHealthPercent() != 0 || bm.GetManaPercent() != 0 || bm.GetIsland() != island ||
		bm.GetLevel() != 1 || bm.GetName() != "Bruno" {
		t.Fatalf("out of view: %v", bm)
	}
	// Bruno's own view of himself keeps everything.
	if me := memberOf(lastParty(cb.take()), b.ID()); !me.GetInView() || me.GetHealthPercent() == 0 {
		t.Fatalf("own view: %v", me)
	}

	// Out of view, Bruno's health changes do not reach Ana at all.
	h.sim.RunTicks(20)
	ca.take()
	h.do(func(*game.TickContext) { b.SetHealthForTest(40) })
	h.sim.RunTicks(40)
	if up := lastParty(ca.take()); up != nil {
		t.Fatalf("a hidden change produced an update: %v", up)
	}
}

// Party chat reaches every member, in view or not, without a position; others never
// hear it, a player without a party is told so, and the chat anti-flood applies.
func TestPartyChat(t *testing.T) {
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	cc, _ := h.join("Cora", at(11, 10)) // next to them, not in the party
	h.form(ca, a, member{cb, b})
	h.do(func(*game.TickContext) { h.w.Teleport(b, pos(50, 50)) })
	cb.take()
	cc.take()
	h.input(ca, say(pb.ChatChannel_CHAT_CHANNEL_PARTY, "hola grupo"))
	h.sim.Step()
	got := find(cb.take(), (*pb.ServerMessage).GetChatMessage)
	if len(got) != 1 || got[0].GetKind() != pb.MessageKind_MESSAGE_KIND_PARTY || got[0].GetText() != "hola grupo" ||
		got[0].GetPos() != nil || got[0].GetSpeakerName() != "Ana" {
		t.Fatalf("member heard %v", got)
	}
	if n := len(find(cc.take(), (*pb.ServerMessage).GetChatMessage)); n != 0 {
		t.Fatalf("outsider heard %d messages", n)
	}
	h.input(cc, say(pb.ChatChannel_CHAT_CHANNEL_PARTY, "hola?"))
	h.sim.Step()
	if k := systemKeys(cc.take()); k["party.none"] != 1 {
		t.Fatalf("outsider heard %v", k)
	}
	ca.take()
	for range 6 {
		h.input(ca, say(pb.ChatChannel_CHAT_CHANNEL_PARTY, "spam"))
	}
	h.sim.Step()
	if k := systemKeys(ca.take()); k["chat.flood"] != 1 {
		t.Fatalf("flood: %v", k)
	}
}

// Audit with shared experience on: a far member's death or fighting does not show in
// its "sharing" flag nor in the indicator (both use only the members the viewer sees).
func TestPartyInfoAuditShared(t *testing.T) {
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	h.form(ca, a, member{cb, b})
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_SHARE_ON, 0))
	h.do(func(ctx *game.TickContext) {
		h.w.ContributeForTest(ctx, a)
		h.w.ContributeForTest(ctx, b)
	})
	h.sim.RunTicks(20)
	if up := lastParty(ca.take()); up.GetShared() != pb.SharedExperience_SHARED_EXPERIENCE_ACTIVE {
		t.Fatalf("in view: %v", up.GetShared())
	}
	h.do(func(*game.TickContext) { h.w.Teleport(b, pos(50, 50)) })
	h.sim.RunTicks(20)
	up := lastParty(ca.take())
	for _, m := range up.GetMembers() {
		if m.GetCreatureId() == b.ID() && (m.GetSharing() || m.GetInView()) {
			t.Fatalf("far member: %v", m)
		}
	}
	if up.GetShared() != pb.SharedExperience_SHARED_EXPERIENCE_INACTIVE {
		t.Fatalf("indicator with the other far: %v", up.GetShared())
	}
	// Bruno fights and then dies far away: Ana hears nothing.
	h.sim.RunTicks(20)
	ca.take()
	h.do(func(ctx *game.TickContext) { h.w.ContributeForTest(ctx, b) })
	h.do(func(*game.TickContext) { b.SetHealthForTest(0) })
	h.sim.RunTicks(40)
	if up := lastParty(ca.take()); up != nil {
		t.Fatalf("a far member's fight or death produced an update: %v", up)
	}
}

// Only the leader hears "you kicked"; the rest hear "left" once. Edge cases: a full
// party, accepting while in a party, a repeated invitation, an old leader's invitation.
func TestPartyKickAndEdges(t *testing.T) {
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	cc, c := h.join("Cora", at(11, 11))
	cd, d := h.join("Dario", at(11, 12))
	h.form(ca, a, member{cb, b}, member{cc, c}) // max_members 3: full
	ca.take()
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_INVITE, d.ID()))
	h.sim.Step()
	if k := systemKeys(ca.take()); k["party.full"] != 1 {
		t.Fatalf("full: %v", k)
	}
	cb.take()
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_KICK, c.ID()))
	h.sim.Step()
	if k := systemKeys(ca.take()); k["party.kicked"] != 1 || k["party.left"] != 1 {
		t.Fatalf("leader heard %v", k)
	}
	if k := systemKeys(cb.take()); k["party.kicked"] != 0 || k["party.left"] != 1 {
		t.Fatalf("member heard %v", k)
	}
	// Repeated invitation; then Dario, in a party of his own, must leave first.
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_INVITE, d.ID()))
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_INVITE, d.ID()))
	h.sim.Step()
	if k := systemKeys(ca.take()); k["party.already_invited"] != 1 {
		t.Fatalf("repeat: %v", k)
	}
	h.form(cc, c, member{cd, d})
	cd.take()
	h.input(cd, partyCmd(pb.PartyAction_PARTY_ACTION_ACCEPT, a.ID()))
	h.sim.Step()
	if k := systemKeys(cd.take()); k["party.leave_first"] != 1 {
		t.Fatalf("in a party: %v", k)
	}
	// An invitation from someone that stopped leading is gone.
	h.input(cd, partyCmd(pb.PartyAction_PARTY_ACTION_LEAVE, 0))
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_PASS_LEADER, b.ID()))
	h.sim.Step()
	cd.take()
	h.input(cd, partyCmd(pb.PartyAction_PARTY_ACTION_ACCEPT, a.ID()))
	h.sim.Step()
	if k := systemKeys(cd.take()); k["party.invite_gone"] != 1 {
		t.Fatalf("old leader's invitation: %v", k)
	}
}

// Two sharing parties on one monster: each pot holds only its own members' shares; a
// member on another floor does not share.
func TestSharedExperienceTwoParties(t *testing.T) {
	h := partyHarness(t)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	cc, c := h.join("Cora", at(11, 11))
	cd, d := h.join("Dario", at(11, 12))
	h.form(ca, a, member{cb, b})
	h.form(cc, c, member{cd, d})
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_SHARE_ON, 0))
	h.input(cc, partyCmd(pb.PartyAction_PARTY_ACTION_SHARE_ON, 0))
	h.do(func(ctx *game.TickContext) {
		for _, p := range []*session.Player{a, b, c, d} {
			h.w.ContributeForTest(ctx, p)
		}
	})
	x := []int64{a.Experience(), b.Experience(), c.Experience(), d.Experience()}
	h.do(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, pos(11, 10), 200, session.Share{P: a, Amount: 50}, session.Share{P: c, Amount: 50})
	})
	// 100 × 1.06 / 2 = 53 for each member of both parties.
	for i, p := range []*session.Player{a, b, c, d} {
		if got := p.Experience() - x[i]; got != 53 {
			t.Fatalf("player %d got %d", i, got)
		}
	}
	h.do(func(*game.TickContext) {
		h.w.Teleport(b, world.Pos{X: 12, Y: 10, Z: 6})
	})
	xa, xb := a.Experience(), b.Experience()
	h.do(func(ctx *game.TickContext) {
		h.w.ShareForTest(ctx, pos(11, 10), 100, session.Share{P: a, Amount: 50})
	})
	if a.Experience()-xa != 100 || b.Experience() != xb {
		t.Fatalf("other floor: %d %d", a.Experience()-xa, b.Experience()-xb)
	}
}
