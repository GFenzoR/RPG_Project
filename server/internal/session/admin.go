package session

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Staff commands (T2.6, docs/02-game-design.md "Moderación"). A chat line that starts
// with "/" is a command and never chat. The server checks the role of the player's
// account on every command: the client decides nothing. Everything runs on the loop;
// the audit log and bans reach the database through Config.Admin, outside the tick.

// Role is the role of a player's account, loaded at login (accounts.role). Changing it
// in the database takes effect on the next login.
type Role uint8

// Roles, from least to most privileged.
const (
	RolePlayer Role = iota
	RoleGM
	RoleAdmin
)

// AuditEntry is one row of the audit log, built on the loop. At is the tick's time
// (the injected clock).
type AuditEntry struct {
	At                time.Time
	ActorAccountID    int64
	ActorCharacterID  int64
	ActorName         string
	Action            string
	TargetAccountID   int64
	TargetCharacterID int64
	TargetName        string
	Args              map[string]string
	Result            string
}

// AdminJobKind says what an AdminJob asks the database for.
type AdminJobKind uint8

// Admin job kinds.
const (
	// AdminAudit writes Audit. Nothing is reported back.
	AdminAudit AdminJobKind = iota
	// AdminBan bans the account of the character TargetName until Until (zero =
	// permanent), revokes its tokens and writes Audit with the result, in one
	// transaction. The result comes back through World.AdminDone.
	AdminBan
	// AdminUnban lifts the bans of the account of TargetName and writes Audit.
	AdminUnban
	// AdminCheckRoles reads the current role of Accounts (online staff) and answers
	// through World.RolesChanged. Not audited.
	AdminCheckRoles
	// AdminReport stores Report in the report queue and writes Audit (T4.1). Nothing
	// is reported back.
	AdminReport
	// AdminListReports reads the oldest open reports and writes Audit; the result
	// (AdminResult.Reports) comes back through World.AdminDone.
	AdminListReports
	// AdminCloseReport closes the open report ReportID with the resolution Reason and
	// writes Audit with the result, in one transaction; World.AdminDone answers.
	AdminCloseReport
	// AdminGuild writes the guild change Guild (T5.1). Nothing is reported back: the
	// loop already applied it.
	AdminGuild
)

// AdminJob is work for the admin goroutine (the audit log and bans, docs/01).
type AdminJob struct {
	ID         uint64
	Kind       AdminJobKind
	Audit      AuditEntry
	TargetName string
	ActorRole  Role
	Reason     string
	Until      time.Time
	// Accounts are the accounts of an AdminCheckRoles job.
	Accounts []int64
	// Report is the new report of an AdminReport job; ReportID the report an
	// AdminCloseReport closes.
	Report   *ReportJob
	ReportID int64
	// Guild is the change of an AdminGuild job.
	Guild *GuildChange
}

// Results of an AdminBan or AdminUnban (AdminResult.Result).
const (
	AdminOK        = "ok"
	AdminNotFound  = "not_found"
	AdminProtected = "protected"
	AdminNotBanned = "not_banned"
	AdminFailed    = "error"
)

// AdminResult is the outcome of an AdminBan or AdminUnban job.
type AdminResult struct {
	ID        uint64
	Result    string
	AccountID int64
	Name      string
	// Reports are the open reports of an AdminListReports; ReportID the report of an
	// AdminCloseReport.
	Reports  []ReportSummary
	ReportID int64
}

// Limits of the commands.
const (
	// MaxItemCount is the most units one /item creates.
	MaxItemCount = 100
	// MaxBanReason is the longest ban reason, in characters (account_bans.reason).
	MaxBanReason = 200
	// GMMaxBan is the longest ban a GM may give; admins may also ban permanently.
	GMMaxBan = 30 * 24 * time.Hour
	// AdminMaxBan is the longest timed ban.
	AdminMaxBan = 3650 * 24 * time.Hour
	// Staff command rate: a burst of cmdBurst, then one per cmdRefill.
	cmdBurst  = 10
	cmdRefill = game.Tick(1000 / 50) // 1 s
	// RoleCheckEvery is how often the roles of online staff are read again from the
	// database (5 s): a role taken away with set-role is lost within that time even if
	// the character stays connected.
	RoleCheckEvery = game.Tick(5000 / 50)
)

// Message keys of the commands.
const (
	msgCommandUnknown = "command.unknown"
	msgCommandTooFast = "command.too_fast"
	msgGMUsage        = "gm.usage"
	msgGMOffline      = "gm.player_offline"
	msgGMNotFound     = "gm.player_not_found"
	msgGMBadPosition  = "gm.bad_position"
	msgGMTeleported   = "gm.teleported"
	msgGMItemUnknown  = "gm.item_unknown"
	msgGMItemCount    = "gm.item_count"
	msgGMItemCreated  = "gm.item_created"
	msgGMProtected    = "gm.protected"
	msgGMKicked       = "gm.kicked"
	msgGMBanDuration  = "gm.ban_duration"
	msgGMBanReason    = "gm.ban_reason"
	msgGMBanned       = "gm.banned"
	msgGMUnbanned     = "gm.unbanned"
	msgGMNotBanned    = "gm.not_banned"
	msgGMFailed       = "gm.failed"
)

// Audit results written by the loop (the database writes the ban results).
const (
	auditOK      = "ok"
	auditInvalid = "invalid"
	auditOffline = "offline"
)

type gmCommand struct {
	min    Role
	action string // audit_log.action
	usage  string // command syntax, shown as is (not prose: never translated)
	run    func(w *World, ctx *game.TickContext, p *Player, args []string) bool
}

// gmCommands are the staff commands by name. run returns false to show the usage.
var gmCommands = map[string]gmCommand{
	"tp":       {RoleGM, "teleport", "/tp x y z | /tp Name | /tp Name x y z", (*World).cmdTeleport},
	"item":     {RoleAdmin, "create_item", "/item id [count]", (*World).cmdItem},
	"kick":     {RoleGM, "kick", "/kick Name", (*World).cmdKick},
	"ban":      {RoleGM, "ban", "/ban Name 30m|12h|7d|perm reason", (*World).cmdBan},
	"unban":    {RoleGM, "unban", "/unban Name", (*World).cmdUnban},
	"announce": {RoleGM, "announce", "/announce text", (*World).cmdAnnounce},
	// Player reports (T4.1).
	"reports":     {RoleGM, "list_reports", "/reports", (*World).cmdReports},
	"closereport": {RoleGM, "close_report", "/closereport id resolution", (*World).cmdCloseReport},
	// Bot detection (T4.1).
	"presence": {RoleGM, "presence_request", "/presence Name", (*World).cmdPresence},
	// Guilds (T5.1).
	"guildrename":  {RoleGM, "guild_rename", "/guildrename Old Name = New Name", (*World).cmdGuildRename},
	"guilddisband": {RoleGM, "guild_disband", "/guilddisband Name", (*World).cmdGuildDisband},
}

// command runs a chat line that starts with "/". An unknown command and one the
// player's role does not allow get the same answer, after the same chat flood check, so
// a player cannot discover the staff commands. Commands are disabled without
// Config.Admin (nothing could be audited).
func (w *World) command(ctx *game.TickContext, p *Player, line string) {
	fields := strings.Fields(strings.TrimPrefix(line, "/"))
	var name string
	if len(fields) > 0 {
		name = strings.ToLower(fields[0])
	}
	switch name { // player commands
	case "invite": // T3.3
		w.cmdInvite(ctx, p, fields[1:])
		return
	case "report": // T4.1
		w.cmdReport(ctx, p, fields[1:])
		return
	case "guild": // T5.1
		w.cmdGuild(ctx, p, fields[1:])
		return
	}
	cmd, ok := gmCommands[name]
	if !ok || p.role < cmd.min || w.cfg.Admin == nil {
		if w.chatAllowed(ctx, p) {
			p.emit(systemMsg(msgCommandUnknown))
		}
		return
	}
	// GCRA like the chat flood limit: bounds what a stolen staff account can do in a
	// burst and how fast it can fill the audit log. Refused commands are not audited.
	now := ctx.Tick
	tat := max(p.cmdTAT, now)
	if tat-now > cmdRefill*(cmdBurst-1) {
		p.emit(systemMsg(msgCommandTooFast))
		return
	}
	p.cmdTAT = tat + cmdRefill
	if !cmd.run(w, ctx, p, fields[1:]) {
		p.emit(systemMsg(msgGMUsage, textParam("usage", cmd.usage)))
		w.audit(ctx, p, cmd.action, nil, map[string]string{"args": strings.Join(fields[1:], " ")}, auditInvalid)
	}
}

// ---- commands -----------------------------------------------------------------

// cmdTeleport: "/tp x y z" moves p, "/tp Name" moves p next to that player and
// "/tp Name x y z" moves that player. The destination must be a walkable tile of an
// island (Map.Walkable is false outside the islands); if it is taken, the nearest free
// tile within 2.
func (w *World) cmdTeleport(ctx *game.TickContext, p *Player, args []string) bool {
	mover, nameArgs := p, args
	var dest world.Pos
	hasPos := false
	if n := len(args); n >= 3 {
		if pos, ok := parsePos(args[n-3:]); ok {
			dest, hasPos, nameArgs = pos, true, args[:n-3]
		}
	}
	if len(nameArgs) > 0 {
		target := w.onlineByName(strings.Join(nameArgs, " "))
		if target == nil {
			p.emit(systemMsg(msgGMOffline, textParam("name", strings.Join(nameArgs, " "))))
			w.audit(ctx, p, "teleport", nil, map[string]string{"target": strings.Join(nameArgs, " ")}, auditOffline)
			return true
		}
		if hasPos {
			if target != p && target.role >= p.role {
				p.emit(systemMsg(msgGMProtected, textParam("name", target.name)))
				w.audit(ctx, p, "teleport", target, nil, AdminProtected)
				return true
			}
			mover = target
		} else {
			if target == p {
				return false
			}
			dest, hasPos = target.pos, true
		}
	}
	if !hasPos {
		return false
	}
	args2 := map[string]string{"x": itoa(int(dest.X)), "y": itoa(int(dest.Y)), "z": itoa(int(dest.Z))}
	if mover == p && len(nameArgs) > 0 {
		args2["to"] = strings.Join(nameArgs, " ") // went to that player
	}
	to, ok := dest, mover.pos == dest
	if !ok && w.m.Walkable(dest) {
		to, ok = w.freeNear(dest, 2)
	}
	if !ok {
		p.emit(systemMsg(msgGMBadPosition, num("x", int(dest.X)), num("y", int(dest.Y)), num("z", int(dest.Z))))
		w.audit(ctx, p, "teleport", mover, args2, auditInvalid)
		return true
	}
	if to != mover.pos {
		w.Teleport(mover, to)
	}
	p.emit(systemMsg(msgGMTeleported, textParam("name", mover.name), num("x", int(to.X)), num("y", int(to.Y)), num("z", int(to.Z))))
	w.audit(ctx, p, "teleport", mover, args2, auditOK)
	return true
}

// cmdItem: "/item id [count]" creates count (1..MaxItemCount) units of an item of
// data/items, by content id or numeric id, in p's backpack (on the floor if it does not
// fit). Grounds (tiles) and items that never leave their tile cannot be created.
func (w *World) cmdItem(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) < 1 || len(args) > 2 {
		return false
	}
	def := w.cfg.Items[args[0]]
	if def == nil {
		if n, err := strconv.Atoi(args[0]); err == nil && n > 0 && n <= 0xFFFF {
			def = w.byNum[uint16(n)]
		}
	}
	count := 1
	if len(args) == 2 {
		n, err := strconv.Atoi(args[1])
		if err != nil {
			return false
		}
		count = n
	}
	auditArgs := map[string]string{"item": args[0], "count": itoa(count)}
	switch {
	case def == nil || !def.CanPickUp() || def.Kind == "ground":
		p.emit(systemMsg(msgGMItemUnknown, textParam("id", args[0])))
		w.audit(ctx, p, "create_item", nil, auditArgs, auditInvalid)
		return true
	case count < 1 || count > MaxItemCount:
		p.emit(systemMsg(msgGMItemCount, num("max", MaxItemCount)))
		w.audit(ctx, p, "create_item", nil, auditArgs, auditInvalid)
		return true
	}
	auditArgs["item"] = def.ID
	w.giveItem(p, def, count)
	w.econItem(p, EconGM, "", def, count)
	p.emit(systemMsg(msgGMItemCreated, itemParam(def, count)))
	w.audit(ctx, p, "create_item", nil, auditArgs, auditOK)
	return true
}

// cmdKick: "/kick Name" disconnects an online player with KICKED. Staff of the same or
// a higher role cannot be kicked.
func (w *World) cmdKick(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) == 0 {
		return false
	}
	name := strings.Join(args, " ")
	target := w.onlineByName(name)
	switch {
	case target == nil:
		p.emit(systemMsg(msgGMOffline, textParam("name", name)))
		w.audit(ctx, p, "kick", nil, map[string]string{"target": name}, auditOffline)
	case target.role >= p.role:
		p.emit(systemMsg(msgGMProtected, textParam("name", target.name)))
		w.audit(ctx, p, "kick", target, nil, AdminProtected)
	default:
		w.remove(ctx, target, pb.DisconnectReason_DISCONNECT_REASON_KICKED, false)
		p.emit(systemMsg(msgGMKicked, textParam("name", target.name)))
		w.audit(ctx, p, "kick", target, nil, auditOK)
	}
	return true
}

// banDuration matches 30m, 12h, 7d. "perm" is the permanent ban. Character names are
// capitalized words of letters, so neither can be part of a name.
var banDuration = regexp.MustCompile(`^([0-9]{1,5})([mhd])$`)

// cmdBan: "/ban Name 7d reason" bans the account of a character, online or not. GMs ban
// up to GMMaxBan; admins also permanently. The database checks the target's role (only
// lower roles) and writes the audit entry with the ban; AdminDone reports back.
func (w *World) cmdBan(ctx *game.TickContext, p *Player, args []string) bool {
	at := -1
	for i, a := range args {
		if a == "perm" || banDuration.MatchString(a) {
			at = i
			break
		}
	}
	if at <= 0 || at == len(args)-1 {
		return false
	}
	name := strings.Join(args[:at], " ")
	reason := cleanChat(strings.Join(args[at+1:], " "))
	var dur time.Duration
	if args[at] != "perm" {
		m := banDuration.FindStringSubmatch(args[at])
		n, _ := strconv.Atoi(m[1])
		dur = time.Duration(n) * time.Minute
		switch m[2] {
		case "h":
			dur *= 60
		case "d":
			dur *= 24 * 60
		}
	}
	maxBan := GMMaxBan
	if p.role >= RoleAdmin {
		maxBan = AdminMaxBan
	}
	auditArgs := map[string]string{"duration": args[at], "reason": reason}
	switch {
	case (dur == 0 && (args[at] != "perm" || p.role < RoleAdmin)) || dur > maxBan:
		p.emit(systemMsg(msgGMBanDuration, num("days", int(maxBan/(24*time.Hour)))))
		w.audit(ctx, p, "ban", nil, withName(auditArgs, name), auditInvalid)
		return true
	case reason == "" || utf8.RuneCountInString(reason) > MaxBanReason:
		p.emit(systemMsg(msgGMBanReason, num("max", MaxBanReason)))
		w.audit(ctx, p, "ban", nil, withName(auditArgs, name), auditInvalid)
		return true
	}
	job := AdminJob{Kind: AdminBan, TargetName: name, ActorRole: p.role, Reason: reason}
	if dur > 0 {
		job.Until = ctx.Now.Add(dur)
	}
	w.submitAdmin(ctx, p, job, "ban", auditArgs)
	return true
}

// cmdUnban: "/unban Name" lifts the bans of a character's account.
func (w *World) cmdUnban(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) == 0 {
		return false
	}
	w.submitAdmin(ctx, p, AdminJob{Kind: AdminUnban, TargetName: strings.Join(args, " "), ActorRole: p.role}, "unban", nil)
	return true
}

// cmdAnnounce: "/announce text" sends a BROADCAST message to everyone online. The text
// travels as is (like chat); the client adds the translated label.
func (w *World) cmdAnnounce(ctx *game.TickContext, p *Player, args []string) bool {
	msg := strings.Join(args, " ")
	if msg == "" {
		return false
	}
	out := &pb.ServerMessage{Message: &pb.ServerMessage_ChatMessage{ChatMessage: &pb.Message{
		Kind: pb.MessageKind_MESSAGE_KIND_BROADCAST, SpeakerId: p.id, SpeakerName: p.name, Body: &pb.Message_Text{Text: msg},
	}}}
	for _, o := range w.players {
		o.emit(out)
	}
	w.audit(ctx, p, "announce", nil, map[string]string{"text": msg}, auditOK)
	return true
}

// ---- persistence of commands ----------------------------------------------------

// audit queues an audit entry for a command of p on target (nil if none or offline).
func (w *World) audit(ctx *game.TickContext, p *Player, action string, target *Player, args map[string]string, result string) {
	e := w.auditEntry(ctx, p, action, args)
	e.Result = result
	if target != nil {
		e.TargetAccountID, e.TargetCharacterID, e.TargetName = target.accountID, target.charID, target.name
	}
	w.queueAdmin(AdminJob{Kind: AdminAudit, Audit: e})
}

func (w *World) auditEntry(ctx *game.TickContext, p *Player, action string, args map[string]string) AuditEntry {
	return AuditEntry{
		At:               ctx.Now,
		ActorAccountID:   p.accountID,
		ActorCharacterID: p.charID,
		ActorName:        p.name,
		Action:           action,
		Args:             args,
	}
}

// submitAdmin queues a ban or unban job; AdminDone answers p.
func (w *World) submitAdmin(ctx *game.TickContext, p *Player, job AdminJob, action string, args map[string]string) {
	w.nextJob++
	job.ID = w.nextJob
	job.Audit = w.auditEntry(ctx, p, action, args)
	w.jobs[job.ID] = pendingJob{kind: job.Kind, charID: p.charID, until: job.Until}
	w.queueAdmin(job)
}

// queueAdmin submits job to the admin goroutine, keeping it (in order) for a retry on
// the next flush if the queue is full: an audit entry is never dropped.
func (w *World) queueAdmin(job AdminJob) {
	if len(w.adminRetry) > 0 || !w.cfg.Admin(job) {
		w.adminRetry = append(w.adminRetry, job)
	}
}

func (w *World) retryAdmin() {
	n := 0
	for n < len(w.adminRetry) && w.cfg.Admin(w.adminRetry[n]) {
		n++
	}
	w.adminRetry = append(w.adminRetry[:0], w.adminRetry[n:]...)
}

// PendingAdmin returns the admin jobs Config.Admin could not queue yet (for shutdown).
// Call it only after the loop stopped.
func (w *World) PendingAdmin() []AdminJob {
	out := append([]AdminJob(nil), w.adminRetry...)
	w.adminRetry = w.adminRetry[:0]
	return out
}

// pendingJob is a ban or unban waiting for the database.
type pendingJob struct {
	kind   AdminJobKind
	charID int64 // the staff character to answer
	until  time.Time
	system bool // an automatic suspension (bot detection, T4.1): nobody to answer
}

// AdminDone returns the command the admin goroutine enqueues after a ban or unban job.
// A ban disconnects every online character of the account with BANNED and keeps the
// account out of the world until the ban ends, even if a login read the database
// before the ban.
func (w *World) AdminDone(r AdminResult) game.Command {
	return game.CommandFunc(func(ctx *game.TickContext) {
		job, ok := w.jobs[r.ID]
		if !ok {
			return
		}
		delete(w.jobs, r.ID)
		if job.system && r.Result != AdminOK {
			w.log.Warn("antibot: automatic suspension not applied", "name", r.Name, "result", r.Result)
		}
		if job.kind == AdminListReports || job.kind == AdminCloseReport {
			if gm := w.byChar[job.charID]; gm != nil {
				w.reportsDone(ctx, gm, job.kind, r)
			}
			return
		}
		if r.Result == AdminOK {
			switch job.kind {
			case AdminBan:
				w.banned[r.AccountID] = job.until
				for _, o := range append([]*Player(nil), w.players...) {
					if o.accountID == r.AccountID {
						w.remove(ctx, o, pb.DisconnectReason_DISCONNECT_REASON_BANNED, false)
					}
				}
			case AdminUnban:
				delete(w.banned, r.AccountID)
			}
		}
		gm := w.byChar[job.charID]
		if gm == nil {
			return
		}
		name := textParam("name", r.Name)
		switch {
		case r.Result == AdminOK && job.kind == AdminBan:
			gm.emit(systemMsg(msgGMBanned, name))
		case r.Result == AdminOK:
			gm.emit(systemMsg(msgGMUnbanned, name))
		case r.Result == AdminNotFound:
			gm.emit(systemMsg(msgGMNotFound, name))
		case r.Result == AdminProtected:
			gm.emit(systemMsg(msgGMProtected, name))
		case r.Result == AdminNotBanned:
			gm.emit(systemMsg(msgGMNotBanned, name))
		default:
			gm.emit(systemMsg(msgGMFailed))
		}
	})
}

// isBanned reports whether account has a ban this World applied that is still active
// at now; an expired one is forgotten.
func (w *World) isBanned(account int64, now time.Time) bool {
	until, ok := w.banned[account]
	if !ok {
		return false
	}
	if until.IsZero() || now.Before(until) {
		return true
	}
	delete(w.banned, account)
	return false
}

// checkRoles asks the admin goroutine, every RoleCheckEvery ticks, for the current role
// of the accounts of online staff. A full queue skips this round; the next one asks
// again.
func (w *World) checkRoles(ctx *game.TickContext) {
	if w.cfg.Admin == nil || ctx.Tick < w.nextRoleCheck {
		return
	}
	w.nextRoleCheck = ctx.Tick + RoleCheckEvery
	var accounts []int64
	for _, p := range w.players {
		if p.role > RolePlayer && !slices.Contains(accounts, p.accountID) {
			accounts = append(accounts, p.accountID)
		}
	}
	if len(accounts) > 0 {
		_ = w.cfg.Admin(AdminJob{Kind: AdminCheckRoles, Accounts: accounts})
	}
}

// KickAccount returns the command that disconnects every online character of the
// account with PASSWORD_CHANGED (T2.1: a password reset revokes every session, live
// connections included). Characters are saved as on any logout.
func (w *World) KickAccount(accountID int64) game.Command {
	return game.CommandFunc(func(ctx *game.TickContext) {
		for _, o := range append([]*Player(nil), w.players...) {
			if o.accountID == accountID {
				w.remove(ctx, o, pb.DisconnectReason_DISCONNECT_REASON_PASSWORD_CHANGED, false)
			}
		}
	})
}

// RolesChanged returns the command the admin goroutine enqueues with the current roles
// of some accounts (a missing account is a player). Online characters of those accounts
// only ever lose privileges here; a new role is granted at the next login.
func (w *World) RolesChanged(roles map[int64]Role) game.Command {
	return game.CommandFunc(func(*game.TickContext) {
		for _, p := range w.players {
			if r, ok := roles[p.accountID]; ok && r < p.role {
				w.log.Info("session: staff role lowered", "character", p.charID, "from", p.role.String(), "to", r.String())
				p.role = r
			}
		}
	})
}

// ---- helpers ----------------------------------------------------------------------

// RoleFromString maps accounts.role to a Role; anything unknown is a player.
func RoleFromString(s string) Role {
	switch s {
	case "gm":
		return RoleGM
	case "admin":
		return RoleAdmin
	default:
		return RolePlayer
	}
}

// String returns the accounts.role value of r.
func (r Role) String() string {
	switch r {
	case RoleGM:
		return "gm"
	case RoleAdmin:
		return "admin"
	default:
		return "player"
	}
}

// onlineByName finds an online player by name, ignoring case.
func (w *World) onlineByName(name string) *Player {
	for _, o := range w.players {
		if strings.EqualFold(o.name, name) {
			return o
		}
	}
	return nil
}

// parsePos parses "x y z" within the map's coordinate range.
func parsePos(s []string) (world.Pos, bool) {
	x, ex := strconv.Atoi(s[0])
	y, ey := strconv.Atoi(s[1])
	z, ez := strconv.Atoi(s[2])
	if ex != nil || ey != nil || ez != nil || x < 0 || x > 0xFFFF || y < 0 || y > 0xFFFF || z < 0 || z > world.MaxFloor {
		return world.Pos{}, false
	}
	return world.Pos{X: uint16(x), Y: uint16(y), Z: uint8(z)}, true
}

func textParam(name, v string) *pb.TextParam {
	return &pb.TextParam{Name: name, Value: &pb.TextParam_Text{Text: v}}
}

func itoa(v int) string { return strconv.Itoa(v) }

func withName(args map[string]string, name string) map[string]string {
	args["target"] = name
	return args
}
