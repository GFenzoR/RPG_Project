package session

import (
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Player houses (T5.4, docs/02-game-design.md "Casas", docs/01 "Persistencia").
//
// The houses are map data (world.House: tiles, doors, exit, rent). The loop owns who rents
// each one, its guests and the items on its tiles, loaded once before it starts
// (Config.Houses), like the market. Every change leaves as a Transfer with HouseOps:
//   - owner, rent and guest changes, in the tick of the command, with the snapshot of the
//     online character that paid or got paid;
//   - the items of a house: whenever a tile of a house (or a container lying on one)
//     changes, the house is marked dirty, and the dirty houses of a tick leave as ONE
//     transfer with each house's whole item list (replaced in the database) and the
//     snapshots of the players whose commands touched them in that tick. It is flushed
//     before any later job (submitJob) and at the end of the tick, so a crash never keeps
//     an item both in an inventory and on the floor of a house, or in neither.
// Rent is paid in advance from the backpack; when it runs out, the next period is taken
// from the owner's market mailbox gold (it works offline); without enough, the house is
// released and its items go to the owner's mailbox, in the same transfer.

// i18n keys of the house messages (i18n/*/client.yaml).
const (
	msgHouseClosed       = "house.closed"
	msgHouseStaff        = "house.staff"
	msgHouseNotHere      = "house.not_at_door"
	msgHouseTooFast      = "house.too_fast"
	msgHouseReadOnly     = "house.read_only"
	msgHouseNoAccess     = "house.no_access"
	msgHouseLevel        = "house.level_required"
	msgHouseHasOne       = "house.has_house"
	msgHouseTaken        = "house.taken"
	msgHouseNoMoney      = "house.not_enough_money"
	msgHouseRented       = "house.rented"
	msgHouseExtended     = "house.extended"
	msgHouseMaxPeriods   = "house.max_periods"
	msgHouseLeft         = "house.left"
	msgHouseNotOwner     = "house.not_owner"
	msgHouseGuestBad     = "house.guest_bad_name"
	msgHouseGuestsFull   = "house.guests_full"
	msgHouseGuestAdded   = "house.guest_added"
	msgHouseGuestRemoved = "house.guest_removed"
	msgHouseGuildOn      = "house.guild_on"
	msgHouseGuildOff     = "house.guild_off"
	msgHouseOfferBad     = "house.transfer_bad"
	msgHouseOffered      = "house.transfer_offered"
	msgHouseOfferedYou   = "house.transfer_for_you"
	msgHouseOfferNone    = "house.transfer_none"
	msgHouseOfferOff     = "house.transfer_cancelled"
	msgHouseTransferred  = "house.transfer_done"
	msgHouseGivenAway    = "house.transferred_away"
	msgHouseFull         = "house.full"
	msgHouseTakeOut      = "house.owner_only"
	msgHouseExpelled     = "house.expelled"
	msgHouseRenewed      = "house.renewed"
	msgHouseLost         = "house.lost_unpaid"
	msgHouseEvicted      = "house.evicted"
	msgHouseItemsMailed  = "house.items_mailed"
	msgHouseLookFree     = "house.look_free"
	msgHouseLookOwned    = "house.look_owned"
	msgGMHouseInfo       = "gm.house_info"
	msgGMHouseFree       = "gm.house_free"
	msgGMHouseUnknown    = "gm.house_unknown"
	msgGMHouseEvicted    = "gm.house_evicted"
	msgGMHouseMoved      = "gm.house_moved"
	msgGMHouseNoTarget   = "gm.house_no_target"
)

// HouseOwner is who rents a house (house_owners).
type HouseOwner struct {
	HouseID     string
	CharacterID int64
	AccountID   int64
	Name        string
	PaidUntil   time.Time
	Since       time.Time
	GuildAccess bool
}

// HouseItem is one item lying on a tile of a house (house_items): Seq is its place in
// the tile's stack (0 first); Item is the whole instance with its content.
type HouseItem struct {
	HouseID string
	Pos     world.Pos
	Seq     int
	Item    ItemState
}

// HouseData is the house state loaded before the loop starts.
type HouseData struct {
	Owners []HouseOwner
	// Guests are the guest names by house id.
	Guests map[string][]string
	Items  []HouseItem
}

// HouseOpKind says what a HouseOp changes.
type HouseOpKind uint8

// House changes. The store applies them in order inside the transfer's transaction,
// each guarded: a change of an owner the database does not have fails the transfer.
const (
	// HouseOwnerAdd inserts Owner (the house must be free).
	HouseOwnerAdd HouseOpKind = iota + 1
	// HouseOwnerChange gives house House of CharacterID to Owner (guests cleared).
	HouseOwnerChange
	// HouseOwnerRemove frees house House of CharacterID (its guests go with it).
	HouseOwnerRemove
	// HousePaid sets the rent of house House of CharacterID paid until PaidUntil.
	HousePaid
	// HouseAccess sets the guild switch and the guest list of house House of CharacterID.
	HouseAccess
	// HouseItems replaces every item of house House with Items.
	HouseItems
)

// HouseOp is one house change of a Transfer.
type HouseOp struct {
	Kind        HouseOpKind
	House       string
	CharacterID int64
	Owner       HouseOwner
	PaidUntil   time.Time
	GuildAccess bool
	Guests      []string
	Items       []HouseItem
}

// house is the loop's state of one house of the map.
type house struct {
	def *world.House
	// owner is the character renting it (0: free).
	owner       int64
	ownerAcc    int64
	ownerName   string
	paidUntil   time.Time
	since       time.Time
	guildAccess bool
	guests      []string // as typed (validated names), compared ignoring case
	offer       *houseOffer
	size        int
	// dirty: its items changed this tick (World.houseDirty).
	dirty bool
}

// houseOffer is a pending transfer of a house to another character.
type houseOffer struct {
	to     int64
	toName string
	price  int64
	until  game.Tick
}

// houseView is the house window a player has open.
type houseView struct{ h *house }

// houseSweepBatch bounds the houses one rent sweep looks at (round robin).
const houseSweepBatch = 32

func (w *World) initHouses() {
	hs := w.cfg.Balance.Houses
	w.houseByID = map[string]*house{}
	w.houseByOwner = map[int64]*house{}
	w.houseByAcc = map[int64]*house{}
	w.houseOrphans = map[int64]bool{}
	for _, def := range w.m.Houses() {
		h := &house{def: def}
		for _, r := range def.Rects {
			h.size += int(r.W) * int(r.H)
		}
		w.houseByID[def.ID] = h
		w.houseList = append(w.houseList, h)
	}
	if !hs.Enabled || !w.mkOn || w.cfg.Transfer == nil || len(w.houseList) == 0 {
		return
	}
	w.houseOn, w.hs = true, hs
	w.hsRefill = max(game.Tick(hs.ActionRefillMs/int(game.TickDuration.Milliseconds())), 1)
	w.hsBurst = w.hsRefill * game.Tick(hs.ActionBurst-1)
	w.hsPeriod = time.Duration(hs.PeriodDays) * 24 * time.Hour
	d := w.cfg.Houses
	if d == nil {
		return
	}
	for _, o := range d.Owners {
		h := w.houseByID[o.HouseID]
		if h == nil {
			// A house removed from the map: its row stays in the database (an operator
			// decides; the items there too). Logged.
			// The account still owns it in the database (one house per account): it may not
			// rent another until an operator frees that row.
			w.log.Warn("house: owner of a house that is not on the map", "house", o.HouseID, "character", o.CharacterID)
			w.houseOrphans[o.AccountID] = true
			continue
		}
		w.setOwner(h, o)
		h.guests = append([]string(nil), d.Guests[o.HouseID]...)
	}
	for _, it := range d.Items {
		h := w.houseByID[it.HouseID]
		if h == nil || !h.def.Contains(it.Pos) {
			w.log.Warn("house: saved item outside its house dropped", "house", it.HouseID, "pos", it.Pos.String())
			continue
		}
		if x := w.loadItem(it.Item); x != nil {
			w.drop(x, it.Pos)
		}
	}
}

func (w *World) setOwner(h *house, o HouseOwner) {
	if h.owner != 0 {
		delete(w.houseByOwner, h.owner)
		delete(w.houseByAcc, h.ownerAcc)
	}
	h.owner, h.ownerAcc, h.ownerName = o.CharacterID, o.AccountID, o.Name
	h.paidUntil, h.since, h.guildAccess = o.PaidUntil, o.Since, o.GuildAccess
	h.guests, h.offer = nil, nil
	if h.owner != 0 {
		w.houseByOwner[h.owner] = h
		w.houseByAcc[h.ownerAcc] = h
	}
}

func (w *World) clearOwner(h *house) {
	w.setOwner(h, HouseOwner{})
}

// maxItems is how many item instances h may hold.
func (w *World) maxItems(h *house) int { return h.size * w.hs.ItemsPerTile }

// ---- access ---------------------------------------------------------------------------

// houseAccess reports whether p may enter h: its owner, a guest, a member of the owner's
// guild when the owner allows it, or staff.
func (w *World) houseAccess(p *Player, h *house) bool {
	if p.role > RolePlayer {
		return true
	}
	if h.owner == 0 {
		return false
	}
	if p.charID == h.owner {
		return true
	}
	for _, g := range h.guests {
		if strings.EqualFold(g, p.name) {
			return true
		}
	}
	if h.guildAccess && p.gm != nil {
		if om := w.guildMembers[h.owner]; om != nil && om.g == p.gm.g {
			return true
		}
	}
	return false
}

// houseAt returns the house of the tile pos, or nil.
func (w *World) houseAt(pos world.Pos) *house {
	if w.m.Flags(pos)&world.FlagHouse == 0 {
		return nil
	}
	if def := w.m.HouseAt(pos); def != nil {
		return w.houseByID[def.ID]
	}
	return nil
}

// mayEnter reports whether p may step onto to (T5.4): a house tile needs access. A
// player already inside may always walk inside the same house (the sweep moves out
// whoever lost the access).
func (w *World) mayEnter(p *Player, to world.Pos) bool {
	if !w.houseOn || w.m.Flags(to)&world.FlagHouse == 0 {
		return true
	}
	h := w.houseAt(to)
	return h == nil || w.houseAccess(p, h)
}

// houseExit is where a player that may not stay in h goes: its exit, or the closest
// free tile around it outside every house.
func (w *World) houseExit(h *house) world.Pos {
	e := h.def.Exit
	for r := 0; r <= 3; r++ {
		for dy := -r; dy <= r; dy++ {
			for dx := -r; dx <= r; dx++ {
				if max(abs(dx), abs(dy)) != r {
					continue
				}
				x, y := int(e.X)+dx, int(e.Y)+dy
				if x < 0 || y < 0 || x > 0xFFFF || y > 0xFFFF {
					continue
				}
				q := world.Pos{X: uint16(x), Y: uint16(y), Z: e.Z}
				if w.m.Walkable(q) && w.m.Flags(q)&world.FlagHouse == 0 && !w.occupied(q) {
					return q
				}
			}
		}
	}
	return e
}

// expel moves p out of h to its exit.
func (w *World) expel(p *Player, h *house) {
	w.Teleport(p, w.houseExit(h))
	p.emit(systemMsg(msgHouseExpelled))
}

// expelIntruders moves out of h every player inside it without access.
func (w *World) expelIntruders(h *house) {
	for _, p := range slices.Clone(w.players) {
		if w.m.Flags(p.pos)&world.FlagHouse != 0 && h.def.Contains(p.pos) && !w.houseAccess(p, h) {
			w.expel(p, h)
		}
	}
}

// houseLogin returns where p appears when it logs in at pos: the exit of the house it
// stands in if it may no longer be there (logout inside is safe, T5.4).
func (w *World) houseLogin(p *Player, pos world.Pos) world.Pos {
	if !w.houseOn {
		return pos
	}
	if h := w.houseAt(pos); h != nil && !w.houseAccess(p, h) {
		return w.houseExit(h)
	}
	return pos
}

// ---- items ----------------------------------------------------------------------------

// itemHouse returns the house whose floor holds it (directly or inside a container on
// it), or nil.
func (w *World) itemHouse(it *Item) *house {
	if !w.houseOn {
		return nil
	}
	r := it.root()
	if !r.onGround {
		return nil
	}
	return w.houseAt(r.pos)
}

// placeHouse returns the house a MoveItem destination lies in, or nil.
func (w *World) placeHouse(to place) *house {
	if !w.houseOn {
		return nil
	}
	switch to.kind {
	case locGround:
		return w.houseAt(to.pos)
	case locContainer:
		return w.itemHouse(to.cont)
	}
	return nil
}

// instances is how many item instances it is: itself and everything inside it.
func instances(it *Item) int {
	n := 1
	for _, c := range it.items {
		n += instances(c)
	}
	return n
}

// isCorpse reports whether it is the remains of a creature (they decay: never kept).
func (w *World) isCorpse(it *Item) bool {
	for _, c := range w.corpses[it.pos] {
		if c.Item == it {
			return true
		}
	}
	return false
}

// houseCount is how many item instances lie in h.
func (w *World) houseCount(h *house) int {
	n := 0
	w.eachHouseTile(h, func(pos world.Pos) {
		for _, it := range w.ground[pos] {
			if !w.isCorpse(it) {
				n += instances(it)
			}
		}
	})
	return n
}

func (w *World) eachHouseTile(h *house, fn func(world.Pos)) {
	for _, r := range h.def.Rects {
		for y := int(r.Y); y < int(r.Y)+int(r.H); y++ {
			for x := int(r.X); x < int(r.X)+int(r.W); x++ {
				fn(world.Pos{X: uint16(x), Y: uint16(y), Z: r.Z})
			}
		}
	}
}

// houseItems lists the items of h as saved (corpses left out: they decay).
func (w *World) houseItems(h *house) []HouseItem {
	var out []HouseItem
	w.eachHouseTile(h, func(pos world.Pos) {
		for i, it := range w.ground[pos] {
			if !w.isCorpse(it) {
				out = append(out, HouseItem{HouseID: h.def.ID, Pos: pos, Seq: i, Item: it.state(0)})
			}
		}
	})
	return out
}

// checkHouseMove applies the house rules to a MoveItem of it (count units) from its
// place to `to` by p: access to both ends, only the owner takes items out, the item
// limit and the anti-flood. split: the move leaves part of a stack behind without
// merging (one more instance). It reports whether the move may go on.
func (w *World) checkHouseMove(ctx *game.TickContext, p *Player, it *Item, to place, merge *Item, split bool) bool {
	if !w.houseOn {
		return true
	}
	from, dest := w.itemHouse(it), w.placeHouse(to)
	if from == nil && dest == nil {
		return true
	}
	switch {
	case w.readOnly:
		p.emit(systemMsg(msgHouseReadOnly))
		return false
	case from != nil && !w.houseAccess(p, from), dest != nil && !w.houseAccess(p, dest):
		p.emit(systemMsg(msgHouseNoAccess))
		return false
	case from != nil && from != dest && p.charID != from.owner && p.role == RolePlayer:
		// Guests may bring and arrange items, never take them out (docs/02 "Casas").
		p.emit(systemMsg(msgHouseTakeOut))
		return false
	}
	if dest != nil {
		added := 0
		switch {
		case from != dest && merge == nil:
			added = instances(it)
		case from == dest && split && merge == nil:
			added = 1
		}
		if added > 0 && w.houseCount(dest)+added > w.maxItems(dest) {
			p.emit(systemMsg(msgHouseFull, num("max", w.maxItems(dest))))
			return false
		}
	}
	return w.houseFlood(ctx, p)
}

// mayUseInHouse reports whether p may use (open, eat, read) it: an item in a house needs
// access.
func (w *World) mayUseInHouse(p *Player, it *Item) bool {
	h := w.itemHouse(it)
	switch {
	case h == nil:
		return true
	case !w.houseAccess(p, h):
		p.emit(systemMsg(msgHouseNoAccess))
		return false
	case it.def.Container == nil && p.charID != h.owner && p.role == RolePlayer:
		// A guest opens containers but never uses up (eats, casts) what is in the house:
		// that would take it out (docs/02 "Casas").
		p.emit(systemMsg(msgHouseTakeOut))
		return false
	}
	return true
}

// houseFlood counts one house action against its anti-flood limit (GCRA).
func (w *World) houseFlood(ctx *game.TickContext, p *Player) bool {
	tat := max(p.hsTAT, ctx.Tick)
	if tat-ctx.Tick > w.hsBurst {
		p.emit(systemMsg(msgHouseTooFast))
		return false
	}
	p.hsTAT = tat + w.hsRefill
	return true
}

// houseTouched marks the house of pos dirty (its items changed): called for every tile
// change and every change of a container lying on the ground.
func (w *World) houseTouched(pos world.Pos) {
	if !w.houseOn {
		return
	}
	h := w.houseAt(pos)
	if h == nil {
		return
	}
	if !h.dirty {
		h.dirty = true
		w.houseDirty = append(w.houseDirty, h)
	}
	if p := w.cmdPlayer; p != nil && !slices.Contains(w.houseActors, p) {
		w.houseActors = append(w.houseActors, p)
	}
}

// flushHouses writes the item changes of the dirty houses as one transfer, with the
// snapshots of the online players whose commands changed them. It runs before any other
// job is submitted (submitJob) and at the end of every tick.
func (w *World) flushHouses() {
	if w.houseFlushing {
		return
	}
	if len(w.houseDirty) == 0 {
		clear(w.houseActors)
		w.houseActors = w.houseActors[:0]
		return
	}
	w.houseFlushing = true
	defer func() { w.houseFlushing = false }()
	var ops []HouseOp
	for _, h := range w.houseDirty {
		h.dirty = false
		ops = append(ops, HouseOp{Kind: HouseItems, House: h.def.ID, Items: w.houseItems(h)})
	}
	w.houseDirty = w.houseDirty[:0]
	var players []*Player
	for _, p := range w.houseActors {
		if w.byChar[p.charID] == p {
			players = append(players, p)
		}
	}
	clear(w.houseActors)
	w.houseActors = w.houseActors[:0]
	w.houseTransfer(players, ops)
}

// houseTransfer submits a transfer with the snapshots of players and house (and market)
// changes.
func (w *World) houseTransfer(players []*Player, ops []HouseOp, market ...MarketOp) {
	w.nextTransfer++
	t := Transfer{ID: w.nextTransfer, Houses: ops, Market: market, OfferHigh: w.nextOffer, MailHigh: w.nextMail}
	for _, p := range players {
		t.Snapshots = append(t.Snapshots, w.snapshot(p, false))
	}
	w.submitJob(Job{Transfer: &t})
}

// ---- the window -----------------------------------------------------------------------

// useHouseDoor opens the house window if m points at a door tile of a house (any item of
// the tile). It reports whether m was about a door.
func (w *World) useHouseDoor(ctx *game.TickContext, p *Player, m *pb.UseItem) bool {
	pos, ok := posFromMsg(m.GetFrom().GetPos())
	if !ok || len(w.houseList) == 0 || w.m.Flags(pos)&world.FlagHouse == 0 {
		return false
	}
	h := w.houseAt(pos)
	if h == nil || !slices.Contains(h.def.Doors, pos) {
		return false
	}
	// Items lying on the door tile are used as usual (a container opens).
	if int(m.GetStackIndex()) >= w.staticCount(pos) && len(w.ground[pos]) > 0 {
		return false
	}
	switch {
	case !w.houseOn:
		p.emit(systemMsg(msgHouseClosed))
	case pos.Z != p.pos.Z || !w.near(p, pos):
		p.emit(systemMsg(msgTooFar))
	default:
		p.house = &houseView{h: h}
		p.active(ctx.Tick, antibot.KindOther)
		w.sendHouse(p)
	}
	return true
}

// atHouse reports whether p may act on its open house window: next to a door of the
// house or inside it.
func (w *World) atHouse(p *Player) bool {
	if !w.houseOn {
		return false
	}
	if p.house == nil {
		p.emit(systemMsg(msgHouseNotHere))
		return false
	}
	if !w.nearHouse(p, p.house.h) {
		w.closeHouse(p)
		p.emit(systemMsg(msgHouseNotHere))
		return false
	}
	return true
}

func (w *World) nearHouse(p *Player, h *house) bool {
	if h.def.Contains(p.pos) {
		return true
	}
	for _, d := range h.def.Doors {
		if w.near(p, d) {
			return true
		}
	}
	return false
}

// checkHouseView closes the window of a player that walked away from its house.
func (w *World) checkHouseView(p *Player) {
	if p.house != nil && !w.nearHouse(p, p.house.h) {
		w.closeHouse(p)
	}
}

func (w *World) closeHouse(p *Player) {
	if p.house == nil {
		return
	}
	p.house = nil
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_HouseUpdate{HouseUpdate: &pb.HouseUpdate{}}})
}

// sendHouse sends p its house window.
func (w *World) sendHouse(p *Player) {
	h := p.house.h
	hs := w.hs
	u := &pb.HouseUpdate{
		Open: true, HouseId: h.def.ID, Name: h.def.Name, Island: h.def.Island, Rent: uint64(h.def.Rent),
		PeriodDays: uint32(hs.PeriodDays), Size: uint32(h.size), Owner: h.ownerName, IsOwner: h.owner == p.charID,
		MaxGuests: uint32(hs.MaxGuests), Items: uint32(w.houseCount(h)), MaxItems: uint32(w.maxItems(h)),
		MinLevel: uint32(hs.MinLevel), MaxPeriods: uint32(hs.MaxPeriods), Money: uint64(max(w.money(p), 0)),
		ReadOnly: w.readOnly, Access: w.houseAccess(p, h),
	}
	if u.IsOwner {
		u.PaidUntil = uint64(max(h.paidUntil.UnixMilli(), 0))
		u.Guests = append(u.Guests, h.guests...)
		u.GuildAccess = h.guildAccess
	}
	if o := h.offer; o != nil {
		switch {
		case u.IsOwner:
			u.TransferTo, u.TransferPrice = o.toName, uint64(o.price)
		case o.to == p.charID:
			u.TransferTo, u.TransferPrice, u.TransferForMe = o.toName, uint64(o.price), true
		}
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_HouseUpdate{HouseUpdate: u}})
}

// refreshHouse sends the window again to everyone who has h open.
func (w *World) refreshHouse(h *house) {
	for _, p := range w.players {
		if p.house != nil && p.house.h == h {
			w.sendHouse(p)
		}
	}
}

// houseParam is the house name as a message parameter ("house.<id>.name").
func houseParam(h *house) *pb.TextParam {
	return &pb.TextParam{Name: "house", Value: &pb.TextParam_ContentId{ContentId: h.def.ID}}
}

// lookHouse tells p, after a look at a door tile, whose house it is or that it is free.
func (w *World) lookHouse(p *Player, pos world.Pos) {
	if !w.houseOn {
		return
	}
	h := w.houseAt(pos)
	if h == nil || !slices.Contains(h.def.Doors, pos) {
		return
	}
	if h.owner == 0 {
		p.emit(systemMsg(msgHouseLookFree, houseParam(h), num("price", int(h.def.Rent)), num("days", w.hs.PeriodDays),
			num("size", h.size)))
		return
	}
	p.emit(systemMsg(msgHouseLookOwned, houseParam(h), textParam("name", h.ownerName)))
}

// ---- commands -------------------------------------------------------------------------

// houseCommand runs one HouseCommand.
func (w *World) houseCommand(ctx *game.TickContext, p *Player, m *pb.HouseCommand) {
	if _, ok := m.GetAction().(*pb.HouseCommand_Close); ok {
		p.house = nil
		return
	}
	if !w.atHouse(p) || !w.houseFlood(ctx, p) {
		return
	}
	p.active(ctx.Tick, antibot.KindOther)
	h := p.house.h
	if w.readOnly {
		p.emit(systemMsg(msgHouseReadOnly))
		w.sendHouse(p)
		return
	}
	switch a := m.GetAction().(type) {
	case *pb.HouseCommand_Rent:
		w.houseRent(ctx, p, h)
	case *pb.HouseCommand_TransferAccept:
		w.houseAccept(ctx, p, h)
	default:
		if h.owner != p.charID {
			p.emit(systemMsg(msgHouseNotOwner))
			break
		}
		switch a := a.(type) {
		case *pb.HouseCommand_Extend:
			w.houseExtend(ctx, p, h)
		case *pb.HouseCommand_Leave:
			w.releaseHouse(ctx.Now, h, nil)
			p.emit(systemMsg(msgHouseLeft, houseParam(h)))
			w.log.Info("house: left", "house", h.def.ID, "character", p.charID)
		case *pb.HouseCommand_GuestAdd:
			w.houseGuest(ctx, p, h, a.GuestAdd.GetName(), true)
		case *pb.HouseCommand_GuestRemove:
			w.houseGuest(ctx, p, h, a.GuestRemove.GetName(), false)
		case *pb.HouseCommand_GuildAccess:
			if h.guildAccess == a.GuildAccess.GetEnabled() {
				break
			}
			h.guildAccess = a.GuildAccess.GetEnabled()
			w.houseTransfer(nil, []HouseOp{w.accessOp(h)})
			key := msgHouseGuildOff
			if h.guildAccess {
				key = msgHouseGuildOn
			}
			p.emit(systemMsg(key))
			w.expelIntruders(h)
		case *pb.HouseCommand_TransferOffer:
			w.houseOffer(ctx, p, h, a.TransferOffer.GetName(), a.TransferOffer.GetPrice())
		case *pb.HouseCommand_TransferCancel:
			if h.offer == nil {
				p.emit(systemMsg(msgHouseOfferNone))
				break
			}
			h.offer = nil
			p.emit(systemMsg(msgHouseOfferOff))
		}
	}
	w.refreshHouse(h)
	if p.house != nil && p.house.h != h {
		w.sendHouse(p)
	}
}

// canOwn reports (with the message) whether p may own a house: not staff, the level, and
// no other house on its account.
func (w *World) canOwn(p *Player, except *house) bool {
	switch {
	case p.role > RolePlayer:
		p.emit(systemMsg(msgHouseStaff))
		return false
	case p.level < w.hs.MinLevel:
		p.emit(systemMsg(msgHouseLevel, num("level", w.hs.MinLevel)))
		return false
	}
	if o := w.houseByAcc[p.accountID]; o != nil && o != except || w.houseOrphans[p.accountID] {
		p.emit(systemMsg(msgHouseHasOne))
		return false
	}
	return true
}

func (w *World) houseRent(ctx *game.TickContext, p *Player, h *house) {
	if h.owner != 0 {
		p.emit(systemMsg(msgHouseTaken))
		return
	}
	if !w.canOwn(p, nil) {
		return
	}
	rent := int64(h.def.Rent)
	if w.money(p) < rent {
		p.emit(systemMsg(msgHouseNoMoney, num("price", int(rent))))
		return
	}
	w.pay(p, rent)
	w.econGold(p, EconHouse, "rent", -rent)
	o := HouseOwner{HouseID: h.def.ID, CharacterID: p.charID, AccountID: p.accountID, Name: p.name,
		PaidUntil: ctx.Now.Add(w.hsPeriod), Since: ctx.Now}
	w.setOwner(h, o)
	w.houseTransfer([]*Player{p}, []HouseOp{{Kind: HouseOwnerAdd, House: h.def.ID, Owner: o}})
	p.emit(systemMsg(msgHouseRented, houseParam(h), num("days", w.hs.PeriodDays), num("price", int(rent))))
	w.afterMarket(p)
	w.log.Info("house: rented", "house", h.def.ID, "character", p.charID, "rent", rent)
}

func (w *World) houseExtend(ctx *game.TickContext, p *Player, h *house) {
	limit := ctx.Now.Add(time.Duration(w.hs.MaxPeriods) * w.hsPeriod)
	next := maxTime(h.paidUntil, ctx.Now).Add(w.hsPeriod)
	if next.After(limit) {
		p.emit(systemMsg(msgHouseMaxPeriods, num("max", w.hs.MaxPeriods)))
		return
	}
	rent := int64(h.def.Rent)
	if w.money(p) < rent {
		p.emit(systemMsg(msgHouseNoMoney, num("price", int(rent))))
		return
	}
	w.pay(p, rent)
	w.econGold(p, EconHouse, "rent", -rent)
	h.paidUntil = next
	w.houseTransfer([]*Player{p}, []HouseOp{{Kind: HousePaid, House: h.def.ID, CharacterID: p.charID, PaidUntil: next}})
	p.emit(systemMsg(msgHouseExtended, houseParam(h), num("price", int(rent))))
	w.afterMarket(p)
}

func (w *World) accessOp(h *house) HouseOp {
	return HouseOp{Kind: HouseAccess, House: h.def.ID, CharacterID: h.owner, GuildAccess: h.guildAccess,
		Guests: append([]string(nil), h.guests...)}
}

func (w *World) houseGuest(ctx *game.TickContext, p *Player, h *house, name string, add bool) {
	name = strings.TrimSpace(name)
	i := slices.IndexFunc(h.guests, func(g string) bool { return strings.EqualFold(g, name) })
	switch {
	case add && !auth.ValidCharacterName(name):
		p.emit(systemMsg(msgHouseGuestBad))
		return
	case add && i >= 0, !add && i < 0:
		w.sendHouse(p)
		return // nothing changes
	case add && len(h.guests) >= w.hs.MaxGuests:
		p.emit(systemMsg(msgHouseGuestsFull, num("max", w.hs.MaxGuests)))
		return
	}
	if add {
		h.guests = append(h.guests, name)
		p.emit(systemMsg(msgHouseGuestAdded, textParam("name", name)))
	} else {
		p.emit(systemMsg(msgHouseGuestRemoved, textParam("name", h.guests[i])))
		h.guests = slices.Delete(h.guests, i, i+1)
	}
	w.houseTransfer(nil, []HouseOp{w.accessOp(h)})
	if !add {
		w.expelIntruders(h)
	}
}

func (w *World) houseOffer(ctx *game.TickContext, p *Player, h *house, name string, price uint64) {
	to := w.onlineByName(strings.TrimSpace(name))
	if to == nil || to == p || price > uint64(content.MaxMarketPrice) {
		p.emit(systemMsg(msgHouseOfferBad))
		return
	}
	h.offer = &houseOffer{to: to.charID, toName: to.name, price: int64(price),
		until: ctx.Tick + game.TicksFor(time.Duration(w.hs.TransferMinutes)*time.Minute)}
	p.emit(systemMsg(msgHouseOffered, houseParam(h), textParam("name", to.name), num("price", int(price))))
	to.emit(systemMsg(msgHouseOfferedYou, houseParam(h), textParam("name", p.name), num("price", int(price))))
}

func (w *World) houseAccept(ctx *game.TickContext, p *Player, h *house) {
	o := h.offer
	if o == nil || o.to != p.charID || ctx.Tick > o.until || h.owner == 0 {
		p.emit(systemMsg(msgHouseOfferNone))
		return
	}
	if !w.canOwn(p, h) {
		return
	}
	if w.money(p) < o.price {
		p.emit(systemMsg(msgHouseNoMoney, num("price", int(o.price))))
		return
	}
	from, fromName := h.owner, h.ownerName
	var market []MarketOp
	if o.price > 0 {
		w.pay(p, o.price)
		w.econGoldWith(p, EconHouse, "transfer", from, -o.price)
		w.box(from).gold += o.price
		market = append(market, MarketOp{Kind: MarketGoldAdd, CharacterID: from, Gold: o.price})
	}
	w.changeOwner(ctx.Now, h, p.charID, p.accountID, p.name, []*Player{p}, market)
	p.emit(systemMsg(msgHouseTransferred, houseParam(h)))
	if old := w.byChar[from]; old != nil {
		old.emit(systemMsg(msgHouseGivenAway, houseParam(h), textParam("name", p.name), num("price", int(o.price))))
	}
	w.afterMarket(p)
	w.log.Info("house: transferred", "house", h.def.ID, "from", from, "from_name", fromName, "to", p.charID, "price", o.price)
}

// changeOwner gives h to another character (accepted transfer or staff): the items go to
// the old owner's mailbox, the guests and the guild switch are cleared, the paid rent
// stays with the house.
func (w *World) changeOwner(now time.Time, h *house, to, acc int64, name string, players []*Player, market []MarketOp) {
	w.flushHouses() // this tick's earlier changes, with their movers' snapshots, first
	from := h.owner
	ops, mail := w.mailHouseItems(now, h)
	o := HouseOwner{HouseID: h.def.ID, CharacterID: to, AccountID: acc, Name: name, PaidUntil: h.paidUntil, Since: now}
	w.setOwner(h, o)
	ops = append(ops, HouseOp{Kind: HouseOwnerChange, House: h.def.ID, CharacterID: from, Owner: o})
	w.houseTransfer(players, ops, append(market, mail...)...)
	w.mailedNotice(h, from, len(mail))
	w.expelIntruders(h)
}

// releaseHouse frees h (left, unpaid or staff): its items go to the owner's mailbox and
// the owner row goes, in one transfer with the snapshots of players.
func (w *World) releaseHouse(now time.Time, h *house, players []*Player, market ...MarketOp) {
	w.flushHouses() // this tick's earlier changes, with their movers' snapshots, first
	from := h.owner
	ops, mail := w.mailHouseItems(now, h)
	ops = append(ops, HouseOp{Kind: HouseOwnerRemove, House: h.def.ID, CharacterID: from})
	w.clearOwner(h)
	w.houseTransfer(players, ops, append(market, mail...)...)
	w.mailedNotice(h, from, len(mail))
	w.expelIntruders(h)
}

func (w *World) mailedNotice(h *house, owner int64, n int) {
	if o := w.byChar[owner]; o != nil && n > 0 {
		o.emit(systemMsg(msgHouseItemsMailed, houseParam(h), num("count", n)))
	}
}

// mailHouseItems takes every item off the floor of h into its owner's market mailbox
// (whole instances, containers with their content): the HouseItems op that empties the
// house and the mailbox inserts. Corpses stay (they decay).
func (w *World) mailHouseItems(now time.Time, h *house) ([]HouseOp, []MarketOp) {
	var mail []MarketOp
	owner := h.owner
	w.eachHouseTile(h, func(pos world.Pos) {
		g := w.ground[pos]
		if len(g) == 0 {
			return
		}
		for _, it := range slices.Clone(g) {
			if w.isCorpse(it) {
				continue
			}
			w.closeAll(it)
			w.detach(it)
			w.econWorldTree(owner, EconHouse, "to_mailbox", it)
			w.nextMail++
			m := MarketMail{ID: w.nextMail, CharacterID: owner, Item: it.state(0), Created: now}
			w.box(owner).items = append(w.box(owner).items, m)
			mail = append(mail, MarketOp{Kind: MarketMailAdd, Mail: m})
		}
		w.tileChanged(pos)
	})
	// The tile changes above marked h dirty: its (empty) list goes with this transfer.
	if h.dirty {
		h.dirty = false
		w.houseDirty = slices.DeleteFunc(w.houseDirty, func(x *house) bool { return x == h })
	}
	return []HouseOp{{Kind: HouseItems, House: h.def.ID, Items: w.houseItems(h)}}, mail
}

// ---- rent and expiry ------------------------------------------------------------------

// checkHouses, once per second: renews or releases the houses whose rent ran out (a
// bounded round-robin batch), drops expired transfer offers, and moves out whoever
// stands in a house without access (a guest removed, a guild left, a new owner).
func (w *World) checkHouses(ctx *game.TickContext) {
	if !w.houseOn {
		return
	}
	w.flushHouses()
	if ctx.Tick < w.houseNext {
		return
	}
	w.houseNext = ctx.Tick + game.Tick(1000/game.TickDuration.Milliseconds())
	for _, p := range slices.Clone(w.players) {
		if w.m.Flags(p.pos)&world.FlagHouse == 0 {
			continue
		}
		if h := w.houseAt(p.pos); h != nil && !w.houseAccess(p, h) {
			w.expel(p, h)
		}
	}
	if w.readOnly {
		return // no rent from the mailbox, no release, until a restart
	}
	n := min(len(w.houseList), houseSweepBatch)
	for range n {
		h := w.houseList[w.houseCursor%len(w.houseList)]
		w.houseCursor = (w.houseCursor + 1) % len(w.houseList)
		if h.offer != nil && ctx.Tick > h.offer.until {
			h.offer = nil
		}
		if h.owner != 0 && !ctx.Now.Before(h.paidUntil) {
			w.renewHouse(ctx.Now, h)
		}
	}
}

// renewHouse takes the next period from the owner's mailbox gold, or releases h.
func (w *World) renewHouse(now time.Time, h *house) {
	rent := int64(h.def.Rent)
	owner := h.owner
	if b := w.mail[owner]; b != nil && b.gold >= rent {
		b.gold -= rent
		// After a long downtime the new period starts now (no period per second to catch up).
		h.paidUntil = maxTime(h.paidUntil, now).Add(w.hsPeriod)
		w.econRecord(nil, EconomyEntry{Kind: EconHouse, CharacterID: owner, Amount: -rent, Ref: "rent"})
		w.houseTransfer(nil, []HouseOp{{Kind: HousePaid, House: h.def.ID, CharacterID: owner, PaidUntil: h.paidUntil}},
			MarketOp{Kind: MarketGoldAdd, CharacterID: owner, Gold: -rent})
		if o := w.byChar[owner]; o != nil {
			o.emit(systemMsg(msgHouseRenewed, houseParam(h), num("price", int(rent))))
		}
		w.log.Info("house: rent renewed from the mailbox", "house", h.def.ID, "character", owner)
		w.refreshHouse(h)
		return
	}
	if o := w.byChar[owner]; o != nil {
		o.emit(systemMsg(msgHouseLost, houseParam(h)))
	}
	w.log.Info("house: released, rent not paid", "house", h.def.ID, "character", owner)
	w.releaseHouse(now, h, nil)
	w.refreshHouse(h)
}

// ---- staff ----------------------------------------------------------------------------

func (w *World) staffHouse(ctx *game.TickContext, p *Player, action string, args []string) *house {
	if len(args) == 0 || !w.houseOn {
		return nil
	}
	h := w.houseByID[strings.ToLower(args[0])]
	if h == nil {
		p.emit(systemMsg(msgGMHouseUnknown, textParam("id", args[0])))
		w.audit(ctx, p, action, nil, map[string]string{"house": args[0]}, auditInvalid)
	}
	return h
}

// cmdHouse: "/house id" shows a house: owner, paid until, guests and items.
func (w *World) cmdHouse(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) != 1 || !w.houseOn {
		return false
	}
	h := w.staffHouse(ctx, p, "house_info", args)
	if h == nil {
		return true
	}
	if h.owner == 0 {
		p.emit(systemMsg(msgGMHouseFree, textParam("id", h.def.ID), num("items", w.houseCount(h))))
	} else {
		p.emit(systemMsg(msgGMHouseInfo, textParam("id", h.def.ID), textParam("name", h.ownerName),
			textParam("until", h.paidUntil.UTC().Format(time.RFC3339)), num("guests", len(h.guests)),
			num("items", w.houseCount(h))))
	}
	w.audit(ctx, p, "house_info", nil, map[string]string{"house": h.def.ID, "owner": h.ownerName}, auditOK)
	return true
}

// cmdHouseEvict: "/houseevict id" frees a house; its items go to the owner's mailbox.
func (w *World) cmdHouseEvict(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) != 1 || !w.houseOn {
		return false
	}
	if w.readOnly {
		p.emit(systemMsg(msgHouseReadOnly))
		return true
	}
	h := w.staffHouse(ctx, p, "house_evict", args)
	if h == nil {
		return true
	}
	owner, name := h.owner, h.ownerName
	if owner == 0 {
		p.emit(systemMsg(msgGMHouseFree, textParam("id", h.def.ID), num("items", w.houseCount(h))))
		w.audit(ctx, p, "house_evict", nil, map[string]string{"house": h.def.ID}, auditInvalid)
		return true
	}
	if o := w.byChar[owner]; o != nil {
		o.emit(systemMsg(msgHouseEvicted, houseParam(h)))
	}
	w.releaseHouse(ctx.Now, h, nil)
	w.refreshHouse(h)
	p.emit(systemMsg(msgGMHouseEvicted, textParam("id", h.def.ID), textParam("name", name)))
	w.audit(ctx, p, "house_evict", nil, map[string]string{"house": h.def.ID, "target": name,
		"character": strconv.FormatInt(owner, 10)}, auditOK)
	return true
}

// cmdHouseMove: "/housemove id Name" gives a house to an online character (no payment;
// the items go to the old owner's mailbox). The account rule (one house) still holds.
func (w *World) cmdHouseMove(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) < 2 || !w.houseOn {
		return false
	}
	if w.readOnly {
		p.emit(systemMsg(msgHouseReadOnly))
		return true
	}
	h := w.staffHouse(ctx, p, "house_move", args)
	if h == nil {
		return true
	}
	name := strings.Join(args[1:], " ")
	to := w.onlineByName(name)
	auditArgs := map[string]string{"house": h.def.ID, "to": name, "from": h.ownerName}
	if to == nil || to.role > RolePlayer || to.charID == h.owner || w.houseByAcc[to.accountID] != nil && w.houseByAcc[to.accountID] != h ||
		w.houseOrphans[to.accountID] {
		p.emit(systemMsg(msgGMHouseNoTarget, textParam("name", name)))
		w.audit(ctx, p, "house_move", nil, auditArgs, auditInvalid)
		return true
	}
	if h.owner == 0 {
		o := HouseOwner{HouseID: h.def.ID, CharacterID: to.charID, AccountID: to.accountID, Name: to.name,
			PaidUntil: ctx.Now.Add(w.hsPeriod), Since: ctx.Now}
		w.setOwner(h, o)
		w.houseTransfer(nil, []HouseOp{{Kind: HouseOwnerAdd, House: h.def.ID, Owner: o}})
	} else {
		w.changeOwner(ctx.Now, h, to.charID, to.accountID, to.name, nil, nil)
	}
	to.emit(systemMsg(msgHouseTransferred, houseParam(h)))
	w.refreshHouse(h)
	p.emit(systemMsg(msgGMHouseMoved, textParam("id", h.def.ID), textParam("name", to.name)))
	w.audit(ctx, p, "house_move", to, auditArgs, auditOK)
	return true
}

// ---- public ---------------------------------------------------------------------------

// HouseState is one house as /houses shows it.
type HouseState struct {
	ID, Name, Island string
	Rent             uint32
	Size             int
	Owner            string // empty: free
}

// HouseStates returns every house of the map with its owner. Loop goroutine only.
func (w *World) HouseStates() []HouseState {
	out := make([]HouseState, 0, len(w.houseList))
	for _, h := range w.houseList {
		out = append(out, HouseState{ID: h.def.ID, Name: h.def.Name, Island: h.def.Island, Rent: h.def.Rent,
			Size: h.size, Owner: h.ownerName})
	}
	return out
}

// HouseOwnerOf returns the house id character id rents, or "". Loop goroutine only.
func (w *World) HouseOwnerOf(id int64) string {
	if h := w.houseByOwner[id]; h != nil {
		return h.def.ID
	}
	return ""
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
