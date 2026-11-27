package session

import (
	"slices"
	"strings"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Parties (T3.3, docs/02-game-design.md "Grupos"): a leader invites, the invited player
// accepts or declines before the invitation expires; a new party shares experience when
// balance.yaml party.shared_by_default says so, and the leader can turn it off and on.
// Everything runs on the loop; nothing is persisted: a member that leaves the world
// (logout, disconnect, re-login) leaves its party.
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
	msgPartySharedNew    = "party.shared_default"
	msgPartySharedOff    = "party.shared_off"
	msgPartyNotAMember   = "party.not_a_member"
	msgPartyInviteUsage  = "party.invite_usage"
	msgPartyAlreadyAsked = "party.already_invited"
	msgPartyInviteSelf   = "party.invite_self"
	msgPartyInviteRate   = "party.invite_rate"
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
	block   pb.ShareBlock
}

// initParty converts balance.yaml party to ticks.
func (w *World) initParty() {
	pc := w.cfg.Balance.Party
	w.invites = map[inviteKey]game.Tick{}
	w.inviteTAT = map[int64]game.Tick{}
	w.inviteFor = ticksFor(pc.InviteMs)
	w.inviteRefill = ticksFor(60_000 / max(pc.InvitesPerMinute, 1))
	w.inviteBurst = w.inviteRefill * game.Tick(max(pc.InvitesPerMinute-1, 0))
	w.partyEvery = ticksFor(pc.UpdateMs)
	w.contribFor = ticksFor(pc.ContributionMs)
}

// partyCommand runs a PartyCommand.
func (w *World) partyCommand(ctx *game.TickContext, p *Player, m *pb.PartyCommand) {
	id := m.GetCreatureId()
	switch m.GetAction() {
	case pb.PartyAction_PARTY_ACTION_INVITE:
		w.invite(ctx, p, w.seenPlayer(p, id), "")
	case pb.PartyAction_PARTY_ACTION_INVITE_NAME:
		// Empty, or far longer than any name (the client caps the field at
		// auth.MaxKnownNameLen characters, up to 4 bytes each): a malformed intent, ignored.
		// The name comes back in the answer: cleaned like chat (no control characters).
		if raw := m.GetName(); len(raw) <= 4*auth.MaxKnownNameLen {
			if name := cleanChat(raw); name != "" {
				w.invite(ctx, p, w.onlineFor(p, name), name)
			}
		}
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
		// Each change speaks to every member: it counts against the chat anti-flood.
		if o := w.memberForLeader(p, id); o != nil && w.chatAllowed(ctx, p) {
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
		case p.party.shared != on && w.chatAllowed(ctx, p): // like PASS_LEADER
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

// onlineFor finds the online player called name (case-insensitive, exact) for p,
// wherever it is. An invisible player p does not see is not found: answering otherwise
// would tell p that it is online and hiding (like /report).
func (w *World) onlineFor(p *Player, name string) *Player {
	o := w.onlineByName(name)
	if o != nil && o != p && o.invisible && !p.Knows(o.id) {
		return nil
	}
	return o
}

// cmdInvite is "/invite Name": the same as PartyCommand INVITE_NAME (the party
// window's button), so the invited player may be anywhere.
func (w *World) cmdInvite(ctx *game.TickContext, p *Player, args []string) {
	name := strings.Join(args, " ")
	if name == "" {
		if w.chatAllowed(ctx, p) {
			p.emit(systemMsg(msgPartyInviteUsage))
		}
		return
	}
	w.invite(ctx, p, w.onlineFor(p, name), name)
}

// invite has p invite o (nil = not found; name is what p typed, if anything). Every
// attempt counts against p's chat anti-flood (an invitation pops up on o's screen) and
// against party.invites_per_minute, found or not: an offline name answers like an
// unknown one, and nobody can probe many names for who is online.
func (w *World) invite(ctx *game.TickContext, p, o *Player, name string) {
	if !w.chatAllowed(ctx, p) || !w.inviteAllowed(ctx, p) {
		return
	}
	switch {
	case o == p:
		p.emit(systemMsg(msgPartyInviteSelf))
		return
	case o == nil && name != "":
		p.emit(systemMsg(msgPartyNotFound, textParam("name", name)))
		return
	case o == nil:
		p.emit(systemMsg(msgPartyNotSeen))
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

// inviteAllowed counts one invitation attempt of p against party.invites_per_minute
// (GCRA, like the chat anti-flood but with no mute): past the burst, p is told how many
// seconds to wait and nothing else happens. The count belongs to the account, in the
// World: logging in again, or the account's other character, gets no fresh burst of
// names to try.
func (w *World) inviteAllowed(ctx *game.TickContext, p *Player) bool {
	now := ctx.Tick
	tat := max(w.inviteTAT[p.accountID], now)
	if tat-now > w.inviteBurst {
		p.emit(systemMsg(msgPartyInviteRate, num("seconds", seconds(tat-now-w.inviteBurst))))
		return false
	}
	tat += w.inviteRefill
	account := p.accountID
	w.inviteTAT[account] = tat
	// Forgotten once it is in the past (a later attempt replaced it otherwise).
	ctx.Sched.After(tat-now, func(*game.TickContext) {
		if w.inviteTAT[account] == tat {
			delete(w.inviteTAT, account)
		}
	})
	return true
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
		pt = &party{leader: l, members: []*Player{l}, shared: w.cfg.Balance.Party.SharedByDefault}
		l.party = pt
		w.parties = append(w.parties, pt)
		if pt.shared {
			defer w.partyMsg(pt, systemMsg(msgPartySharedNew)) // after "joined": both hear it
		}
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
// or a monster attacked it. A link-dead p helps nothing (a monster biting it would keep
// it a sharer of its party's kills offline).
func (w *World) contribute(ctx *game.TickContext, p *Player) {
	if p != nil && p.party != nil && !p.linkDead {
		p.contributedAt = max(ctx.Tick, 1)
	}
}

// contributed reports whether p contributed recently.
func (w *World) contributed(now game.Tick, p *Player) bool {
	return p.contributedAt > 0 && now-p.contributedAt < w.contribFor
}

// shareNear reports whether a member at at is close enough to a kill at pos to share
// it: on its floor and within share_distance.
func (w *World) shareNear(at, pos world.Pos) bool {
	return at.Z == pos.Z && chebyshev(at, pos) <= w.cfg.Balance.Party.ShareDistance
}

// sharers returns the members of pt that share a kill at pos. The indicator of the
// party window asks it with the position of who looks: who would share a kill next to
// that member. A member shares if it is active, close enough (shareNear) and its level
// is at least level_range_pct %
// of the highest of the members that are active and close, or at most level_gap_always
// below it (anti-carry; alts count for the highest level too). Two characters of one
// account are one sharer: the first in join order that passed the level filter, so a
// low alt never costs its main the bonus; alts never grow the bonus and the other keeps
// its own damage share. A character without an account (id 0: hand-built test or bot
// characters) is never merged with another. Fewer than two sharers = no sharing.
func (w *World) sharers(now game.Tick, pt *party, pos world.Pos, dst []*Player) []*Player {
	pc := w.cfg.Balance.Party
	dst = dst[:0]
	top := 0
	for _, o := range pt.members {
		if w.contributed(now, o) && o.health > 0 && w.shareNear(o.pos, pos) {
			dst = append(dst, o)
			top = max(top, o.level)
		}
	}
	n := 0
	for _, o := range dst {
		if !pc.InLevelRange(o.level, top) {
			continue
		}
		if o.accountID != 0 && sameAccount(dst[:n], o.accountID) {
			continue
		}
		dst[n] = o
		n++
	}
	clear(dst[n:])
	if n < 2 {
		return dst[:0]
	}
	return dst[:n]
}

// sameAccount reports whether one of ps belongs to account acc.
func sameAccount(ps []*Player, acc int64) bool {
	for _, q := range ps {
		if q.accountID == acc {
			return true
		}
	}
	return false
}

// shareBlock tells why o, a member of pt, is not among the sharers of a kill next to v
// (sharers at v.pos): the first reason of sharers that leaves it out. Information
// audit: a reason says no more than the experience v gets from a kill already does
// (who shared it), but that two characters are of one account is told only to that
// account; anyone else gets no reason for the second one.
func (w *World) shareBlock(now game.Tick, pt *party, v, o *Player) pb.ShareBlock {
	if !w.shareNear(o.pos, v.pos) {
		return pb.ShareBlock_SHARE_BLOCK_FAR
	}
	if o.health <= 0 {
		return pb.ShareBlock_SHARE_BLOCK_DEAD
	}
	if !w.contributed(now, o) {
		return pb.ShareBlock_SHARE_BLOCK_IDLE
	}
	// The same candidates as sharers at v.pos: active members close to v.
	pc := w.cfg.Balance.Party
	top := 0
	for _, q := range pt.members {
		if w.shareNear(q.pos, v.pos) && q.health > 0 && w.contributed(now, q) {
			top = max(top, q.level)
		}
	}
	if !pc.InLevelRange(o.level, top) {
		return pb.ShareBlock_SHARE_BLOCK_LEVEL
	}
	if o.accountID != 0 {
		for _, q := range pt.members {
			if q == o {
				break
			}
			if q.accountID == o.accountID && w.shareNear(q.pos, v.pos) && q.health > 0 && w.contributed(now, q) &&
				pc.InLevelRange(q.level, top) {
				if v.accountID != o.accountID {
					return pb.ShareBlock_SHARE_BLOCK_UNSPECIFIED
				}
				return pb.ShareBlock_SHARE_BLOCK_ACCOUNT
			}
		}
	}
	return pb.ShareBlock_SHARE_BLOCK_ALONE
}

// sharePot is the experience the members of one party pool from a kill.
type sharePot struct {
	pt      *party
	sharers []*Player
	xp      int64
}

// shareExperience pays def experience xp of a kill at pos, split by damage (shares).
// The shares of members of a sharing party (party.shared and at least two sharers) go
// to a pot that grows by the bonus of its number of sharers (party.bonus_pct_by_sharers)
// and is split equally among them; every other share pays its owner, as without a party.
//
// It returns the players that get quest credit for the kill besides those that damaged
// the monster: the sharers of a pot one of its sharers hit into. The eligibility is that
// of the pot (sharers: party.shared, alive, on the floor and within share_distance,
// contributed, level range, one per account), so a member that is far, dead, idle or out
// of level range gets nothing, and nobody is listed twice. The pots are worked out once,
// before anything is paid: a level up never changes who shared, and the experience and
// the quest credit cannot disagree.
func (w *World) shareExperience(now game.Tick, pos world.Pos, xp int64, shares []damageShare) []*Player {
	// Every share counts toward the total, online or not: the share of a player that
	// left the world (logout, re-login with a new id) is lost, never handed to the rest.
	total := 0
	for _, s := range shares {
		total += s.amount
	}
	// One pot per sharing party of the players that hit, in the order of shares.
	var pots []sharePot
	for _, s := range shares {
		p := w.playerByID(s.player)
		if p == nil || p.party == nil || !p.party.shared ||
			slices.ContainsFunc(pots, func(pt sharePot) bool { return pt.pt == p.party }) {
			continue
		}
		pots = append(pots, sharePot{pt: p.party, sharers: w.sharers(now, p.party, pos, nil)})
	}
	potOf := func(p *Player) int {
		if p.party == nil {
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
		return -1
	}
	hit := func(o *Player) bool {
		return slices.ContainsFunc(shares, func(d damageShare) bool { return d.player == o.id })
	}
	var partners []*Player
	for _, pt := range pots {
		// A pot none of whose sharers hit the monster (its damager is too far or out of
		// level range) shares nothing. A player is in one party, so no one is listed twice.
		if !slices.ContainsFunc(pt.sharers, hit) {
			continue
		}
		for _, o := range pt.sharers {
			if !hit(o) {
				partners = append(partners, o)
			}
		}
	}
	if total == 0 {
		return partners
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
		// extra is the bonus part, shown apart on the floating number.
		each, extra := pc.SharedEach(pt.xp, len(pt.sharers))
		for _, o := range pt.sharers {
			if each > 0 {
				w.gainExperienceBonus(o, each, extra)
			}
		}
	}
	return partners
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
// island travel, and whether each would share a kill next to v ("sharing", or why not:
// shareBlock), which is what the experience of v's kills already tells: a member that
// is not on v's floor within share_distance is only FAR. Health and mana are of the
// members v sees. Level and island do travel and may change after a far death
// (experience loss) or level up; that is accepted.
func (w *World) sendParty(now game.Tick, pt *party, v *Player) {
	changed := pt.dirty || len(v.partyView) != len(pt.members)
	// view reuses v.partyView's array: element i is compared before it is overwritten.
	view := v.partyView[:0]
	sharing := 0
	w.partyBuf = w.partyBuf[:0]
	if pt.shared {
		w.partyBuf = w.sharers(now, pt, v.pos, w.partyBuf)
	}
	for i, o := range pt.members {
		pv := partyView{id: o.id, level: o.level, inView: o == v || v.Knows(o.id), island: w.islandBuf[i]}
		if pv.inView {
			pv.health = healthPercent(o.health, o.maxHealth)
			pv.mana = healthPercent(o.mana, o.maxMana)
		}
		if pt.shared {
			if pv.sharing = slices.Contains(w.partyBuf, o); pv.sharing {
				sharing++
			} else {
				pv.block = w.shareBlock(now, pt, v, o)
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
	if state == pb.SharedExperience_SHARED_EXPERIENCE_ACTIVE {
		u.BonusPercent = uint32(w.cfg.Balance.Party.BonusPct(sharing))
	}
	for i, o := range pt.members {
		pv := view[i]
		u.Members[i] = &pb.PartyMember{CreatureId: o.id, Name: o.name, Vocation: o.vocation.ID, Level: uint32(max(o.level, 0)),
			InView: pv.inView, HealthPercent: pv.health, ManaPercent: pv.mana, Island: pv.island, Sharing: pv.sharing, ShareBlock: pv.block}
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
