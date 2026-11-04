package session

import (
	"slices"
	"strings"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Parties (T3.3, docs/02-game-design.md "Grupos"): a leader invites, the invited player
// accepts or declines before the invitation expires, and the leader can turn on shared
// experience. Everything runs on the loop; nothing is persisted: a member that leaves
// the world (logout, disconnect, re-login) leaves its party.
const (
	msgPartyInvited      = "party.invited"
	msgPartyNotFound     = "party.player_not_found"
	msgPartyNotSeen      = "party.player_not_seen"
	msgPartyHasParty     = "party.already_in_party"
	msgPartyLeaveFirst   = "party.leave_first"
	msgPartyFull         = "party.full"
	msgPartyNotLeader    = "party.not_leader"
	msgPartyNone         = "party.none"
	msgPartyInviteGone   = "party.invite_gone"
	msgPartyDeclined     = "party.declined"
	msgPartyJoined       = "party.joined"
	msgPartyLeft         = "party.left"
	msgPartyKicked       = "party.kicked"
	msgPartyYouKicked    = "party.you_were_kicked"
	msgPartyLeader       = "party.new_leader"
	msgPartyDisbanded    = "party.disbanded"
	msgPartySharedOn     = "party.shared_on"
	msgPartySharedOff    = "party.shared_off"
	msgPartyNotAMember   = "party.not_a_member"
	msgPartyInviteUsage  = "party.invite_usage"
	msgPartyAlreadyAsked = "party.already_invited"
)

// party is one group of players. members are in join order; the leader is one of them.
type party struct {
	leader  *Player
	members []*Player
	shared  bool
	// dirty marks a change every member must hear about at the next flush.
	dirty bool
}

// inviteKey is a pending invitation of player from to player to (creature ids).
type inviteKey struct{ from, to uint32 }

// partyView is what one member last received about another (PartyMember), to send a
// PartyUpdate only when it changes.
type partyView struct {
	id      uint32
	level   int
	inView  bool
	health  uint32
	mana    uint32
	island  string
	sharing bool
}

// initParty converts balance.yaml party to ticks.
func (w *World) initParty() {
	pc := w.cfg.Balance.Party
	w.invites = map[inviteKey]game.Tick{}
	w.inviteFor = ticksFor(pc.InviteMs)
	w.partyEvery = ticksFor(pc.UpdateMs)
	w.contribFor = ticksFor(pc.ContributionMs)
}

// partyCommand runs a PartyCommand.
func (w *World) partyCommand(ctx *game.TickContext, p *Player, m *pb.PartyCommand) {
	id := m.GetCreatureId()
	switch m.GetAction() {
	case pb.PartyAction_PARTY_ACTION_INVITE:
		w.invite(ctx, p, w.seenPlayer(p, id), "")
	case pb.PartyAction_PARTY_ACTION_ACCEPT:
		w.acceptInvite(ctx, p, id)
	case pb.PartyAction_PARTY_ACTION_DECLINE:
		w.declineInvite(p, id)
	case pb.PartyAction_PARTY_ACTION_LEAVE:
		if p.party == nil {
			p.emit(systemMsg(msgPartyNone))
			return
		}
		w.leaveParty(p)
	case pb.PartyAction_PARTY_ACTION_KICK:
		if o := w.memberForLeader(p, id); o != nil {
			o.emit(systemMsg(msgPartyYouKicked))
			w.leaveParty(o)
			// leaveParty told the rest "left"; the leader learns who it removed.
			p.emit(systemMsg(msgPartyKicked, textParam("name", o.name)))
		}
	case pb.PartyAction_PARTY_ACTION_PASS_LEADER:
		if o := w.memberForLeader(p, id); o != nil {
			p.party.leader = o
			p.party.dirty = true
			w.partyMsg(p.party, systemMsg(msgPartyLeader, textParam("name", o.name)))
		}
	case pb.PartyAction_PARTY_ACTION_SHARE_ON, pb.PartyAction_PARTY_ACTION_SHARE_OFF:
		on := m.GetAction() == pb.PartyAction_PARTY_ACTION_SHARE_ON
		switch {
		case p.party == nil:
			p.emit(systemMsg(msgPartyNone))
		case p.party.leader != p:
			p.emit(systemMsg(msgPartyNotLeader))
		case p.party.shared != on:
			p.party.shared, p.party.dirty = on, true
			key := msgPartySharedOff
			if on {
				key = msgPartySharedOn
			}
			w.partyMsg(p.party, systemMsg(key))
		}
	}
}

// seenPlayer returns the player id if p's client sees it (invisible players and players
// out of view are not found: a party is no way to look for them), or nil.
func (w *World) seenPlayer(p *Player, id uint32) *Player {
	if !p.Knows(id) {
		return nil
	}
	return w.playerByID(id)
}

// cmdInvite is "/invite Name": the same as PartyCommand INVITE, by name. Only a player
// p sees is found; anyone else gets the same answer as an offline name.
func (w *World) cmdInvite(ctx *game.TickContext, p *Player, args []string) {
	name := strings.Join(args, " ")
	if name == "" {
		if w.chatAllowed(ctx, p) {
			p.emit(systemMsg(msgPartyInviteUsage))
		}
		return
	}
	var o *Player
	if t := w.onlineByName(name); t != nil {
		o = w.seenPlayer(p, t.id)
	}
	w.invite(ctx, p, o, name)
}

// invite has p invite o (nil = not found; name is what p typed, if anything). Every
// attempt counts against p's chat anti-flood: an invitation pops up on o's screen.
func (w *World) invite(ctx *game.TickContext, p, o *Player, name string) {
	if !w.chatAllowed(ctx, p) {
		return
	}
	switch {
	case o == nil && name != "":
		p.emit(systemMsg(msgPartyNotFound, textParam("name", name)))
		return
	case o == nil:
		p.emit(systemMsg(msgPartyNotSeen))
		return
	case o == p:
		return
	case p.party != nil && p.party.leader != p:
		p.emit(systemMsg(msgPartyNotLeader))
		return
	case o.party != nil:
		p.emit(systemMsg(msgPartyHasParty, textParam("name", o.name)))
		return
	case p.party != nil && len(p.party.members) >= w.cfg.Balance.Party.MaxMembers:
		p.emit(systemMsg(msgPartyFull))
		return
	}
	key := inviteKey{from: p.id, to: o.id}
	if until, ok := w.invites[key]; ok && until > ctx.Tick {
		p.emit(systemMsg(msgPartyAlreadyAsked, textParam("name", o.name)))
		return
	}
	w.reveal(ctx, p) // inviting tells o who p is: it ends invisibility, like attacking
	until := ctx.Tick + w.inviteFor
	w.invites[key] = until
	ctx.Sched.After(w.inviteFor, func(*game.TickContext) {
		if w.invites[key] == until {
			delete(w.invites, key)
		}
	})
	p.emit(systemMsg(msgPartyInvited, textParam("name", o.name)))
	o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PartyInvitation{PartyInvitation: &pb.PartyInvitation{
		InviterId: p.id, InviterName: p.name, ExpiresMs: uint32(int64(w.inviteFor) * game.TickDuration.Milliseconds()),
	}}})
}

// acceptInvite has p accept the invitation of inviter: p joins the inviter's party (a
// new one, led by the inviter, if it had none).
func (w *World) acceptInvite(ctx *game.TickContext, p *Player, inviter uint32) {
	key := inviteKey{from: inviter, to: p.id}
	until, ok := w.invites[key]
	l := w.playerByID(inviter)
	if !ok || until <= ctx.Tick || l == nil || l.party != nil && l.party.leader != l {
		delete(w.invites, key)
		p.emit(systemMsg(msgPartyInviteGone))
		return
	}
	if p.party != nil {
		p.emit(systemMsg(msgPartyLeaveFirst))
		return
	}
	pt := l.party
	if pt == nil {
		pt = &party{leader: l, members: []*Player{l}}
		l.party = pt
		w.parties = append(w.parties, pt)
	} else if len(pt.members) >= w.cfg.Balance.Party.MaxMembers {
		p.emit(systemMsg(msgPartyFull))
		return
	}
	delete(w.invites, key)
	pt.members = append(pt.members, p)
	p.party = pt
	pt.dirty = true
	w.partyMsg(pt, systemMsg(msgPartyJoined, textParam("name", p.name)))
}

func (w *World) declineInvite(p *Player, inviter uint32) {
	key := inviteKey{from: inviter, to: p.id}
	if _, ok := w.invites[key]; !ok {
		return
	}
	delete(w.invites, key)
	if l := w.playerByID(inviter); l != nil {
		l.emit(systemMsg(msgPartyDeclined, textParam("name", p.name)))
	}
}

// memberForLeader returns the member id of p's party if p leads it and id is another
// member, telling p why not otherwise.
func (w *World) memberForLeader(p *Player, id uint32) *Player {
	switch {
	case p.party == nil:
		p.emit(systemMsg(msgPartyNone))
		return nil
	case p.party.leader != p:
		p.emit(systemMsg(msgPartyNotLeader))
		return nil
	}
	for _, o := range p.party.members {
		if o.id == id && o != p {
			return o
		}
	}
	p.emit(systemMsg(msgPartyNotAMember))
	return nil
}

// leaveParty takes p out of its party. A leader hands the party to the oldest member
// left; a party of one is disbanded.
func (w *World) leaveParty(p *Player) {
	pt := p.party
	if pt == nil {
		return
	}
	pt.members = slices.DeleteFunc(pt.members, func(o *Player) bool { return o == p })
	p.party, p.partyView, p.contributedAt = nil, nil, 0
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PartyUpdate{PartyUpdate: &pb.PartyUpdate{}}})
	if len(pt.members) < 2 {
		for _, o := range pt.members {
			o.party, o.partyView, o.contributedAt = nil, nil, 0
			o.emit(systemMsg(msgPartyDisbanded))
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PartyUpdate{PartyUpdate: &pb.PartyUpdate{}}})
		}
		w.parties = slices.DeleteFunc(w.parties, func(q *party) bool { return q == pt })
		return
	}
	w.partyMsg(pt, systemMsg(msgPartyLeft, textParam("name", p.name)))
	if pt.leader == p {
		pt.leader = pt.members[0]
		w.partyMsg(pt, systemMsg(msgPartyLeader, textParam("name", pt.leader.name)))
	}
	pt.dirty = true
}

// partyLeftWorld drops p's party membership and invitations when it leaves the world.
func (w *World) partyLeftWorld(p *Player) {
	w.leaveParty(p)
	for k := range w.invites {
		if k.from == p.id || k.to == p.id {
			delete(w.invites, k)
		}
	}
}

func (w *World) partyMsg(pt *party, m *pb.ServerMessage) {
	for _, o := range pt.members {
		o.emit(m)
	}
}

// partySay sends p's chat line to its party: no position travels, members out of view
// hear it too.
func (w *World) partySay(p *Player, text string) {
	msg := &pb.Message{Kind: pb.MessageKind_MESSAGE_KIND_PARTY, SpeakerId: p.id, SpeakerName: p.name,
		Body: &pb.Message_Text{Text: text}}
	w.partyMsg(p.party, &pb.ServerMessage{Message: &pb.ServerMessage_ChatMessage{ChatMessage: msg}})
}

// ---- shared experience -------------------------------------------------------------

// contribute marks that p just helped a fight: it hit a monster, healed a party member
// or a monster attacked it.
func (w *World) contribute(ctx *game.TickContext, p *Player) {
	if p != nil && p.party != nil {
		p.contributedAt = max(ctx.Tick, 1)
	}
}

// contributed reports whether p contributed recently.
func (w *World) contributed(now game.Tick, p *Player) bool {
	return p.contributedAt > 0 && now-p.contributedAt < w.contribFor
}

// sharers returns the members of pt that share a kill at pos (or, with near false, the
// ones that qualify wherever they are, among those viewer sees: the indicator). A member shares if it is active,
// close enough (near) and its level is at least level_range_pct % of the highest of the
// members that are active and close, or at most level_gap_always below it (anti-carry). Fewer than two sharers = no sharing.
func (w *World) sharers(now game.Tick, pt *party, pos world.Pos, viewer *Player, dst []*Player) []*Player {
	near := viewer == nil
	pc := w.cfg.Balance.Party
	dst = dst[:0]
	top := 0
	for _, o := range pt.members {
		if !near && o != viewer && !viewer.Knows(o.id) {
			continue
		}
		if w.contributed(now, o) && o.health > 0 && (!near || o.pos.Z == pos.Z && chebyshev(o.pos, pos) <= pc.ShareDistance) {
			dst = append(dst, o)
			top = max(top, o.level)
		}
	}
	dst = slices.DeleteFunc(dst, func(o *Player) bool {
		return o.level*100 < top*pc.LevelRangePct && top-o.level > pc.LevelGapAlways
	})
	if len(dst) < 2 {
		return dst[:0]
	}
	return dst
}

// shareExperience pays def experience xp of a kill at pos, split by damage (shares).
// The shares of members of a sharing party (party.shared and at least two sharers) go
// to a pot that grows by the bonus and is split equally among the sharers; every other
// share pays its owner, as without a party.
func (w *World) shareExperience(now game.Tick, pos world.Pos, xp int64, shares []damageShare) {
	total := 0
	for _, s := range shares {
		if w.playerByID(s.player) != nil {
			total += s.amount
		}
	}
	if total == 0 {
		return
	}
	type pot struct {
		pt      *party
		sharers []*Player
		xp      int64
	}
	var pots []pot
	potOf := func(p *Player) int {
		if p.party == nil || !p.party.shared {
			return -1
		}
		for i := range pots {
			if pots[i].pt == p.party {
				if slices.Contains(pots[i].sharers, p) {
					return i
				}
				return -1
			}
		}
		sh := w.sharers(now, p.party, pos, nil, nil)
		pots = append(pots, pot{pt: p.party, sharers: sh})
		if slices.Contains(sh, p) {
			return len(pots) - 1
		}
		return -1
	}
	for _, s := range shares {
		p := w.playerByID(s.player)
		if p == nil {
			continue
		}
		own := xp * int64(s.amount) / int64(total)
		if i := potOf(p); i >= 0 {
			pots[i].xp += own
		} else if own > 0 {
			w.gainExperience(p, own)
		}
	}
	pc := w.cfg.Balance.Party
	for _, pt := range pots {
		n := int64(len(pt.sharers))
		if pt.xp <= 0 || n < 2 {
			continue
		}
		bonus := min(int64(pc.BonusPctPerMember)*(n-1), int64(pc.MaxBonusPct))
		each := pt.xp * (100 + bonus) / 100 / n
		for _, o := range pt.sharers {
			if each > 0 {
				w.gainExperience(o, each)
			}
		}
	}
}

// ---- updates --------------------------------------------------------------------

// flushParties sends each member its PartyUpdate when its party changed, or at most
// every update_ms when what it sees of the others changed.
func (w *World) flushParties(now game.Tick) {
	for _, pt := range w.parties {
		w.islandBuf = w.islandBuf[:0]
		for _, o := range pt.members {
			w.islandBuf = append(w.islandBuf, w.islandAt(o.pos))
		}
		for _, v := range pt.members {
			if !pt.dirty && now < v.partyNext {
				continue
			}
			w.sendParty(now, pt, v)
		}
		pt.dirty = false
	}
}

// sendParty sends v its view of pt if it differs from the last one (or pt is dirty).
// Information audit: of the members v does not see, only name, vocation, level and
// island travel. Health, mana, "sharing" (alive and fighting) and the indicator are
// computed from the members v sees, so nothing tells v when a far member dies or fights.
func (w *World) sendParty(now game.Tick, pt *party, v *Player) {
	changed := pt.dirty || len(v.partyView) != len(pt.members)
	// view reuses v.partyView's array: element i is compared before it is overwritten.
	view := v.partyView[:0]
	sharing := 0
	w.partyBuf = w.partyBuf[:0]
	if pt.shared {
		w.partyBuf = w.sharers(now, pt, world.Pos{}, v, w.partyBuf)
	}
	for i, o := range pt.members {
		pv := partyView{id: o.id, level: o.level, inView: o == v || v.Knows(o.id), island: w.islandBuf[i]}
		if pv.inView {
			pv.health = healthPercent(o.health, o.maxHealth)
			pv.mana = healthPercent(o.mana, o.maxMana)
			pv.sharing = pt.shared && slices.Contains(w.partyBuf, o)
			if pv.sharing {
				sharing++
			}
		}
		if !changed && (i >= len(v.partyView) || v.partyView[i] != pv) {
			changed = true
		}
		view = append(view, pv)
	}
	state := pb.SharedExperience_SHARED_EXPERIENCE_OFF
	switch {
	case pt.shared && sharing >= 2:
		state = pb.SharedExperience_SHARED_EXPERIENCE_ACTIVE
	case pt.shared:
		state = pb.SharedExperience_SHARED_EXPERIENCE_INACTIVE
	}
	if state != v.partyState {
		v.partyState, changed = state, true
	}
	v.partyView = view
	v.partyNext = now + w.partyEvery
	if !changed {
		return
	}
	u := &pb.PartyUpdate{LeaderId: pt.leader.id, Shared: state, Members: make([]*pb.PartyMember, len(pt.members))}
	for i, o := range pt.members {
		pv := view[i]
		u.Members[i] = &pb.PartyMember{CreatureId: o.id, Name: o.name, Vocation: o.vocation.ID, Level: uint32(max(o.level, 0)),
			InView: pv.inView, HealthPercent: pv.health, ManaPercent: pv.mana, Island: pv.island, Sharing: pv.sharing}
	}
	v.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PartyUpdate{PartyUpdate: u}})
}

// islandAt returns the id of the island whose rectangle holds pos, or "".
func (w *World) islandAt(pos world.Pos) string {
	for _, is := range w.m.Islands() {
		if is.Rect.Contains(int(pos.X), int(pos.Y)) {
			return is.ID
		}
	}
	return ""
}
