package session_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/guild"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// guildHarness is an open field with guilds on: every AdminGuild job is recorded (the
// database writes, in order), and copper coins are money (worth 1).
type guildHarness struct {
	*harness
	jobs []session.AdminJob
}

func guildBalance() content.Guild {
	return content.Guild{FoundCost: 100, FoundMinLevel: 2, MaxMembers: 3, MaxViceLeaders: 1, MaxInvites: 2,
		InviteHours: 1, NameMin: 3, NameMax: 24, NameMaxWords: 4, MotdMax: 20,
		ReservedParts: []string{"admin"}, ReservedWords: []string{"gm"}}
}

func newGuildHarness(t *testing.T, data *session.GuildData, opts ...option) *guildHarness {
	t.Helper()
	g := &guildHarness{}
	items := testItems()
	var coin content.Item
	_ = yaml.Unmarshal([]byte("{id: copper_coin, kind: currency, weight: 12, stackable: true, max_stack: 100, currency: {worth: 1}}"), &coin)
	coin.Numeric = coinID
	items["copper_coin"] = &coin
	g.harness = newHarness(t, worldtest.Open(t, 0, 0, 64, 64), func(c *session.Config) {
		c.Items = items
		c.Balance.Guild = guildBalance()
		if data == nil {
			data = &session.GuildData{}
		}
		c.Guilds = data
		c.Admin = func(j session.AdminJob) bool {
			g.jobs = append(g.jobs, j)
			return true
		}
		for _, o := range opts {
			o(c)
		}
	})
	return g
}

// founder joins a character of level lvl with a backpack and coins in it.
func (g *guildHarness) founder(name string, x int, lvl, coins int) (*fakeClient, *session.Player) {
	g.t.Helper()
	nextChar++
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: name, Vocation: "guardian", Level: lvl, Health: 145,
		HasPos: true, Pos: pos(x, 10), Inventory: []session.ItemState{{ItemID: packID, Count: 1, Slot: int(slotBackpack)}}}
	cl, p := g.joinChar(c)
	if coins > 0 {
		g.do(func(*game.TickContext) { g.w.GiveForTest(p, "copper_coin", coins) })
	}
	return cl, p
}

// coinsIn counts the copper coins in a snapshot's inventory, containers included.
func coinsIn(items []session.ItemState) int {
	n := 0
	for _, it := range items {
		if it.ItemID == coinID {
			n += it.Count
		}
		n += coinsIn(it.Items)
	}
	return n
}

func guildCmd(a pb.GuildAction, name, text string, id uint64) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_GuildCommand{GuildCommand: &pb.GuildCommand{
		Action: a, Name: name, Text: text, GuildId: id}}}
}

// send runs one guild command (after the chat flood window refilled) and returns the
// system message keys cl got.
func (g *guildHarness) send(cl *fakeClient, a pb.GuildAction, name, text string, id uint64) []string {
	g.t.Helper()
	g.sim.RunFor(2 * time.Second) // one anti-flood refill
	cl.take()
	g.input(cl, guildCmd(a, name, text, id))
	g.sim.Step()
	evs := cl.take()
	cl.batches = append(cl.batches, &pb.ServerBatch{Events: evs}) // keep them for lastGuild
	return sysKeys(evs)
}

// lastGuild returns the last GuildUpdate cl got (and forgets every event), or nil.
func lastGuild(cl *fakeClient) *pb.GuildUpdate {
	ups := find(cl.take(), (*pb.ServerMessage).GetGuildUpdate)
	if len(ups) == 0 {
		return nil
	}
	return ups[len(ups)-1]
}

// ops returns the ops of the AdminGuild jobs since the last call.
func (g *guildHarness) ops() []session.GuildOp {
	var out []session.GuildOp
	for _, j := range g.jobs {
		if j.Kind == session.AdminGuild {
			out = append(out, j.Guild.Op)
		}
	}
	g.jobs = nil
	return out
}

func members(u *pb.GuildUpdate) []string {
	var out []string
	for _, m := range u.GetMembers() {
		s := m.GetName() + ":" + guild.Rank(m.GetRank()).String()
		if m.GetOnline() {
			s += "+"
		}
		out = append(out, s)
	}
	return out
}

func wantKeys(t *testing.T, got []string, want ...string) {
	t.Helper()
	for _, k := range want {
		if !slices.Contains(got, k) {
			t.Fatalf("keys %v lack %s", got, k)
		}
	}
}

const (
	gCreate   = pb.GuildAction_GUILD_ACTION_CREATE
	gInvite   = pb.GuildAction_GUILD_ACTION_INVITE
	gRevoke   = pb.GuildAction_GUILD_ACTION_REVOKE
	gAccept   = pb.GuildAction_GUILD_ACTION_ACCEPT
	gDecline  = pb.GuildAction_GUILD_ACTION_DECLINE
	gLeave    = pb.GuildAction_GUILD_ACTION_LEAVE
	gKick     = pb.GuildAction_GUILD_ACTION_KICK
	gPromote  = pb.GuildAction_GUILD_ACTION_PROMOTE
	gDemote   = pb.GuildAction_GUILD_ACTION_DEMOTE
	gMotd     = pb.GuildAction_GUILD_ACTION_MOTD
	gDisband  = pb.GuildAction_GUILD_ACTION_DISBAND
	gTransfer = pb.GuildAction_GUILD_ACTION_TRANSFER
)

// The whole life of a guild: found it (gold destroyed, name shown to who sees the
// founder), invite, accept, guild chat, promote, message of the day, decline, transfer,
// leave and disband. Every change reaches the database queue in order.
func TestGuildLifecycle(t *testing.T) {
	g := newGuildHarness(t, nil)
	ca, a := g.founder("Ana", 10, 5, 150)
	cb, b := g.founder("Bruno", 12, 1, 0)
	cc, _ := g.founder("Cora", 14, 1, 0)
	g.ops()

	wantKeys(t, g.send(ca, gCreate, "  Salt   Lanterns ", "", 0), "guild.created")
	if got := g.w.Money(a); got != 50 {
		t.Fatalf("money after founding = %d, want 50", got)
	}
	// The founder is saved right away with the cost paid (not at the next autosave).
	if n := len(g.saves); n == 0 || g.saves[n-1].CharacterID != a.CharacterID() || coinsIn(g.saves[n-1].Inventory) != 50 {
		t.Fatalf("no snapshot of the founder with the cost paid: %+v", g.saves)
	}
	if !slices.ContainsFunc(g.economy, func(e session.EconomyEntry) bool { return e.Kind == session.EconGuild && e.Amount == -100 }) {
		t.Fatalf("no economy entry for the founding cost: %+v", g.economy)
	}
	u := lastGuild(ca)
	if u.GetName() != "Salt Lanterns" || u.GetRank() != pb.GuildRank_GUILD_RANK_LEADER || !slices.Equal(members(u), []string{"Ana:leader+"}) {
		t.Fatalf("founder's update %v", u)
	}
	// Bruno sees Ana: her guild name reaches him.
	cg := find(cb.take(), (*pb.ServerMessage).GetCreatureGuild)
	if len(cg) != 1 || cg[0].GetId() != a.ID() || cg[0].GetGuild() != "Salt Lanterns" {
		t.Fatalf("CreatureGuild to an observer: %v", cg)
	}
	if ops := g.ops(); !slices.Equal(ops, []session.GuildOp{session.GuildCreate}) {
		t.Fatalf("ops %v", ops)
	}

	wantKeys(t, g.send(ca, gInvite, "bruno", "", 0), "guild.invite_sent")
	u = lastGuild(cb)
	if len(u.GetInvitations()) != 1 || u.GetInvitations()[0].GetGuildName() != "Salt Lanterns" ||
		u.GetInvitations()[0].GetExpiresMs() != 3_600_000 {
		t.Fatalf("Bruno's invitation %v", u)
	}
	gid := u.GetInvitations()[0].GetGuildId()
	if pend := lastGuild(ca).GetPending(); len(pend) != 1 || pend[0].GetName() != "Bruno" {
		t.Fatalf("leader's pending invitations %v", pend)
	}
	g.send(cb, gAccept, "", "", gid)
	if u := lastGuild(cb); !slices.Equal(members(u), []string{"Ana:leader+", "Bruno:member+"}) || len(u.GetInvitations()) != 0 {
		t.Fatalf("after accepting: %v", u)
	}
	if ops := g.ops(); !slices.Equal(ops, []session.GuildOp{session.GuildInvite, session.GuildJoin}) {
		t.Fatalf("ops %v", ops)
	}

	// Guild chat: both members hear it, Cora (no guild) does not and cannot speak there.
	ca.take()
	cc.take()
	g.sim.RunFor(2 * time.Second)
	g.speak(cb, pb.ChatChannel_CHAT_CHANNEL_GUILD, "hola gremio")
	heard := find(ca.take(), (*pb.ServerMessage).GetChatMessage)
	if len(heard) != 1 || heard[0].GetKind() != pb.MessageKind_MESSAGE_KIND_GUILD || heard[0].GetText() != "hola gremio" ||
		heard[0].GetPos() != nil {
		t.Fatalf("guild chat heard %v", heard)
	}
	if len(find(cc.take(), (*pb.ServerMessage).GetChatMessage)) != 0 {
		t.Fatal("a non-member heard the guild chat")
	}
	wantKeys(t, sysKeys(g.speak(cc, pb.ChatChannel_CHAT_CHANNEL_GUILD, "x")), "guild.none")

	wantKeys(t, g.send(ca, gPromote, "Bruno", "", 0), "guild.promoted")
	wantKeys(t, g.send(ca, gMotd, "", "  Meet at the   dock ", 0), "guild.motd_changed")
	if u := lastGuild(cb); u.GetMotd() != "Meet at the dock" || u.GetRank() != pb.GuildRank_GUILD_RANK_VICE {
		t.Fatalf("motd / rank %v", u)
	}
	// The vice leader invites Cora; she declines.
	wantKeys(t, g.send(cb, gInvite, "Cora", "", 0), "guild.invite_sent")
	wantKeys(t, g.send(cc, gDecline, "", "", gid), "guild.declined")
	if u := lastGuild(cc); len(u.GetInvitations()) != 0 {
		t.Fatalf("declined invitation still listed %v", u)
	}

	wantKeys(t, g.send(ca, gTransfer, "Bruno", "", 0), "guild.new_leader")
	if m := members(lastGuild(ca)); !slices.Equal(m, []string{"Bruno:leader+", "Ana:vice+"}) {
		t.Fatalf("after transfer %v", m)
	}
	wantKeys(t, g.send(ca, gLeave, "", "", 0), "guild.you_left")
	if u := lastGuild(ca); u.GetGuildId() != 0 {
		t.Fatalf("Ana still in a guild %v", u)
	}
	wantKeys(t, g.send(cb, gDisband, "salt", "", 0), "guild.disband_confirm")
	wantKeys(t, g.send(cb, gDisband, "salt lanterns", "", 0), "guild.disbanded")
	if u := lastGuild(cb); u.GetGuildId() != 0 {
		t.Fatalf("guild survived disband %v", u)
	}
	want := []session.GuildOp{session.GuildRank, session.GuildMotd, session.GuildInvite, session.GuildUninvite,
		session.GuildTransfer, session.GuildRemove, session.GuildDisband}
	if ops := g.ops(); !slices.Equal(ops, want) {
		t.Fatalf("ops %v, want %v", ops, want)
	}
	// The name is free again.
	g.do(func(*game.TickContext) { g.w.GiveForTest(b, "copper_coin", 100) })
	wantKeys(t, g.send(cb, gCreate, "Salt Lanterns", "", 0), "guild.level") // Bruno is level 1
	wantKeys(t, g.send(ca, gCreate, "Salt Lanterns", "", 0), "guild.cost")  // Ana has 50
	g.do(func(*game.TickContext) { g.w.GiveForTest(a, "copper_coin", 50) })
	wantKeys(t, g.send(ca, gCreate, "Salt Lanterns", "", 0), "guild.created")
}

// What each rank may do: members only leave, vice leaders invite, kick members and set
// the message of the day, and only the leader promotes, demotes, transfers and disbands.
// The leader cannot leave.
func TestGuildPermissions(t *testing.T) {
	g := newGuildHarness(t, nil)
	cl, _ := g.founder("Lia", 10, 5, 100)
	cv, _ := g.founder("Vera", 12, 1, 0)
	cm, _ := g.founder("Milo", 14, 1, 0)
	g.send(cl, gCreate, "Iron Wake", "", 0)
	g.send(cl, gInvite, "Vera", "", 0)
	gid := lastGuild(cv).GetInvitations()[0].GetGuildId()
	g.send(cv, gAccept, "", "", gid)
	g.send(cl, gInvite, "Milo", "", 0)
	g.send(cm, gAccept, "", "", gid)
	g.send(cl, gPromote, "Vera", "", 0)

	no := "guild.no_permission"
	wantKeys(t, g.send(cm, gKick, "Vera", "", 0), no)
	wantKeys(t, g.send(cm, gMotd, "", "hi", 0), no)
	wantKeys(t, g.send(cm, gPromote, "Vera", "", 0), no)
	wantKeys(t, g.send(cv, gKick, "Lia", "", 0), no)
	wantKeys(t, g.send(cv, gDemote, "Milo", "", 0), no)
	wantKeys(t, g.send(cl, gDemote, "Milo", "", 0), "guild.same_rank")
	wantKeys(t, g.send(cv, gPromote, "Milo", "", 0), no)
	wantKeys(t, g.send(cv, gTransfer, "Milo", "", 0), no)
	wantKeys(t, g.send(cv, gDisband, "Iron Wake", "", 0), no)
	wantKeys(t, g.send(cl, gLeave, "", "", 0), "guild.leader_cannot_leave")
	wantKeys(t, g.send(cl, gKick, "Nobody", "", 0), "guild.not_a_member")
	wantKeys(t, g.send(cv, gMotd, "", "a message far too long for it", 0), "guild.motd_too_long")
	// Only one vice leader (balance); the vice leader kicks a member.
	g.send(cl, gDemote, "Vera", "", 0)
	g.send(cl, gPromote, "Vera", "", 0)
	wantKeys(t, g.send(cl, gPromote, "Milo", "", 0), "guild.too_many_vices")
	wantKeys(t, g.send(cv, gKick, "milo", "", 0), "guild.kicked")
	if u := lastGuild(cm); u.GetGuildId() != 0 {
		t.Fatalf("kicked member still in %v", u)
	}
	if m := members(lastGuild(cl)); !slices.Equal(m, []string{"Lia:leader+", "Vera:vice+"}) {
		t.Fatalf("members %v", m)
	}
	// Milo comes back; Lia hands the lead to him. Vera holds the only vice slot, so Lia
	// becomes a member, and that is the rank written to the database.
	g.send(cl, gInvite, "Milo", "", 0)
	g.send(cm, gAccept, "", "", gid)
	g.jobs = nil
	wantKeys(t, g.send(cl, gTransfer, "Milo", "", 0), "guild.new_leader")
	if m := members(lastGuild(cl)); !slices.Equal(m, []string{"Milo:leader+", "Vera:vice+", "Lia:member+"}) {
		t.Fatalf("after transfer %v", m)
	}
	if len(g.jobs) != 1 || g.jobs[0].Guild.Op != session.GuildTransfer || g.jobs[0].Guild.Rank != guild.Member {
		t.Fatalf("transfer job %+v", g.jobs)
	}
}

// Founding needs the level and the gold, and a valid free name (any case); a member
// cannot found another guild.
func TestGuildFoundingRules(t *testing.T) {
	g := newGuildHarness(t, nil)
	low, _ := g.founder("Low", 10, 1, 500)
	poor, _ := g.founder("Poor", 12, 5, 99)
	ca, _ := g.founder("Ana", 14, 5, 300)
	wantKeys(t, g.send(low, gCreate, "Valid Name", "", 0), "guild.level")
	wantKeys(t, g.send(poor, gCreate, "Valid Name", "", 0), "guild.cost")
	wantKeys(t, g.send(ca, gCreate, "ab", "", 0), "guild.name_length")
	wantKeys(t, g.send(ca, gCreate, "bad name", "", 0), "guild.name_chars")
	wantKeys(t, g.send(ca, gCreate, "Gm Club", "", 0), "guild.name_reserved")
	wantKeys(t, g.send(ca, gCreate, "Admins Inc", "", 0), "guild.name_reserved")
	wantKeys(t, g.send(ca, gCreate, "Tide Keepers", "", 0), "guild.created")
	g.do(func(*game.TickContext) {}) // nothing pending
	wantKeys(t, g.send(ca, gCreate, "Other Name", "", 0), "guild.already_member")
	g.do(func(*game.TickContext) {})
	nextChar++
	cl2, p2 := g.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Bea", Vocation: "guardian", Level: 5,
		Health: 145, HasPos: true, Pos: pos(16, 10), Inventory: []session.ItemState{{ItemID: packID, Count: 1, Slot: int(slotBackpack)}}})
	g.do(func(*game.TickContext) { g.w.GiveForTest(p2, "copper_coin", 100) })
	wantKeys(t, g.send(cl2, gCreate, "TIDE KEEPERS", "", 0), "guild.name_taken")
	if g.w.Money(p2) != 100 {
		t.Fatal("a refused founding took gold")
	}
}

// Invitations expire by the game clock, are bounded per guild, and a full guild takes
// no one else.
func TestGuildInvitations(t *testing.T) {
	g := newGuildHarness(t, nil)
	ca, _ := g.founder("Ana", 10, 5, 100)
	cb, _ := g.founder("Bruno", 12, 1, 0)
	cc, _ := g.founder("Cora", 14, 1, 0)
	cd, dp := g.founder("Dino", 16, 1, 0)
	g.send(ca, gCreate, "Low Tide", "", 0)
	wantKeys(t, g.send(ca, gInvite, "Ana", "", 0), "guild.self")
	wantKeys(t, g.send(ca, gInvite, "Nadie", "", 0), "guild.player_offline")
	// An invisible player the inviter does not see is offline for this (and gets nothing).
	g.do(func(*game.TickContext) { g.w.SetInvisibleForTest(dp, true) })
	cd.take()
	wantKeys(t, g.send(ca, gInvite, "Dino", "", 0), "guild.player_offline")
	if lastGuild(cd) != nil {
		t.Fatal("an unseen invisible player got an invitation")
	}
	g.do(func(*game.TickContext) { g.w.SetInvisibleForTest(dp, false) })
	g.send(ca, gInvite, "Bruno", "", 0)
	wantKeys(t, g.send(ca, gInvite, "Bruno", "", 0), "guild.already_invited")
	g.send(ca, gInvite, "Cora", "", 0)
	wantKeys(t, g.send(ca, gInvite, "Dino", "", 0), "guild.too_many_invites")
	gid := lastGuild(cb).GetInvitations()[0].GetGuildId()

	// Revoking Cora's frees a slot; Dino is invited.
	wantKeys(t, g.send(ca, gRevoke, "cora", "", 0), "guild.invite_revoked")
	if u := lastGuild(cc); len(u.GetInvitations()) != 0 {
		t.Fatalf("revoked invitation still listed %v", u)
	}
	wantKeys(t, g.send(ca, gInvite, "Dino", "", 0), "guild.invite_sent")
	wantKeys(t, g.send(cc, gAccept, "", "", gid), "guild.invite_gone")

	// An hour later Bruno's invitation is gone; Dino's too.
	g.sim.Clock().Advance(time.Hour)
	wantKeys(t, g.send(cb, gAccept, "", "", gid), "guild.invite_gone")
	if u := lastGuild(cb); len(u.GetInvitations()) != 0 {
		t.Fatalf("expired invitation still listed %v", u)
	}
	// Fill the guild (3 members): the next acceptance is refused.
	g.send(ca, gInvite, "Bruno", "", 0)
	g.send(ca, gInvite, "Cora", "", 0)
	g.send(cb, gAccept, "", "", gid)
	g.send(ca, gInvite, "Dino", "", 0)
	g.send(cc, gAccept, "", "", gid)
	if m := members(lastGuild(cc)); len(m) != 3 {
		t.Fatalf("members %v", m)
	}
	// Dino's invitation was sent before the guild filled: accepting it now is refused.
	wantKeys(t, g.send(cd, gAccept, "", "", gid), "guild.full")
	if u := lastGuild(cd); u.GetGuildId() != 0 {
		t.Fatalf("Dino joined a full guild: %v", u)
	}
	// And a full guild sends no new invitations.
	wantKeys(t, g.send(ca, gRevoke, "Dino", "", 0), "guild.invite_revoked")
	wantKeys(t, g.send(ca, gInvite, "Dino", "", 0), "guild.full")
}

// Guilds loaded at start: an offline member shows offline, the member that logs in is
// shown online to the others and its guild name travels with its creature and in a look.
func TestGuildLoadedOnlineAndLook(t *testing.T) {
	nextChar += 10
	leader, member, invited := nextChar+1, nextChar+2, nextChar+3
	nextChar += 3
	now := time.Unix(0, 0)
	data := &session.GuildData{IDHigh: 11, Guilds: []session.GuildRecord{{ID: 7, Name: "Old Harbor", Motd: "welcome",
		Members: []session.GuildMemberRecord{
			{CharacterID: member, Name: "Mara", Rank: guild.Member, JoinedAt: now.Add(time.Minute)},
			{CharacterID: leader, Name: "Leo", Rank: guild.Leader, JoinedAt: now},
		},
		Invites: []session.GuildInviteRecord{{CharacterID: invited, Name: "Ivo", Expires: time.Date(2200, 1, 1, 0, 0, 0, 0, time.UTC)}},
	}}}
	g := newGuildHarness(t, data)
	ci, _ := g.joinChar(session.Character{ID: invited, AccountID: invited, Name: "Ivo", Vocation: "guardian", Level: 1,
		Health: 145, HasPos: true, Pos: pos(12, 10)})
	evs := ci.take()
	ups := find(evs, (*pb.ServerMessage).GetGuildUpdate)
	if len(ups) != 1 || len(ups[0].GetInvitations()) != 1 || ups[0].GetInvitations()[0].GetGuildId() != 7 {
		t.Fatalf("invited player's update %v", ups)
	}
	cm, m := g.joinChar(session.Character{ID: member, AccountID: member, Name: "Mara", Vocation: "guardian", Level: 3,
		Health: 145, HasPos: true, Pos: pos(10, 10)})
	if u := lastGuild(cm); u.GetGuildId() != 7 || u.GetMotd() != "welcome" ||
		!slices.Equal(members(u), []string{"Leo:leader", "Mara:member+"}) || len(u.GetPending()) != 0 {
		t.Fatalf("member's update %v", u)
	}
	evs = ci.take()
	// Ivo sees Mara with her guild.
	var seen *pb.Creature
	for _, ap := range find(evs, (*pb.ServerMessage).GetCreatureAppear) {
		if c := ap.GetCreature(); c.GetId() == m.ID() {
			seen = c
		}
	}
	if seen == nil || seen.GetGuild() != "Old Harbor" {
		t.Fatalf("Mara's creature as Ivo sees it: %v", seen)
	}
	g.sim.RunFor(2 * time.Second)
	g.input(ci, &pb.ClientMessage{Message: &pb.ClientMessage_LookAt{LookAt: &pb.LookAt{CreatureId: m.ID()}}})
	g.sim.Step()
	looks := find(ci.take(), (*pb.ServerMessage).GetChatMessage)
	if len(looks) != 1 || looks[0].GetLocalized().GetKey() != "look.player_guild" {
		t.Fatalf("look %v", looks)
	}
	params := map[string]string{}
	for _, p := range looks[0].GetLocalized().GetParams() {
		params[p.GetName()] = p.GetText() + p.GetContentId()
	}
	if params["guild"] != "Old Harbor" || params["rank"] != "member" || params["name"] != "Mara" || params["vocation"] != "guardian" {
		t.Fatalf("look params %v", params)
	}
	// The leader logs in: Mara's list shows it online; it logs out: offline again.
	cl, _ := g.joinChar(session.Character{ID: leader, AccountID: leader, Name: "Leo", Vocation: "guardian", Level: 9,
		Health: 145, HasPos: true, Pos: pos(30, 30)})
	if u := lastGuild(cm); !slices.Equal(members(u), []string{"Leo:leader+", "Mara:member+"}) {
		t.Fatalf("after the leader's login %v", members(u))
	}
	if u := lastGuild(cl); len(u.GetPending()) != 1 || u.GetPending()[0].GetName() != "Ivo" {
		t.Fatalf("leader's pending %v", u.GetPending())
	}
	g.sim.Command(g.w.Leave(cl))
	g.sim.Step()
	if u := lastGuild(cm); !slices.Equal(members(u), []string{"Leo:leader", "Mara:member+"}) {
		t.Fatalf("after the leader's logout %v", members(u))
	}
	// A new guild gets the next id after the highest ever issued (11: a disbanded guild's
	// id is never reused).
	cn, _ := g.founder("Nova", 20, 5, 100)
	g.jobs = nil
	g.send(cn, gCreate, "New Dawn", "", 0)
	if len(g.jobs) != 1 || g.jobs[0].Guild.GuildID != 12 {
		t.Fatalf("new guild job %+v", g.jobs)
	}
}

// Chat commands do what GuildCommand does.
func TestGuildChatCommands(t *testing.T) {
	g := newGuildHarness(t, nil)
	ca, _ := g.founder("Ana", 10, 5, 100)
	cb, _ := g.founder("Bruno", 12, 1, 0)
	line := func(cl *fakeClient, text string) []string {
		g.sim.RunFor(2 * time.Second)
		cl.take()
		g.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, text))
		g.sim.Step()
		evs := cl.take()
		cl.batches = append(cl.batches, &pb.ServerBatch{Events: evs})
		return sysKeys(evs)
	}
	wantKeys(t, line(ca, "/guild"), "guild.usage")
	wantKeys(t, line(ca, "/guild create Sea   Wolves"), "guild.created")
	if u := lastGuild(ca); u.GetName() != "Sea Wolves" {
		t.Fatalf("guild %v", u)
	}
	wantKeys(t, line(ca, "/guild invite Bruno"), "guild.invite_sent")
	wantKeys(t, line(cb, "/guild accept sea wolves"), "guild.joined")
	wantKeys(t, line(ca, "/guild motd Hunt at dawn"), "guild.motd_changed")
	wantKeys(t, line(ca, "/guild promote Bruno"), "guild.promoted")
	wantKeys(t, line(ca, "/guild transfer Bruno"), "guild.new_leader")
	wantKeys(t, line(cb, "/guild kick Ana"), "guild.kicked")
	wantKeys(t, line(cb, "/guild disband Sea Wolves"), "guild.disbanded")
	wantKeys(t, line(cb, "/guild frobnicate"), "guild.usage")
}

// GMs rename and disband any guild; both are audited. A player gets command.unknown.
func TestGuildStaffCommands(t *testing.T) {
	g := newGuildHarness(t, nil)
	ca, _ := g.founder("Ana", 10, 5, 100)
	g.send(ca, gCreate, "Bad Taste", "", 0)
	g.ops()
	nextChar++
	cgm, _ := g.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Warden", Vocation: "guardian", Level: 1,
		Health: 145, HasPos: true, Pos: pos(30, 30), Role: session.RoleGM})
	line := func(cl *fakeClient, text string) []string {
		g.sim.RunFor(2 * time.Second)
		cl.take()
		g.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, text))
		g.sim.Step()
		return sysKeys(cl.take())
	}
	wantKeys(t, line(ca, "/guildrename Bad Taste = Fine"), "command.unknown")
	wantKeys(t, line(cgm, "/guildrename Nope = Fine Name"), "gm.guild_not_found")
	wantKeys(t, line(cgm, "/guildrename Bad Taste = Fine Name"), "gm.guild_renamed")
	if u := lastGuild(ca); u.GetName() != "Fine Name" {
		t.Fatalf("renamed guild %v", u)
	}
	var audits []session.AuditEntry
	var ops []session.GuildOp
	for _, j := range g.jobs {
		switch j.Kind {
		case session.AdminAudit:
			audits = append(audits, j.Audit)
		case session.AdminGuild:
			ops = append(ops, j.Guild.Op)
		}
	}
	g.jobs = nil
	if len(audits) != 2 || audits[1].Action != "guild_rename" || audits[1].Result != "ok" || audits[1].Args["name"] != "Fine Name" ||
		audits[0].Result != session.AdminNotFound {
		t.Fatalf("audits %+v", audits)
	}
	if !slices.Equal(ops, []session.GuildOp{session.GuildRename}) {
		t.Fatalf("ops %v", ops)
	}
	wantKeys(t, line(cgm, "/guilddisband fine name"), "gm.guild_disbanded")
	if u := lastGuild(ca); u.GetGuildId() != 0 {
		t.Fatalf("guild survived %v", u)
	}
	var last session.AuditEntry
	for _, j := range g.jobs {
		if j.Kind == session.AdminAudit {
			last = j.Audit
		}
	}
	if last.Action != "guild_disband" || last.Result != "ok" || !strings.EqualFold(last.Args["guild"], "fine name") {
		t.Fatalf("disband audit %+v", last)
	}
}

// Without the database (Config.Guilds nil) guild commands answer guild.unavailable.
func TestGuildsOff(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	cl, _ := h.join("Solo", at(5, 5))
	cl.take()
	h.input(cl, guildCmd(gCreate, "Anything", "", 0))
	h.sim.Step()
	wantKeys(t, sysKeys(cl.take()), "guild.unavailable")
}
