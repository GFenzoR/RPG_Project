package session_test

import (
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// adminHarness is a 40x12 field on floor 7 with a wall column at x 20, and an admin
// queue that records every job (or refuses them while full is set).
type adminHarness struct {
	*harness
	jobs   []session.AdminJob
	checks []session.AdminJob // AdminCheckRoles jobs, kept apart
	full   bool
}

func newAdminHarness(t *testing.T) *adminHarness {
	t.Helper()
	rows := make([]string, 12)
	for i := range rows {
		rows[i] = strings.Repeat(".", 20) + "#" + strings.Repeat(".", 19)
	}
	a := &adminHarness{}
	a.harness = newHarness(t, worldtest.Map(t, 0, 0, 7, rows...), func(c *session.Config) {
		c.Items = testItems()
		c.Admin = func(j session.AdminJob) bool {
			if a.full {
				return false
			}
			if j.Kind == session.AdminCheckRoles {
				a.checks = append(a.checks, j)
				return true
			}
			a.jobs = append(a.jobs, j)
			return true
		}
	})
	return a
}

// joinAs logs in a character of its own account with role at pos.
func (a *adminHarness) joinAs(name string, role session.Role, p world.Pos) (*fakeClient, *session.Player) {
	a.t.Helper()
	nextChar++
	return a.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: name, Vocation: "guardian",
		Level: 1, Health: 145, Mana: 20, HasPos: true, Pos: p, Role: role})
}

// cmd types a chat line and returns the system message keys cl got.
func (a *adminHarness) cmd(cl *fakeClient, line string) []string {
	a.t.Helper()
	cl.take()
	a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, line))
	a.sim.Step()
	return sysKeys(cl.take())
}

// takeJobs returns the jobs submitted since the last call.
func (a *adminHarness) takeJobs() []session.AdminJob {
	j := a.jobs
	a.jobs = nil
	return j
}

func (a *adminHarness) lastAudit(t *testing.T) session.AuditEntry {
	t.Helper()
	js := a.takeJobs()
	if len(js) != 1 {
		t.Fatalf("got %d admin jobs, want 1: %+v", len(js), js)
	}
	return js[0].Audit
}

// A player gets exactly the same answer for an unknown command and for a staff
// command: nothing runs, nothing is audited, and the line is never chat.
func TestCommandsHiddenFromPlayers(t *testing.T) {
	a := newAdminHarness(t)
	pl, p := a.joinAs("Plain", session.RolePlayer, pos(5, 5))
	other, _ := a.joinAs("Other", session.RolePlayer, pos(6, 5))
	start := p.Pos()
	for _, line := range []string{"/frobnicate", "/tp 10 5 7", "/item test_sword", "/kick Other",
		"/ban Other 1d spam", "/unban Other", "/announce hi", "/", "/TP 10 5 7"} {
		if got := a.cmd(pl, line); !slices.Equal(got, []string{"command.unknown"}) {
			t.Errorf("%q: player got %v, want [command.unknown]", line, got)
		}
		if got := heard(other); len(got) > 0 {
			t.Fatalf("%q was said as chat: %v", line, got)
		}
		a.sim.RunTicks(40) // stay under the chat flood limit
	}
	if p.Pos() != start || other.closed || len(a.takeJobs()) != 0 {
		t.Fatalf("a player's command ran: pos %v, kicked %v", p.Pos(), other.closed)
	}

	// A GM gets the same answer for unknown commands and for the admin-only /item.
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(8, 8))
	for _, line := range []string{"/frobnicate", "/item test_sword"} {
		if got := a.cmd(gm, line); !slices.Equal(got, []string{"command.unknown"}) {
			t.Errorf("%q: GM got %v", line, got)
		}
	}
	if js := a.takeJobs(); len(js) != 0 {
		t.Fatalf("refused commands were audited: %+v", js)
	}
}

// Unknown commands count against the chat flood limit like chat does, for everyone.
func TestUnknownCommandsFlood(t *testing.T) {
	a := newAdminHarness(t)
	pl, _ := a.joinAs("Spammer", session.RolePlayer, pos(5, 5))
	var keys []string
	for range 7 {
		keys = append(keys, a.cmd(pl, "/x")...)
	}
	if !slices.Contains(keys, "chat.flood") || !slices.Contains(keys, "chat.muted") {
		t.Fatalf("got %v, want the flood mute", keys)
	}
}

// Without an admin queue nothing could be audited, so staff commands are off.
func TestCommandsNeedAdminQueue(t *testing.T) {
	h := chatMap(t)
	cl, _ := h.joinChar(session.Character{ID: 900, AccountID: 900, Name: "Lonely", Vocation: "guardian", Level: 1,
		Health: 145, HasPos: true, Pos: pos(3, 3), Role: session.RoleAdmin})
	h.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/tp 4 4 7"))
	h.sim.Step()
	if got := sysKeys(cl.take()); !slices.Equal(got, []string{"command.unknown"}) {
		t.Fatalf("got %v", got)
	}
}

func TestTeleport(t *testing.T) {
	a := newAdminHarness(t)
	gm, g := a.joinAs("Warden", session.RoleGM, pos(2, 2))
	_, p := a.joinAs("Lost", session.RolePlayer, pos(30, 6))

	if got := a.cmd(gm, "/tp 10 3 7"); !slices.Equal(got, []string{"gm.teleported"}) || g.Pos() != pos(10, 3) {
		t.Fatalf("/tp x y z: %v at %v", got, g.Pos())
	}
	e := a.lastAudit(t)
	if e.Action != "teleport" || e.Result != "ok" || e.ActorName != "Warden" || e.TargetName != "Warden" ||
		e.Args["x"] != "10" || !e.At.Equal(a.sim.Now().Add(-50*time.Millisecond)) {
		t.Fatalf("audit %+v (now %v)", e, a.sim.Now())
	}

	// Walls, other floors and anything outside the islands are refused.
	for _, line := range []string{"/tp 20 3 7", "/tp 10 3 6", "/tp 500 500 7", "/tp 70000 1 7"} {
		got := a.cmd(gm, line)
		if line == "/tp 70000 1 7" {
			if !slices.Equal(got, []string{"gm.player_offline"}) { // not a position: a name
				t.Errorf("%q: %v", line, got)
			}
		} else if !slices.Equal(got, []string{"gm.bad_position"}) {
			t.Errorf("%q: %v", line, got)
		}
		if g.Pos() != pos(10, 3) {
			t.Fatalf("%q moved the GM to %v", line, g.Pos())
		}
		if e := a.lastAudit(t); e.Result == "ok" {
			t.Fatalf("%q audited as ok", line)
		}
	}

	// To a player (case-insensitive name): the nearest free tile next to them.
	if got := a.cmd(gm, "/tp lost"); !slices.Equal(got, []string{"gm.teleported"}) || chebyshev(g.Pos(), p.Pos()) != 1 {
		t.Fatalf("/tp Name: %v, GM at %v, player at %v", got, g.Pos(), p.Pos())
	}
	if e := a.lastAudit(t); e.Args["to"] != "lost" {
		t.Fatalf("audit of /tp Name %+v", e)
	}
	// Staff of the same or a higher role cannot be moved.
	_, boss := a.joinAs("Boss", session.RoleAdmin, pos(12, 9))
	if got := a.cmd(gm, "/tp Boss 3 3 7"); !slices.Equal(got, []string{"gm.protected"}) || boss.Pos() != pos(12, 9) {
		t.Fatalf("moving an admin: %v, at %v", got, boss.Pos())
	}
	if e := a.lastAudit(t); e.Result != "protected" {
		t.Fatalf("audit %+v", e)
	}
	// Moving a player.
	if got := a.cmd(gm, "/tp Lost 3 9 7"); !slices.Equal(got, []string{"gm.teleported"}) || p.Pos() != pos(3, 9) {
		t.Fatalf("/tp Name x y z: %v, player at %v", got, p.Pos())
	}
	if e := a.lastAudit(t); e.TargetName != "Lost" || e.TargetCharacterID != p.CharacterID() {
		t.Fatalf("audit %+v", e)
	}
	// Onto an occupied tile: next to it.
	a.cmd(gm, "/tp 3 9 7")
	if g.Pos() == p.Pos() || chebyshev(g.Pos(), pos(3, 9)) != 1 {
		t.Fatalf("GM at %v, player at %v", g.Pos(), p.Pos())
	}
	a.takeJobs()
	if got := a.cmd(gm, "/tp"); !slices.Equal(got, []string{"gm.usage"}) {
		t.Fatalf("/tp: %v", got)
	}
	if e := a.lastAudit(t); e.Result != "invalid" || e.Action != "teleport" {
		t.Fatalf("usage audited %+v", e)
	}
	a.checkInvariants()
}

func TestCreateItem(t *testing.T) {
	a := newAdminHarness(t)
	ad, p := a.joinAs("Keeper", session.RoleAdmin, pos(4, 4))
	if got := a.cmd(ad, "/item salve 1"); !slices.Equal(got, []string{"gm.item_unknown"}) {
		t.Fatalf("unknown item: %v", got)
	}
	a.takeJobs()
	for _, line := range []string{"/item test_salve 0", "/item test_salve 101", "/item test_salve -3"} {
		if got := a.cmd(ad, line); !slices.Equal(got, []string{"gm.item_count"}) {
			t.Errorf("%q: %v", line, got)
		}
		if e := a.lastAudit(t); e.Result != "invalid" {
			t.Errorf("%q audit %+v", line, e)
		}
	}
	if got := a.cmd(ad, "/item creature_remains"); !slices.Equal(got, []string{"gm.item_unknown"}) {
		t.Fatalf("a corpse: %v", got)
	}
	a.takeJobs()
	// By content id and by numeric id. Without a backpack it lands under the admin.
	got := a.cmd(ad, "/item test_salve 30")
	if !slices.Contains(got, "gm.item_created") {
		t.Fatalf("create: %v", got)
	}
	if e := a.lastAudit(t); e.Action != "create_item" || e.Args["item"] != "test_salve" || e.Args["count"] != "30" || e.Result != "ok" {
		t.Fatalf("audit %+v", e)
	}
	a.cmd(ad, "/item 68 5")
	ground := a.w.GroundAt(p.Pos())
	n := 0
	for _, it := range ground {
		n += it.Count()
	}
	if len(ground) == 0 || n != 35 {
		t.Fatalf("ground has %d units in %d stacks, want 35", n, len(ground))
	}
}

func TestKick(t *testing.T) {
	a := newAdminHarness(t)
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(2, 2))
	pl, _ := a.joinAs("Rude", session.RolePlayer, pos(5, 5))
	peer, _ := a.joinAs("Peer", session.RoleGM, pos(6, 6))
	boss, _ := a.joinAs("Boss", session.RoleAdmin, pos(7, 7))

	for _, name := range []string{"Peer", "Boss", "Warden"} {
		if got := a.cmd(gm, "/kick "+name); !slices.Equal(got, []string{"gm.protected"}) {
			t.Errorf("kick %s: %v", name, got)
		}
		if e := a.lastAudit(t); e.Result != "protected" {
			t.Errorf("audit %+v", e)
		}
	}
	if peer.closed || boss.closed || gm.closed {
		t.Fatal("staff kicked")
	}
	if got := a.cmd(gm, "/kick Nobody"); !slices.Equal(got, []string{"gm.player_offline"}) {
		t.Fatalf("offline: %v", got)
	}
	a.takeJobs()
	if got := a.cmd(gm, "/kick rude"); !slices.Equal(got, []string{"gm.kicked"}) {
		t.Fatalf("kick: %v", got)
	}
	if !pl.closed || pl.reason != pb.DisconnectReason_DISCONNECT_REASON_KICKED || a.w.Online() != 3 {
		t.Fatalf("closed %v reason %v online %d", pl.closed, pl.reason, a.w.Online())
	}
	if e := a.lastAudit(t); e.Action != "kick" || e.TargetName != "Rude" || e.Result != "ok" {
		t.Fatalf("audit %+v", e)
	}
	if len(a.saves) == 0 || !a.saves[len(a.saves)-1].Final {
		t.Fatal("the kicked player was not saved")
	}
}

func TestBan(t *testing.T) {
	a := newAdminHarness(t)
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(2, 2))
	ad, _ := a.joinAs("Keeper", session.RoleAdmin, pos(3, 3))
	pl, p := a.joinAs("Cheater", session.RolePlayer, pos(5, 5))

	// Argument checks, before anything reaches the database.
	for line, want := range map[string]string{
		"/ban Cheater":                "gm.usage",
		"/ban Cheater 1d":             "gm.usage",
		"/ban 1d spam":                "gm.usage",
		"/ban Cheater perm botting":   "gm.ban_duration", // GMs cannot ban permanently
		"/ban Cheater 31d botting":    "gm.ban_duration",
		"/ban Cheater 0m botting":     "gm.ban_duration",
		"/ban Cheater 99999d botting": "gm.ban_duration",
		"/ban Cheater 1d " + strings.Repeat("x", session.MaxBanReason+1): "gm.ban_reason",
	} {
		if got := a.cmd(gm, line); !slices.Equal(got, []string{want}) {
			t.Errorf("%q: %v, want %s", line, got, want)
		}
		a.sim.RunTicks(20)
	}
	for _, j := range a.takeJobs() {
		if j.Kind != session.AdminAudit || j.Audit.Result != "invalid" {
			t.Fatalf("invalid ban submitted %+v", j)
		}
	}

	if got := a.cmd(gm, "/ban Cheater 7d speed  hack"); len(got) != 0 {
		t.Fatalf("ban answered before the database: %v", got)
	}
	js := a.takeJobs()
	if len(js) != 1 {
		t.Fatalf("jobs %+v", js)
	}
	j := js[0]
	at := a.sim.Now().Add(-50 * time.Millisecond)
	if j.Kind != session.AdminBan || j.TargetName != "Cheater" || j.Reason != "speed hack" || j.ActorRole != session.RoleGM ||
		!j.Until.Equal(at.Add(7*24*time.Hour)) || j.Audit.Action != "ban" || j.Audit.Args["duration"] != "7d" {
		t.Fatalf("job %+v", j)
	}

	// The database answers: the player is disconnected with BANNED and the GM told.
	a.sim.Command(a.w.AdminDone(session.AdminResult{ID: j.ID, Result: session.AdminOK, AccountID: p.CharacterID(), Name: "Cheater"}))
	a.sim.Step()
	if !pl.closed || pl.reason != pb.DisconnectReason_DISCONNECT_REASON_BANNED {
		t.Fatalf("banned player: closed %v reason %v", pl.closed, pl.reason)
	}
	if got := sysKeys(gm.take()); !slices.Equal(got, []string{"gm.banned"}) {
		t.Fatalf("GM got %v", got)
	}
	// A login that read the database before the ban is refused too.
	again := &fakeClient{}
	a.sim.Command(a.w.Join(session.Character{ID: p.CharacterID(), AccountID: p.CharacterID(), Name: "Cheater",
		Vocation: "guardian", Level: 1, Health: 145}, again))
	a.sim.Step()
	if !again.closed || again.reason != pb.DisconnectReason_DISCONNECT_REASON_BANNED || a.w.PlayerByCharacter(p.CharacterID()) != nil {
		t.Fatalf("re-login: closed %v reason %v", again.closed, again.reason)
	}

	// Unban (admin), then the account plays again.
	a.cmd(ad, "/unban Cheater")
	js = a.takeJobs()
	if len(js) != 1 || js[0].Kind != session.AdminUnban || js[0].TargetName != "Cheater" || js[0].ActorRole != session.RoleAdmin {
		t.Fatalf("unban jobs %+v", js)
	}
	a.sim.Command(a.w.AdminDone(session.AdminResult{ID: js[0].ID, Result: session.AdminOK, AccountID: p.CharacterID(), Name: "Cheater"}))
	a.sim.Step()
	if got := sysKeys(ad.take()); !slices.Equal(got, []string{"gm.unbanned"}) {
		t.Fatalf("admin got %v", got)
	}
	back := &fakeClient{}
	a.sim.Command(a.w.Join(session.Character{ID: p.CharacterID(), AccountID: p.CharacterID(), Name: "Cheater",
		Vocation: "guardian", Level: 1, Health: 145}, back))
	a.sim.Step()
	if back.closed {
		t.Fatal("unbanned account refused")
	}

	// Admins ban permanently; the other answers of the database reach the GM.
	a.cmd(ad, "/ban Cheater perm botting")
	js = a.takeJobs()
	if len(js) != 1 || !js[0].Until.IsZero() {
		t.Fatalf("permanent ban jobs %+v", js)
	}
	for res, want := range map[string]string{session.AdminNotFound: "gm.player_not_found", session.AdminProtected: "gm.protected",
		session.AdminNotBanned: "gm.not_banned", session.AdminFailed: "gm.failed"} {
		a.cmd(gm, "/unban Somebody")
		j := a.takeJobs()[0]
		a.sim.Command(a.w.AdminDone(session.AdminResult{ID: j.ID, Result: res, Name: "Somebody"}))
		a.sim.Step()
		if got := sysKeys(gm.take()); !slices.Equal(got, []string{want}) {
			t.Errorf("%s: GM got %v", res, got)
		}
	}
	// An unknown or repeated answer is ignored.
	a.sim.Command(a.w.AdminDone(session.AdminResult{ID: 9999, Result: session.AdminOK, AccountID: 1}))
	a.sim.Step()
}

// A timed ban the World applied ends on its own.
func TestBanExpires(t *testing.T) {
	a := newAdminHarness(t)
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(2, 2))
	_, p := a.joinAs("Brief", session.RolePlayer, pos(5, 5))
	a.cmd(gm, "/ban Brief 1m flooding")
	j := a.takeJobs()[0]
	a.sim.Command(a.w.AdminDone(session.AdminResult{ID: j.ID, Result: session.AdminOK, AccountID: p.CharacterID(), Name: "Brief"}))
	a.sim.Step()
	c := session.Character{ID: p.CharacterID(), AccountID: p.CharacterID(), Name: "Brief", Vocation: "guardian", Level: 1, Health: 145}
	early := &fakeClient{}
	a.sim.Command(a.w.Join(c, early))
	a.sim.Step()
	if !early.closed {
		t.Fatal("joined during the ban")
	}
	a.sim.RunFor(time.Minute)
	late := &fakeClient{}
	a.sim.Command(a.w.Join(c, late))
	a.sim.Step()
	if late.closed || a.w.PlayerByCharacter(p.CharacterID()) == nil {
		t.Fatal("refused after the ban")
	}
}

func TestAnnounce(t *testing.T) {
	a := newAdminHarness(t)
	gm, g := a.joinAs("Warden", session.RoleGM, pos(2, 2))
	far, _ := a.joinAs("Far", session.RolePlayer, pos(35, 10)) // beyond any chat range
	gm.take()
	far.take()
	a.input(gm, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/announce Server restart in 5 minutes"))
	a.sim.Step()
	for _, cl := range []*fakeClient{gm, far} {
		ms := find(cl.take(), (*pb.ServerMessage).GetChatMessage)
		if len(ms) != 1 || ms[0].GetKind() != pb.MessageKind_MESSAGE_KIND_BROADCAST ||
			ms[0].GetText() != "Server restart in 5 minutes" || ms[0].GetSpeakerName() != "Warden" ||
			ms[0].GetSpeakerId() != g.ID() || ms[0].GetPos() != nil {
			t.Fatalf("got %v", ms)
		}
	}
	if e := a.lastAudit(t); e.Action != "announce" || e.Args["text"] != "Server restart in 5 minutes" {
		t.Fatalf("audit %+v", e)
	}
	if got := a.cmd(gm, "/announce"); !slices.Equal(got, []string{"gm.usage"}) {
		t.Fatalf("empty: %v", got)
	}
}

// Staff commands have their own rate limit; refused ones are not audited.
func TestCommandRateLimit(t *testing.T) {
	a := newAdminHarness(t)
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(2, 2))
	for i := range 12 {
		a.input(gm, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/tp "+itoa(3+i%5)+" 3 7"))
	}
	a.sim.Step()
	keys := sysKeys(gm.take())
	if n := count(keys, "command.too_fast"); n != 2 || count(keys, "gm.teleported") != 10 {
		t.Fatalf("got %v", keys)
	}
	if js := a.takeJobs(); len(js) != 10 {
		t.Fatalf("%d audit entries, want 10", len(js))
	}
	a.sim.RunFor(time.Second)
	if got := a.cmd(gm, "/tp 9 9 7"); !slices.Equal(got, []string{"gm.teleported"}) {
		t.Fatalf("after a second: %v", got)
	}
}

// A full admin queue never loses an audit entry: the jobs wait, in order.
func TestAuditQueueFull(t *testing.T) {
	a := newAdminHarness(t)
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(2, 2))
	a.full = true
	a.cmd(gm, "/tp 3 3 7")
	a.cmd(gm, "/announce one")
	a.full = false
	a.sim.Step()
	js := a.takeJobs()
	if len(js) != 2 || js[0].Audit.Action != "teleport" || js[1].Audit.Action != "announce" {
		t.Fatalf("jobs %+v", js)
	}
}

func count(s []string, v string) int {
	n := 0
	for _, x := range s {
		if x == v {
			n++
		}
	}
	return n
}

func itoa(v int) string { return strconv.Itoa(v) }

// A role taken away in the database reaches an online character: after RolesChanged
// its staff commands answer like unknown ones, and lower staff can kick it.
func TestRoleRevokedOnline(t *testing.T) {
	a := newAdminHarness(t)
	thief, th := a.joinAs("Keeper", session.RoleAdmin, pos(4, 4))
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(8, 8))
	if got := a.cmd(thief, "/item test_salve 100"); !slices.Contains(got, "gm.item_created") {
		t.Fatalf("admin /item: %v", got)
	}
	if got := a.cmd(gm, "/kick Keeper"); !slices.Equal(got, []string{"gm.protected"}) {
		t.Fatalf("GM kicking an admin: %v", got)
	}
	a.takeJobs()

	// A role is only ever lowered online; a missing account counts as a player.
	a.sim.Command(a.w.RolesChanged(map[int64]session.Role{th.CharacterID(): session.RolePlayer}))
	a.sim.Step()
	for _, line := range []string{"/item test_salve 100", "/tp 5 5 7", "/announce hi"} {
		if got := a.cmd(thief, line); !slices.Equal(got, []string{"command.unknown"}) {
			t.Errorf("%q after the demotion: %v", line, got)
		}
		a.sim.RunTicks(40)
	}
	if js := a.takeJobs(); len(js) != 0 {
		t.Fatalf("a demoted admin's commands ran: %+v", js)
	}
	if got := a.cmd(gm, "/kick Keeper"); !slices.Equal(got, []string{"gm.kicked"}) || !thief.closed {
		t.Fatalf("GM kicking the demoted admin: %v", got)
	}

	// RolesChanged never raises a role.
	_, pl := a.joinAs("Plain", session.RolePlayer, pos(10, 10))
	a.sim.Command(a.w.RolesChanged(map[int64]session.Role{pl.CharacterID(): session.RoleAdmin}))
	a.sim.Step()
	if got := a.cmd(gm, "/kick Plain"); !slices.Equal(got, []string{"gm.kicked"}) {
		t.Fatalf("a raised role took effect online: %v", got)
	}
}

// Every RoleCheckEvery ticks (by the injected clock's ticks) the World asks for the
// roles of the online staff, and only of them.
func TestRoleCheckCycle(t *testing.T) {
	a := newAdminHarness(t)
	_, ad := a.joinAs("Keeper", session.RoleAdmin, pos(4, 4))
	a.joinAs("Plain", session.RolePlayer, pos(6, 6))
	_, gm := a.joinAs("Warden", session.RoleGM, pos(8, 8))
	a.checks = nil
	a.sim.RunTicks(int(session.RoleCheckEvery) * 3)
	if len(a.checks) != 3 {
		t.Fatalf("%d role checks in 3 intervals, want 3", len(a.checks))
	}
	for _, j := range a.checks {
		if !slices.Equal(j.Accounts, []int64{ad.CharacterID(), gm.CharacterID()}) {
			t.Fatalf("checked accounts %v", j.Accounts)
		}
	}
	// No staff online: nothing to ask.
	b := newAdminHarness(t)
	b.joinAs("Plain", session.RolePlayer, pos(6, 6))
	b.sim.RunTicks(int(session.RoleCheckEvery) * 2)
	if len(b.checks) != 0 {
		t.Fatalf("role checks without staff: %+v", b.checks)
	}
}

// Grounds are tiles, not items: /item refuses them like an unknown item.
func TestCreateItemRefusesGround(t *testing.T) {
	a := newAdminHarness(t)
	ad, p := a.joinAs("Keeper", session.RoleAdmin, pos(4, 4))
	for _, line := range []string{"/item test_water 50", "/item 90 5", "/item grass"} {
		if got := a.cmd(ad, line); !slices.Equal(got, []string{"gm.item_unknown"}) {
			t.Errorf("%q: %v", line, got)
		}
	}
	if g := a.w.GroundAt(p.Pos()); len(g) != 0 {
		t.Fatalf("ground items created: %d", len(g))
	}
}
