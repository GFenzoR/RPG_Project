package session

import (
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/guild"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Guilds (T5.1, docs/02-game-design.md "Gremios"). The World owns every guild: it loads
// all of them at start (Config.Guilds), decides every change on the loop and sends each
// change to the database in order through the admin goroutine (AdminGuild jobs), like
// the audit log. Nothing here waits for the database. Members are known by character id
// and name, online or not; a member's Player points at its guildMember while online.
//
// Costs: every command touches one guild (at most balance guild.max_members members and
// max_invites invitations), never the list of guilds; a name is found in a map.

// Message keys of guilds.
const (
	msgGuildUnavailable   = "guild.unavailable"
	msgGuildUsage         = "guild.usage"
	msgGuildNone          = "guild.none"
	msgGuildAlready       = "guild.already_member"
	msgGuildLevel         = "guild.level"
	msgGuildCost          = "guild.cost"
	msgGuildNameTaken     = "guild.name_taken"
	msgGuildCreated       = "guild.created"
	msgGuildNoPermission  = "guild.no_permission"
	msgGuildOffline       = "guild.player_offline"
	msgGuildTargetInGuild = "guild.target_in_guild"
	msgGuildAlreadyAsked  = "guild.already_invited"
	msgGuildTooManyInv    = "guild.too_many_invites"
	msgGuildFull          = "guild.full"
	msgGuildInviteSent    = "guild.invite_sent"
	msgGuildInvitedYou    = "guild.invited_you"
	msgGuildRevoked       = "guild.invite_revoked"
	msgGuildNoInvite      = "guild.no_invite"
	msgGuildInviteGone    = "guild.invite_gone"
	msgGuildLeaveFirst    = "guild.leave_first"
	msgGuildDeclined      = "guild.declined"
	msgGuildJoined        = "guild.joined"
	msgGuildLeaderLeave   = "guild.leader_cannot_leave"
	msgGuildLeft          = "guild.left"
	msgGuildYouLeft       = "guild.you_left"
	msgGuildNotAMember    = "guild.not_a_member"
	msgGuildKicked        = "guild.kicked"
	msgGuildYouKicked     = "guild.you_were_kicked"
	msgGuildTooManyVices  = "guild.too_many_vices"
	msgGuildPromoted      = "guild.promoted"
	msgGuildDemoted       = "guild.demoted"
	msgGuildMotdTooLong   = "guild.motd_too_long"
	msgGuildMotdChanged   = "guild.motd_changed"
	msgGuildDisbandName   = "guild.disband_confirm"
	msgGuildDisbanded     = "guild.disbanded"
	msgGuildNewLeader     = "guild.new_leader"
	msgGMGuildNotFound    = "gm.guild_not_found"
	msgGMGuildRenamed     = "gm.guild_renamed"
	msgGMGuildDisbanded   = "gm.guild_disbanded"
	msgGuildStaffDisband  = "guild.disbanded_staff"
	msgGuildStaffRenamed  = "guild.renamed_staff"
	msgGuildSelf          = "guild.self"
	msgGuildSameRank      = "guild.same_rank"
	msgGuildInviteNotSeen = "guild.invite_unknown"
)

// nameErrorKeys are the message keys of the name errors.
var nameErrorKeys = map[guild.NameError]string{
	guild.NameLength:   "guild.name_length",
	guild.NameChars:    "guild.name_chars",
	guild.NameReserved: "guild.name_reserved",
}

// EconGuild is the economy source of founding a guild (its cost is destroyed).
const EconGuild = "guild"

// GuildData is every guild, member and pending invitation, loaded from the database
// before the loop starts (Config.Guilds).
type GuildData struct {
	// IDHigh is the highest guild id ever issued: ids of disbanded guilds are never
	// reused (audit log, public links).
	IDHigh int64
	Guilds []GuildRecord
}

// GuildRecord is one stored guild.
type GuildRecord struct {
	ID        int64
	Name      string
	Motd      string
	CreatedAt time.Time
	Members   []GuildMemberRecord
	Invites   []GuildInviteRecord
}

// GuildMemberRecord is one stored member.
type GuildMemberRecord struct {
	CharacterID int64
	Name        string
	Rank        guild.Rank
	JoinedAt    time.Time
}

// GuildInviteRecord is one stored invitation.
type GuildInviteRecord struct {
	CharacterID int64
	Name        string
	Expires     time.Time
}

// GuildOp is the kind of a GuildChange; the values match store.GuildOp.
type GuildOp uint8

// Guild changes (see store.GuildOp for what each writes).
const (
	GuildCreate GuildOp = iota + 1
	GuildRename
	GuildMotd
	GuildDisband
	GuildJoin
	GuildRemove
	GuildRank
	GuildTransfer
	GuildInvite
	GuildUninvite
)

// GuildChange is one change for the database (AdminJob.Guild). For GuildTransfer,
// CharacterID is the old leader, Rank its new rank and OtherID the new leader.
type GuildChange struct {
	Op          GuildOp
	GuildID     int64
	CharacterID int64
	OtherID     int64
	InvitedBy   int64
	Name        string
	Text        string
	Rank        guild.Rank
	At          time.Time
	Expires     time.Time
}

type guildState struct {
	id   int64
	name string
	motd string
	// members: highest rank first, then by joined (sortMembers).
	members []*guildMember
	invites []guildInvite
	// queued: in World.guildDirty for this tick's flush.
	queued bool
}

type guildMember struct {
	charID int64
	name   string
	rank   guild.Rank
	joined time.Time
	g      *guildState
}

type guildInvite struct {
	charID  int64
	name    string
	expires time.Time
}

// initGuilds builds the guild state from cfg.Guilds; nil keeps guilds off (and they
// also need Config.Admin, which writes them).
func (w *World) initGuilds() {
	w.guilds = map[int64]*guildState{}
	w.guildByName = map[string]*guildState{}
	w.guildMembers = map[int64]*guildMember{}
	w.guildInvited = map[int64][]*guildState{}
	if w.cfg.Guilds == nil || w.cfg.Admin == nil {
		return
	}
	w.guildOn = true
	w.nextGuildID = w.cfg.Guilds.IDHigh
	for _, r := range w.cfg.Guilds.Guilds {
		g := &guildState{id: r.ID, name: r.Name, motd: r.Motd}
		for _, m := range r.Members {
			if !m.Rank.Valid() || w.guildMembers[m.CharacterID] != nil {
				w.log.Error("session: guild member skipped", "guild", r.ID, "character", m.CharacterID)
				continue
			}
			gm := &guildMember{charID: m.CharacterID, name: m.Name, rank: m.Rank, joined: m.JoinedAt, g: g}
			g.members = append(g.members, gm)
			w.guildMembers[m.CharacterID] = gm
		}
		for _, i := range r.Invites {
			g.invites = append(g.invites, guildInvite{charID: i.CharacterID, name: i.Name, expires: i.Expires})
			w.guildInvited[i.CharacterID] = append(w.guildInvited[i.CharacterID], g)
		}
		sortMembers(g)
		w.guilds[g.id] = g
		w.guildByName[guild.Key(g.name)] = g
		w.nextGuildID = max(w.nextGuildID, g.id)
	}
}

func sortMembers(g *guildState) {
	slices.SortStableFunc(g.members, func(a, b *guildMember) int {
		if a.rank != b.rank {
			return int(b.rank) - int(a.rank)
		}
		return a.joined.Compare(b.joined)
	})
}

// guildJoin links p to its guild membership when it enters the world and queues the
// GuildUpdates: its own, and the other members' (it is online now).
func (w *World) guildJoin(p *Player) {
	if !w.guildOn {
		return
	}
	p.gm = w.guildMembers[p.charID]
	w.queueGuildSend(p)
	if p.gm != nil {
		w.guildChanged(p.gm.g)
	}
}

// guildLeftWorld tells p's guild that it went offline.
func (w *World) guildLeftWorld(p *Player) {
	if p.gm != nil {
		w.guildChanged(p.gm.g)
	}
}

// guildName is the name shown under a player (Creature.guild).
func guildName(p *Player) string {
	if p.gm == nil {
		return ""
	}
	return p.gm.g.name
}

// guildCommand runs a GuildCommand. Every command counts against the chat anti-flood:
// most of them speak to other players or write to the database.
func (w *World) guildCommand(ctx *game.TickContext, p *Player, m *pb.GuildCommand) {
	if !w.chatAllowed(ctx, p) {
		return
	}
	if !w.guildOn {
		p.emit(systemMsg(msgGuildUnavailable))
		return
	}
	name := guild.CleanName(m.GetName())
	switch m.GetAction() {
	case pb.GuildAction_GUILD_ACTION_CREATE:
		w.guildCreate(ctx, p, name)
	case pb.GuildAction_GUILD_ACTION_INVITE:
		w.guildInvite(ctx, p, name)
	case pb.GuildAction_GUILD_ACTION_REVOKE:
		w.guildRevoke(ctx, p, name)
	case pb.GuildAction_GUILD_ACTION_ACCEPT:
		w.guildAccept(ctx, p, w.guilds[int64(m.GetGuildId())])
	case pb.GuildAction_GUILD_ACTION_DECLINE:
		w.guildDecline(ctx, p, w.guilds[int64(m.GetGuildId())])
	case pb.GuildAction_GUILD_ACTION_LEAVE:
		w.guildLeave(ctx, p)
	case pb.GuildAction_GUILD_ACTION_KICK:
		w.guildKick(ctx, p, name)
	case pb.GuildAction_GUILD_ACTION_PROMOTE:
		w.guildSetRank(ctx, p, name, true)
	case pb.GuildAction_GUILD_ACTION_DEMOTE:
		w.guildSetRank(ctx, p, name, false)
	case pb.GuildAction_GUILD_ACTION_MOTD:
		w.guildMotd(ctx, p, m.GetText())
	case pb.GuildAction_GUILD_ACTION_DISBAND:
		w.guildDisband(ctx, p, name)
	case pb.GuildAction_GUILD_ACTION_TRANSFER:
		w.guildTransfer(ctx, p, name)
	}
}

// cmdGuild is the chat command "/guild <action> [args]": the same as a GuildCommand.
// Accept and decline name the guild.
func (w *World) cmdGuild(ctx *game.TickContext, p *Player, args []string) {
	usage := func() {
		if w.chatAllowed(ctx, p) {
			p.emit(systemMsg(msgGuildUsage))
		}
	}
	if len(args) == 0 {
		usage()
		return
	}
	rest := strings.Join(args[1:], " ")
	m := &pb.GuildCommand{Name: rest}
	switch strings.ToLower(args[0]) {
	case "create":
		m.Action = pb.GuildAction_GUILD_ACTION_CREATE
	case "invite":
		m.Action = pb.GuildAction_GUILD_ACTION_INVITE
	case "revoke":
		m.Action = pb.GuildAction_GUILD_ACTION_REVOKE
	case "accept", "decline":
		m.Action = pb.GuildAction_GUILD_ACTION_ACCEPT
		if strings.EqualFold(args[0], "decline") {
			m.Action = pb.GuildAction_GUILD_ACTION_DECLINE
		}
		if g := w.guildByName[guild.Key(guild.CleanName(rest))]; g != nil {
			m.GuildId = uint64(g.id)
		}
	case "leave":
		m.Action = pb.GuildAction_GUILD_ACTION_LEAVE
	case "kick":
		m.Action = pb.GuildAction_GUILD_ACTION_KICK
	case "promote":
		m.Action = pb.GuildAction_GUILD_ACTION_PROMOTE
	case "demote":
		m.Action = pb.GuildAction_GUILD_ACTION_DEMOTE
	case "motd":
		m.Action, m.Text = pb.GuildAction_GUILD_ACTION_MOTD, rest
	case "disband":
		m.Action = pb.GuildAction_GUILD_ACTION_DISBAND
	case "transfer":
		m.Action = pb.GuildAction_GUILD_ACTION_TRANSFER
	default:
		usage()
		return
	}
	if m.Action != pb.GuildAction_GUILD_ACTION_LEAVE && m.Action != pb.GuildAction_GUILD_ACTION_MOTD && rest == "" {
		usage()
		return
	}
	w.guildCommand(ctx, p, m)
}

// ---- actions ------------------------------------------------------------------

func (w *World) guildCreate(ctx *game.TickContext, p *Player, name string) {
	gc := w.cfg.Balance.Guild
	cost := int64(gc.FoundCost)
	switch {
	case p.gm != nil:
		p.emit(systemMsg(msgGuildAlready))
		return
	case p.level < gc.FoundMinLevel:
		p.emit(systemMsg(msgGuildLevel, num("level", gc.FoundMinLevel)))
		return
	}
	if e := guild.ValidName(gc, name); e != guild.NameOK {
		p.emit(systemMsg(nameErrorKeys[e], num("min", gc.NameMin), num("max", gc.NameMax),
			num("words", gc.NameMaxWords)))
		return
	}
	if w.guildByName[guild.Key(name)] != nil {
		p.emit(systemMsg(msgGuildNameTaken, textParam("name", name)))
		return
	}
	if w.money(p) < cost {
		p.emit(systemMsg(msgGuildCost, num("amount", int(cost))))
		return
	}
	if cost > 0 {
		w.pay(p, cost)
		w.econGold(p, EconGuild, "", -cost)
		p.questDirty = true
	}
	w.nextGuildID++
	g := &guildState{id: w.nextGuildID, name: name}
	gm := &guildMember{charID: p.charID, name: p.name, rank: guild.Leader, joined: ctx.Now, g: g}
	g.members = []*guildMember{gm}
	w.guilds[g.id] = g
	w.guildByName[guild.Key(name)] = g
	w.guildMembers[p.charID] = gm
	p.gm = gm
	w.dropInvitesOf(p.charID)
	w.guildWrite(GuildChange{Op: GuildCreate, GuildID: g.id, CharacterID: p.charID, Name: name, At: ctx.Now})
	w.log.Info("guild: founded", "guild", g.id, "name", name, "character", p.charID, "cost", cost)
	p.emit(systemMsg(msgGuildCreated, textParam("guild", name), num("amount", int(cost))))
	w.guildChanged(g)
	w.showGuild(p)
}

// actor returns p's membership if its rank allows a (on a member of rank target),
// telling p why not otherwise.
func (w *World) actor(p *Player, a guild.Action, target guild.Rank) *guildMember {
	switch {
	case p.gm == nil:
		p.emit(systemMsg(msgGuildNone))
		return nil
	case !guild.Can(p.gm.rank, a, target):
		p.emit(systemMsg(msgGuildNoPermission))
		return nil
	}
	return p.gm
}

// memberNamed returns the member of g called name (any case), telling p if none.
func (w *World) memberNamed(p *Player, g *guildState, name string) *guildMember {
	for _, m := range g.members {
		if strings.EqualFold(m.name, name) {
			return m
		}
	}
	p.emit(systemMsg(msgGuildNotAMember, textParam("name", name)))
	return nil
}

func (w *World) guildInvite(ctx *game.TickContext, p *Player, name string) {
	gm := w.actor(p, guild.Invite, 0)
	if gm == nil {
		return
	}
	g := gm.g
	cfg := w.cfg.Balance.Guild
	o := w.onlineByName(name)
	if o != nil && o.invisible && !p.Knows(o.id) {
		o = nil // like /report and /presence: an unseen invisible player is not online here
	}
	w.pruneInvites(g, ctx.Now)
	switch {
	case o == nil:
		// Same answer for an offline name and one that does not exist.
		p.emit(systemMsg(msgGuildOffline, textParam("name", name)))
		return
	case o == p:
		p.emit(systemMsg(msgGuildSelf))
		return
	case o.gm != nil:
		p.emit(systemMsg(msgGuildTargetInGuild, textParam("name", o.name)))
		return
	case len(g.members) >= cfg.MaxMembers:
		p.emit(systemMsg(msgGuildFull, num("max", cfg.MaxMembers)))
		return
	case slices.ContainsFunc(g.invites, func(i guildInvite) bool { return i.charID == o.charID }):
		p.emit(systemMsg(msgGuildAlreadyAsked, textParam("name", o.name)))
		return
	case len(g.invites) >= cfg.MaxInvites:
		p.emit(systemMsg(msgGuildTooManyInv, num("max", cfg.MaxInvites)))
		return
	}
	expires := ctx.Now.Add(time.Duration(cfg.InviteHours) * time.Hour)
	g.invites = append(g.invites, guildInvite{charID: o.charID, name: o.name, expires: expires})
	w.guildInvited[o.charID] = append(w.guildInvited[o.charID], g)
	w.guildWrite(GuildChange{Op: GuildInvite, GuildID: g.id, CharacterID: o.charID, InvitedBy: p.charID, At: ctx.Now,
		Expires: expires})
	p.emit(systemMsg(msgGuildInviteSent, textParam("name", o.name)))
	o.emit(systemMsg(msgGuildInvitedYou, textParam("guild", g.name), textParam("name", p.name)))
	w.queueGuildSend(o)
	w.guildChanged(g)
}

func (w *World) guildRevoke(ctx *game.TickContext, p *Player, name string) {
	gm := w.actor(p, guild.Revoke, 0)
	if gm == nil {
		return
	}
	g := gm.g
	w.pruneInvites(g, ctx.Now)
	i := slices.IndexFunc(g.invites, func(i guildInvite) bool { return strings.EqualFold(i.name, name) })
	if i < 0 {
		p.emit(systemMsg(msgGuildInviteNotSeen, textParam("name", name)))
		return
	}
	inv := g.invites[i]
	w.removeInvite(g, inv.charID)
	w.guildWrite(GuildChange{Op: GuildUninvite, GuildID: g.id, CharacterID: inv.charID, At: ctx.Now})
	p.emit(systemMsg(msgGuildRevoked, textParam("name", inv.name)))
	if o := w.byChar[inv.charID]; o != nil {
		w.queueGuildSend(o)
	}
	w.guildChanged(g)
}

// invitedBy reports whether g has a live invitation for p.
func (w *World) invitedBy(g *guildState, p *Player, now time.Time) bool {
	return g != nil && slices.ContainsFunc(g.invites, func(i guildInvite) bool {
		return i.charID == p.charID && now.Before(i.expires)
	})
}

func (w *World) guildAccept(ctx *game.TickContext, p *Player, g *guildState) {
	cfg := w.cfg.Balance.Guild
	switch {
	case !w.invitedBy(g, p, ctx.Now):
		p.emit(systemMsg(msgGuildInviteGone))
		w.queueGuildSend(p) // an expired invitation leaves the panel
		return
	case p.gm != nil:
		p.emit(systemMsg(msgGuildLeaveFirst))
		return
	case len(g.members) >= cfg.MaxMembers:
		p.emit(systemMsg(msgGuildFull, num("max", cfg.MaxMembers)))
		return
	}
	gm := &guildMember{charID: p.charID, name: p.name, rank: guild.Member, joined: ctx.Now, g: g}
	g.members = append(g.members, gm) // the newest member: already in order
	w.guildMembers[p.charID] = gm
	p.gm = gm
	w.dropInvitesOf(p.charID)
	w.guildWrite(GuildChange{Op: GuildJoin, GuildID: g.id, CharacterID: p.charID, Rank: guild.Member, At: ctx.Now})
	w.guildMsg(g, systemMsg(msgGuildJoined, textParam("name", p.name), textParam("guild", g.name)))
	w.guildChanged(g)
	w.showGuild(p)
}

func (w *World) guildDecline(ctx *game.TickContext, p *Player, g *guildState) {
	if g == nil || !slices.ContainsFunc(g.invites, func(i guildInvite) bool { return i.charID == p.charID }) {
		p.emit(systemMsg(msgGuildNoInvite))
		w.queueGuildSend(p)
		return
	}
	w.removeInvite(g, p.charID)
	w.guildWrite(GuildChange{Op: GuildUninvite, GuildID: g.id, CharacterID: p.charID, At: ctx.Now})
	p.emit(systemMsg(msgGuildDeclined, textParam("guild", g.name)))
	w.queueGuildSend(p)
	w.guildChanged(g)
}

func (w *World) guildLeave(ctx *game.TickContext, p *Player) {
	switch {
	case p.gm == nil:
		p.emit(systemMsg(msgGuildNone))
		return
	case p.gm.rank == guild.Leader:
		p.emit(systemMsg(msgGuildLeaderLeave))
		return
	}
	g := p.gm.g
	w.removeMember(ctx, p.gm)
	p.emit(systemMsg(msgGuildYouLeft, textParam("guild", g.name)))
	w.guildMsg(g, systemMsg(msgGuildLeft, textParam("name", p.name)))
}

func (w *World) guildKick(ctx *game.TickContext, p *Player, name string) {
	if p.gm == nil {
		p.emit(systemMsg(msgGuildNone))
		return
	}
	t := w.memberNamed(p, p.gm.g, name)
	if t == nil {
		return
	}
	if t == p.gm {
		p.emit(systemMsg(msgGuildSelf))
		return
	}
	if w.actor(p, guild.Kick, t.rank) == nil {
		return
	}
	g := t.g
	w.removeMember(ctx, t)
	if o := w.byChar[t.charID]; o != nil {
		o.emit(systemMsg(msgGuildYouKicked, textParam("guild", g.name)))
	}
	w.guildMsg(g, systemMsg(msgGuildKicked, textParam("name", t.name), textParam("by", p.name)))
}

func (w *World) guildSetRank(ctx *game.TickContext, p *Player, name string, promote bool) {
	if p.gm == nil {
		p.emit(systemMsg(msgGuildNone))
		return
	}
	t := w.memberNamed(p, p.gm.g, name)
	if t == nil {
		return
	}
	if t == p.gm {
		p.emit(systemMsg(msgGuildSelf))
		return
	}
	if p.gm.rank != guild.Leader {
		p.emit(systemMsg(msgGuildNoPermission))
		return
	}
	a, rank, key := guild.Demote, guild.Member, msgGuildDemoted
	if promote {
		a, rank, key = guild.Promote, guild.Vice, msgGuildPromoted
	}
	if t.rank == rank {
		p.emit(systemMsg(msgGuildSameRank, textParam("name", t.name)))
		return
	}
	if w.actor(p, a, t.rank) == nil {
		return
	}
	g := t.g
	if promote && w.vices(g) >= w.cfg.Balance.Guild.MaxViceLeaders {
		p.emit(systemMsg(msgGuildTooManyVices, num("max", w.cfg.Balance.Guild.MaxViceLeaders)))
		return
	}
	t.rank = rank
	sortMembers(g)
	w.guildWrite(GuildChange{Op: GuildRank, GuildID: g.id, CharacterID: t.charID, Rank: rank, At: ctx.Now})
	w.guildMsg(g, systemMsg(key, textParam("name", t.name)))
	w.guildChanged(g)
}

func (w *World) vices(g *guildState) int {
	n := 0
	for _, m := range g.members {
		if m.rank == guild.Vice {
			n++
		}
	}
	return n
}

func (w *World) guildMotd(ctx *game.TickContext, p *Player, text string) {
	gm := w.actor(p, guild.SetMotd, 0)
	if gm == nil {
		return
	}
	text = cleanChat(text)
	if limit := w.cfg.Balance.Guild.MotdMax; utf8.RuneCountInString(text) > limit {
		p.emit(systemMsg(msgGuildMotdTooLong, num("max", limit)))
		return
	}
	g := gm.g
	if g.motd == text {
		return
	}
	g.motd = text
	w.guildWrite(GuildChange{Op: GuildMotd, GuildID: g.id, Text: text, At: ctx.Now})
	w.guildMsg(g, systemMsg(msgGuildMotdChanged, textParam("name", p.name)))
	w.guildChanged(g)
}

func (w *World) guildDisband(ctx *game.TickContext, p *Player, name string) {
	gm := w.actor(p, guild.Disband, 0)
	if gm == nil {
		return
	}
	if !strings.EqualFold(name, gm.g.name) {
		p.emit(systemMsg(msgGuildDisbandName, textParam("guild", gm.g.name)))
		return
	}
	w.disband(ctx, gm.g, systemMsg(msgGuildDisbanded, textParam("guild", gm.g.name)))
	w.log.Info("guild: disbanded", "guild", gm.g.id, "by", p.charID)
}

func (w *World) guildTransfer(ctx *game.TickContext, p *Player, name string) {
	if p.gm == nil {
		p.emit(systemMsg(msgGuildNone))
		return
	}
	t := w.memberNamed(p, p.gm.g, name)
	if t == nil {
		return
	}
	if t == p.gm {
		p.emit(systemMsg(msgGuildSelf))
		return
	}
	if w.actor(p, guild.Transfer, t.rank) == nil {
		return
	}
	g, old := t.g, p.gm
	// The old leader becomes a vice leader if there is room once the new leader leaves
	// the vices, a member otherwise.
	vices := w.vices(g)
	if t.rank == guild.Vice {
		vices--
	}
	old.rank = guild.Member
	if vices < w.cfg.Balance.Guild.MaxViceLeaders {
		old.rank = guild.Vice
	}
	t.rank = guild.Leader
	sortMembers(g)
	w.guildWrite(GuildChange{Op: GuildTransfer, GuildID: g.id, CharacterID: old.charID, OtherID: t.charID, Rank: old.rank,
		At: ctx.Now})
	w.guildMsg(g, systemMsg(msgGuildNewLeader, textParam("name", t.name)))
	w.guildChanged(g)
}

// ---- staff commands (T2.6 + T5.1) ----------------------------------------------

// cmdGuildRename: "/guildrename Old Name = New Name". The new name follows the rules
// of any guild name.
func (w *World) cmdGuildRename(ctx *game.TickContext, p *Player, args []string) bool {
	oldName, newName, ok := strings.Cut(strings.Join(args, " "), "=")
	oldName, newName = guild.CleanName(oldName), guild.CleanName(newName)
	if !ok || oldName == "" || newName == "" {
		return false
	}
	auditArgs := map[string]string{"guild": oldName, "name": newName}
	g := w.guildByName[guild.Key(oldName)]
	if !w.guildOn || g == nil {
		p.emit(systemMsg(msgGMGuildNotFound, textParam("guild", oldName)))
		w.audit(ctx, p, "guild_rename", nil, auditArgs, AdminNotFound)
		return true
	}
	gc := w.cfg.Balance.Guild
	if e := guild.ValidName(gc, newName); e != guild.NameOK {
		p.emit(systemMsg(nameErrorKeys[e], num("min", gc.NameMin), num("max", gc.NameMax),
			num("words", gc.NameMaxWords)))
		w.audit(ctx, p, "guild_rename", nil, auditArgs, auditInvalid)
		return true
	}
	if o := w.guildByName[guild.Key(newName)]; o != nil && o != g {
		p.emit(systemMsg(msgGuildNameTaken, textParam("name", newName)))
		w.audit(ctx, p, "guild_rename", nil, auditArgs, auditInvalid)
		return true
	}
	auditArgs["guild_id"] = itoa(int(g.id))
	old := g.name
	delete(w.guildByName, guild.Key(old))
	g.name = newName
	w.guildByName[guild.Key(newName)] = g
	w.guildWrite(GuildChange{Op: GuildRename, GuildID: g.id, Name: newName, At: ctx.Now})
	w.guildMsg(g, systemMsg(msgGuildStaffRenamed, textParam("guild", newName)))
	for _, m := range g.members {
		if o := w.byChar[m.charID]; o != nil {
			w.announceGuild(o)
		}
	}
	for _, inv := range g.invites {
		if o := w.byChar[inv.charID]; o != nil {
			w.queueGuildSend(o)
		}
	}
	w.guildChanged(g)
	p.emit(systemMsg(msgGMGuildRenamed, textParam("guild", old), textParam("name", newName)))
	w.audit(ctx, p, "guild_rename", nil, auditArgs, auditOK)
	return true
}

// cmdGuildDisband: "/guilddisband Name".
func (w *World) cmdGuildDisband(ctx *game.TickContext, p *Player, args []string) bool {
	name := guild.CleanName(strings.Join(args, " "))
	if name == "" {
		return false
	}
	auditArgs := map[string]string{"guild": name}
	g := w.guildByName[guild.Key(name)]
	if !w.guildOn || g == nil {
		p.emit(systemMsg(msgGMGuildNotFound, textParam("guild", name)))
		w.audit(ctx, p, "guild_disband", nil, auditArgs, AdminNotFound)
		return true
	}
	auditArgs["guild_id"] = itoa(int(g.id))
	w.disband(ctx, g, systemMsg(msgGuildStaffDisband, textParam("guild", g.name)))
	p.emit(systemMsg(msgGMGuildDisbanded, textParam("guild", g.name)))
	w.audit(ctx, p, "guild_disband", nil, auditArgs, auditOK)
	return true
}

// ---- state changes ----------------------------------------------------------------

// removeMember takes m out of its guild (leave or kick).
func (w *World) removeMember(ctx *game.TickContext, m *guildMember) {
	g := m.g
	g.members = slices.DeleteFunc(g.members, func(o *guildMember) bool { return o == m })
	delete(w.guildMembers, m.charID)
	w.guildWrite(GuildChange{Op: GuildRemove, GuildID: g.id, CharacterID: m.charID, At: ctx.Now})
	if o := w.byChar[m.charID]; o != nil {
		o.gm = nil
		w.announceGuild(o)
		w.queueGuildSend(o)
	}
	w.guildChanged(g)
}

// disband deletes g; every online member hears msg.
func (w *World) disband(ctx *game.TickContext, g *guildState, msg *pb.ServerMessage) {
	w.guildMsg(g, msg)
	for _, m := range g.members {
		delete(w.guildMembers, m.charID)
		if o := w.byChar[m.charID]; o != nil {
			o.gm = nil
			w.announceGuild(o)
			w.queueGuildSend(o)
		}
	}
	for _, inv := range g.invites {
		w.unlinkInvite(g, inv.charID)
		if o := w.byChar[inv.charID]; o != nil {
			w.queueGuildSend(o)
		}
	}
	g.members, g.invites = nil, nil
	delete(w.guilds, g.id)
	delete(w.guildByName, guild.Key(g.name))
	w.guildWrite(GuildChange{Op: GuildDisband, GuildID: g.id, At: ctx.Now})
}

// dropInvitesOf deletes every invitation of a character that just joined or founded a
// guild (the database does the same in that change's transaction).
func (w *World) dropInvitesOf(charID int64) {
	for _, g := range w.guildInvited[charID] {
		g.invites = slices.DeleteFunc(g.invites, func(i guildInvite) bool { return i.charID == charID })
		w.guildChanged(g)
	}
	delete(w.guildInvited, charID)
}

func (w *World) removeInvite(g *guildState, charID int64) {
	g.invites = slices.DeleteFunc(g.invites, func(i guildInvite) bool { return i.charID == charID })
	w.unlinkInvite(g, charID)
}

func (w *World) unlinkInvite(g *guildState, charID int64) {
	gs := slices.DeleteFunc(w.guildInvited[charID], func(o *guildState) bool { return o == g })
	if len(gs) == 0 {
		delete(w.guildInvited, charID)
	} else {
		w.guildInvited[charID] = gs
	}
}

// pruneInvites forgets g's expired invitations. The database deletes them at the next
// start, so nothing is written.
func (w *World) pruneInvites(g *guildState, now time.Time) {
	for i := 0; i < len(g.invites); {
		if inv := g.invites[i]; !now.Before(inv.expires) {
			w.removeInvite(g, inv.charID) // removes index i
			continue
		}
		i++
	}
}

// guildWrite sends a change to the database through the admin goroutine (in order,
// never dropped: see queueAdmin).
func (w *World) guildWrite(c GuildChange) {
	w.queueAdmin(AdminJob{Kind: AdminGuild, Guild: &c})
}

// announceGuild tells everyone who sees p (p included) its guild name now.
func (w *World) announceGuild(p *Player) {
	msg := &pb.ServerMessage{Message: &pb.ServerMessage_CreatureGuild{CreatureGuild: &pb.CreatureGuild{
		Id: p.id, Guild: guildName(p)}}}
	w.eachWatcher(p, func(o *Player) { o.emit(msg) })
}

// showGuild is announceGuild plus p's own update, for a player that just got a guild.
func (w *World) showGuild(p *Player) {
	w.announceGuild(p)
	w.queueGuildSend(p)
}

// guildMsg sends m to every online member of g.
func (w *World) guildMsg(g *guildState, m *pb.ServerMessage) {
	for _, gm := range g.members {
		if o := w.byChar[gm.charID]; o != nil {
			o.emit(m)
		}
	}
}

// guildSay sends p's chat line to the online members of its guild, without position.
func (w *World) guildSay(p *Player, text string) {
	msg := &pb.Message{Kind: pb.MessageKind_MESSAGE_KIND_GUILD, SpeakerId: p.id, SpeakerName: p.name,
		Body: &pb.Message_Text{Text: text}}
	w.guildMsg(p.gm.g, &pb.ServerMessage{Message: &pb.ServerMessage_ChatMessage{ChatMessage: msg}})
}

// ---- updates ----------------------------------------------------------------------

// guildChanged queues a GuildUpdate for every online member of g at this tick's flush.
func (w *World) guildChanged(g *guildState) {
	if !g.queued {
		g.queued = true
		w.guildDirty = append(w.guildDirty, g)
	}
}

func (w *World) queueGuildSend(p *Player) {
	if w.guildOn && !p.guildQueued {
		p.guildQueued = true
		w.guildSend = append(w.guildSend, p)
	}
}

// flushGuilds sends the queued GuildUpdates (one per player and tick at most).
func (w *World) flushGuilds(now time.Time) {
	for _, g := range w.guildDirty {
		g.queued = false
		if w.guilds[g.id] != g {
			continue // disbanded this tick
		}
		for _, m := range g.members {
			if o := w.byChar[m.charID]; o != nil {
				w.queueGuildSend(o)
			}
		}
	}
	w.guildDirty = w.guildDirty[:0]
	for _, p := range w.guildSend {
		p.guildQueued = false
		if w.byChar[p.charID] == p {
			p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_GuildUpdate{GuildUpdate: w.guildUpdate(p, now)}})
		}
	}
	w.guildSend = w.guildSend[:0]
}

func expiresMs(until, now time.Time) uint32 {
	return uint32(max(min(until.Sub(now).Milliseconds(), 1<<32-1), 0))
}

// guildUpdate is p's view of its guild and of its invitations.
func (w *World) guildUpdate(p *Player, now time.Time) *pb.GuildUpdate {
	u := &pb.GuildUpdate{}
	if gm := p.gm; gm != nil {
		g := gm.g
		w.pruneInvites(g, now)
		u.GuildId, u.Name, u.Motd, u.Rank = uint64(g.id), g.name, g.motd, pb.GuildRank(gm.rank)
		u.Members = make([]*pb.GuildMember, len(g.members))
		for i, m := range g.members {
			u.Members[i] = &pb.GuildMember{Name: m.name, Rank: pb.GuildRank(m.rank), Online: w.byChar[m.charID] != nil}
		}
		if gm.rank >= guild.Vice {
			for _, inv := range g.invites {
				u.Pending = append(u.Pending, &pb.GuildPendingInvite{Name: inv.name, ExpiresMs: expiresMs(inv.expires, now)})
			}
		}
	}
	for _, g := range w.guildInvited[p.charID] {
		for _, inv := range g.invites {
			if inv.charID == p.charID && now.Before(inv.expires) {
				u.Invitations = append(u.Invitations, &pb.GuildInvitation{GuildId: uint64(g.id), GuildName: g.name,
					ExpiresMs: expiresMs(inv.expires, now)})
			}
		}
	}
	return u
}

// ---- look -------------------------------------------------------------------------

// lookCreature answers a LookAt of a creature p sees: a player's vocation, level and
// guild, or a monster's or NPC's name.
func (w *World) lookCreature(p *Player, id uint32) {
	if !p.Knows(id) {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	if o := w.playerByID(id); o != nil {
		params := []*pb.TextParam{textParam("name", o.name), contentParam("vocation", o.vocation.ID), num("level", o.level)}
		if o.gm == nil {
			p.emit(systemMsg("look.player", params...))
			return
		}
		params = append(params, textParam("guild", o.gm.g.name), contentParam("rank", o.gm.rank.String()))
		p.emit(systemMsg("look.player_guild", params...))
		return
	}
	if m := w.monByID[id]; m != nil {
		p.emit(systemMsg("look.monster", contentParam("monster", m.kind.def.ID)))
		return
	}
	if n := w.npcByID[id]; n != nil {
		p.emit(systemMsg("look.npc", contentParam("npc", n.def.ID)))
		return
	}
	p.emit(systemMsg(msgNotPossible))
}

func contentParam(name, id string) *pb.TextParam {
	return &pb.TextParam{Name: name, Value: &pb.TextParam_ContentId{ContentId: id}}
}
