package session

import (
	"slices"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/guild"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Guild wars (T5.2, docs/02-game-design.md "PvP"). A leader declares war on another
// guild; its leader accepts or declines before balance pvp.war.answer_hours. An active
// war ends when one side reaches pvp.war.kill_limit kills, a leader surrenders, its time
// (pvp.war.hours) runs out (more kills wins, or a draw) or a guild disbands. While it is
// active, the members of both guilds may fight each other without marks.
//
// Like the guilds (guild.go), the loop owns the wars: they are loaded once, and every
// change goes to the database in order through the admin goroutine. A guild has at most
// pvp.war.max_wars open wars, so every lookup scans a handful.

// Message keys of guild wars.
const (
	msgWarNoGuild      = "guild.war_no_guild"
	msgWarSelf         = "guild.war_self"
	msgWarExists       = "guild.war_exists"
	msgWarTooMany      = "guild.war_too_many"
	msgWarEnemyBusy    = "guild.war_enemy_busy"
	msgWarDeclared     = "guild.war_declared"
	msgWarDeclaredOnUs = "guild.war_declared_on_us"
	msgWarStarted      = "guild.war_started"
	msgWarDeclined     = "guild.war_declined"
	msgWarExpired      = "guild.war_expired"
	msgWarWon          = "guild.war_won"
	msgWarLost         = "guild.war_lost"
	msgWarDraw         = "guild.war_draw"
	msgWarSurrendered  = "guild.war_surrendered"
	msgWarNotFound     = "guild.war_not_found"
	msgWarOff          = "guild.war_off"
	msgWarDisbanded    = "guild.war_disbanded"
)

// Guild war end reasons (GuildChange.Reason); the values match store.WarEnd*.
const (
	WarEndDeclined = iota + 1
	WarEndExpired
	WarEndSurrender
	WarEndKillLimit
	WarEndTime
	WarEndDisbanded
)

// GuildWarRecord is one stored open war (GuildData.Wars).
type GuildWarRecord struct {
	ID         int64
	GuildID    int64 // the declaring guild
	EnemyID    int64
	Active     bool
	DeclaredAt time.Time
	Expires    time.Time
	KillLimit  int
	Kills      int
	EnemyKills int
}

type guildWar struct {
	id int64
	// sides[0] declared the war on sides[1]; kills[i] are the kills of sides[i].
	sides   [2]*guildState
	kills   [2]int
	active  bool
	expires time.Time
	limit   int
}

// side returns the index of g in war (or -1).
func (war *guildWar) side(g *guildState) int {
	switch g {
	case war.sides[0]:
		return 0
	case war.sides[1]:
		return 1
	}
	return -1
}

func (w *World) initWars() {
	if !w.guildOn || w.cfg.Guilds == nil {
		return
	}
	w.nextWarID = w.cfg.Guilds.WarIDHigh
	for _, r := range w.cfg.Guilds.Wars {
		a, b := w.guilds[r.GuildID], w.guilds[r.EnemyID]
		if a == nil || b == nil || a == b {
			w.log.Error("session: guild war skipped", "war", r.ID)
			continue
		}
		war := &guildWar{id: r.ID, sides: [2]*guildState{a, b}, kills: [2]int{r.Kills, r.EnemyKills}, active: r.Active,
			expires: r.Expires, limit: max(r.KillLimit, 1)}
		w.addWar(war)
		w.nextWarID = max(w.nextWarID, r.ID)
	}
}

func (w *World) addWar(war *guildWar) {
	w.wars[war.id] = war
	w.warList = append(w.warList, war) // ids grow: the list stays ordered
	for _, g := range war.sides {
		g.wars = append(g.wars, war)
	}
}

// activeWar returns the active war between a's and v's guilds, or nil.
func (w *World) activeWar(a, v *Player) *guildWar {
	if a.gm == nil || v.gm == nil || a.gm.g == v.gm.g {
		return nil
	}
	for _, war := range a.gm.g.wars {
		if war.active && war.side(v.gm.g) >= 0 {
			return war
		}
	}
	return nil
}

// openWar returns the open (declared or active) war between g and o, or nil.
func openWar(g, o *guildState) *guildWar {
	for _, war := range g.wars {
		if war.side(o) >= 0 {
			return war
		}
	}
	return nil
}

// warLeader returns p's guild if p leads it and wars are on; otherwise it tells p why
// not and returns nil.
func (w *World) warLeader(p *Player) *guildState {
	switch {
	case !w.pvpOn:
		p.emit(systemMsg(msgWarOff))
	case p.gm == nil:
		p.emit(systemMsg(msgGuildNone))
	case p.gm.rank != guild.Leader:
		p.emit(systemMsg(msgGuildNoPermission))
	default:
		return p.gm.g
	}
	return nil
}

func (w *World) warDeclare(ctx *game.TickContext, p *Player, name string) {
	g := w.warLeader(p)
	if g == nil {
		return
	}
	enemy := w.guildByName[guild.Key(name)]
	wc := w.pvp.War
	switch {
	case enemy == nil:
		p.emit(systemMsg(msgWarNoGuild, textParam("guild", name)))
	case enemy == g:
		p.emit(systemMsg(msgWarSelf))
	case openWar(g, enemy) != nil:
		p.emit(systemMsg(msgWarExists, textParam("guild", enemy.name)))
	case len(g.wars) >= wc.MaxWars:
		p.emit(systemMsg(msgWarTooMany, num("count", wc.MaxWars)))
	case len(enemy.wars) >= wc.MaxWars:
		p.emit(systemMsg(msgWarEnemyBusy, textParam("guild", enemy.name)))
	default:
		w.nextWarID++
		war := &guildWar{id: w.nextWarID, sides: [2]*guildState{g, enemy}, limit: wc.KillLimit,
			expires: ctx.Now.Add(time.Duration(wc.AnswerHours) * time.Hour)}
		w.addWar(war)
		w.guildWrite(GuildChange{Op: GuildWarDeclare, GuildID: g.id, EnemyID: enemy.id, WarID: war.id, At: ctx.Now,
			Expires: war.expires, KillLimit: war.limit})
		w.guildMsg(g, systemMsg(msgWarDeclared, textParam("guild", enemy.name)))
		w.guildMsg(enemy, systemMsg(msgWarDeclaredOnUs, textParam("guild", g.name)))
		w.guildChanged(g)
		w.guildChanged(enemy)
	}
}

// warOf returns the war id of p's guild, or tells p it does not exist.
func (w *World) warOf(p *Player, g *guildState, id int64) *guildWar {
	war := w.wars[id]
	if war == nil || war.side(g) < 0 {
		p.emit(systemMsg(msgWarNotFound))
		return nil
	}
	return war
}

// warAnswer accepts or declines a war declared on p's guild.
func (w *World) warAnswer(ctx *game.TickContext, p *Player, id int64, accept bool) {
	g := w.warLeader(p)
	if g == nil {
		return
	}
	war := w.warOf(p, g, id)
	if war == nil {
		return
	}
	if war.active || war.sides[1] != g || !ctx.Now.Before(war.expires) {
		p.emit(systemMsg(msgWarNotFound))
		return
	}
	if !accept {
		w.endWar(ctx, war, WarEndDeclined, -1)
		return
	}
	war.active = true
	war.expires = ctx.Now.Add(time.Duration(w.pvp.War.Hours) * time.Hour)
	w.guildWrite(GuildChange{Op: GuildWarStart, GuildID: war.sides[0].id, WarID: war.id, At: ctx.Now, Expires: war.expires})
	for i, s := range war.sides {
		w.guildMsg(s, systemMsg(msgWarStarted, textParam("guild", war.sides[1-i].name), num("kills", war.limit)))
		w.guildChanged(s)
	}
}

// warSurrender ends p's guild's active war: the enemy wins.
func (w *World) warSurrender(ctx *game.TickContext, p *Player, id int64) {
	g := w.warLeader(p)
	if g == nil {
		return
	}
	war := w.warOf(p, g, id)
	if war == nil {
		return
	}
	if !war.active {
		p.emit(systemMsg(msgWarNotFound))
		return
	}
	w.endWar(ctx, war, WarEndSurrender, 1-war.side(g))
}

// warKill counts a kill of a's guild in war; reaching the limit wins it.
func (w *World) warKill(ctx *game.TickContext, war *guildWar, a *Player) {
	if w.wars[war.id] != war || a.gm == nil {
		return
	}
	i := war.side(a.gm.g)
	if i < 0 {
		return
	}
	war.kills[i]++
	w.guildWrite(GuildChange{Op: GuildWarKills, GuildID: war.sides[0].id, WarID: war.id, Kills: war.kills[0],
		EnemyKills: war.kills[1]})
	w.guildChanged(war.sides[0])
	w.guildChanged(war.sides[1])
	if war.kills[i] >= war.limit {
		w.endWar(ctx, war, WarEndKillLimit, i)
	}
}

// checkWars ends declarations nobody answered and wars whose time ran out.
func (w *World) checkWars(ctx *game.TickContext) {
	for i := 0; i < len(w.warList); {
		war := w.warList[i]
		if ctx.Now.Before(war.expires) {
			i++
			continue
		}
		if !war.active {
			w.endWar(ctx, war, WarEndExpired, -1)
			continue // endWar removed index i
		}
		winner := -1
		switch {
		case war.kills[0] > war.kills[1]:
			winner = 0
		case war.kills[1] > war.kills[0]:
			winner = 1
		}
		w.endWar(ctx, war, WarEndTime, winner)
	}
}

// endWar ends war with reason and winner (a side index, -1 for none), tells both
// guilds and writes it.
func (w *World) endWar(ctx *game.TickContext, war *guildWar, reason, winner int) {
	w.dropWar(war)
	c := GuildChange{Op: GuildWarEnd, GuildID: war.sides[0].id, WarID: war.id, At: ctx.Now, Reason: reason}
	if winner >= 0 {
		c.WinnerID = war.sides[winner].id
	}
	w.guildWrite(c)
	for i, g := range war.sides {
		enemy := textParam("guild", war.sides[1-i].name)
		var key string
		switch {
		case reason == WarEndDeclined:
			key = msgWarDeclined
		case reason == WarEndExpired:
			key = msgWarExpired
		case reason == WarEndDisbanded:
			key = msgWarDisbanded
		case reason == WarEndSurrender && winner != i:
			key = msgWarSurrendered
		case winner == i:
			key = msgWarWon
		case winner < 0:
			key = msgWarDraw
		default:
			key = msgWarLost
		}
		if w.guilds[g.id] == g {
			w.guildMsg(g, systemMsg(key, enemy, num("our_kills", war.kills[i]), num("their_kills", war.kills[1-i])))
			w.guildChanged(g)
		}
	}
}

func (w *World) dropWar(war *guildWar) {
	delete(w.wars, war.id)
	w.warList = slices.DeleteFunc(w.warList, func(o *guildWar) bool { return o == war })
	for _, g := range war.sides {
		g.wars = slices.DeleteFunc(g.wars, func(o *guildWar) bool { return o == war })
	}
}

// endWarsOf ends every open war of g, which is being disbanded (the database deletes
// its rows with the guild; the change is written first so the order stays clear).
func (w *World) endWarsOf(ctx *game.TickContext, g *guildState) {
	for len(g.wars) > 0 {
		w.endWar(ctx, g.wars[0], WarEndDisbanded, -1)
	}
}

// guildWars is g's wars as GuildUpdate lists them.
func (w *World) guildWars(g *guildState, now time.Time) []*pb.GuildWar {
	out := make([]*pb.GuildWar, 0, len(g.wars))
	for _, war := range g.wars {
		i := war.side(g)
		gw := &pb.GuildWar{WarId: uint64(war.id), EnemyName: war.sides[1-i].name, DeclaredByUs: i == 0,
			State: pb.GuildWarState_GUILD_WAR_STATE_PENDING, KillLimit: uint32(war.limit), EndsMs: expiresMs(war.expires, now)}
		if war.active {
			gw.State = pb.GuildWarState_GUILD_WAR_STATE_ACTIVE
			gw.OurKills, gw.TheirKills = uint32(war.kills[i]), uint32(war.kills[1-i])
		}
		out = append(out, gw)
	}
	return out
}

// cmdGuildWar is "/guild war declare|accept|decline|surrender Guild Name": the war with
// that guild.
func (w *World) cmdGuildWar(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) < 2 {
		return false
	}
	name := guild.CleanName(strings.Join(args[1:], " "))
	m := &pb.GuildCommand{Name: name}
	switch strings.ToLower(args[0]) {
	case "declare":
		m.Action = pb.GuildAction_GUILD_ACTION_WAR_DECLARE
	case "accept":
		m.Action = pb.GuildAction_GUILD_ACTION_WAR_ACCEPT
	case "decline":
		m.Action = pb.GuildAction_GUILD_ACTION_WAR_DECLINE
	case "surrender":
		m.Action = pb.GuildAction_GUILD_ACTION_WAR_SURRENDER
	default:
		return false
	}
	if p.gm != nil {
		if o := w.guildByName[guild.Key(name)]; o != nil {
			if war := openWar(p.gm.g, o); war != nil {
				m.WarId = uint64(war.id)
			}
		}
	}
	w.guildCommand(ctx, p, m)
	return true
}
