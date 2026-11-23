package session

import (
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Account stash (docs/02 "Baúl de la cuenta", docs/01 "Transacciones"). One chest per
// account, shared by all of its characters, opened at a stash chest of the map (an item
// with stash: true) by a character next to it.
//
// One copy, owned by the loop. The stash of an account lives in World.stashes from the
// first character of the account that joins (it comes with that login's database read,
// Character.Stash) until the database has every change of it and nobody needs it: no
// character of the account in the world, no login of the account reading the database
// (loadingAcc) and the last stash write acked (releaseStash). While it is there, every
// login of the account uses it and ignores what it read: that read may be older than a
// write still in the queue. Two characters of the account online at once act on the same
// copy, one command after the other, so both can never take out the same item.
//
// Every deposit and withdrawal is a transfer (T5.3): the character's snapshot and the whole
// stash (StashOp) in ONE database transaction, in the persistence queue after the
// character's earlier saves and before its later ones. An item is always in exactly one of
// the two rows, whatever crashes when: a transfer the database does not have yet is lost
// whole (the item is back where it was before the move, on both sides), and one it has
// is whole. The transfer holds the character (hold.go: inFlight), so nothing it just took
// out reaches the public ground, and through it another character's save, before the
// database has the withdrawal. A transfer that is dropped taints its character and the
// stash (Saver.taint): the later writes of that stash, of any character, are skipped and
// taint their characters too, and the World goes read-only (Tainted), which closes every
// stash window until a restart.

// accountStash is the in-memory stash of one account.
type accountStash struct {
	account int64
	// items are the cells in order; there may be more than the capacity if it was lowered
	// (nothing is lost; nothing goes in while it is over).
	items []*Item
	// viewers are the players of the account with the window open.
	viewers []*Player
	// pendChar and pendSeq are the snapshot in the last stash write the database has not
	// acked (pendChar 0: none). The Saver writes in order, so its ack covers every earlier
	// write of the stash (or one was dropped, and then this one never is acked).
	pendChar int64
	pendSeq  uint64
}

// StashOp replaces the stash of Account with Items (cell i: Items[i]) inside a transfer.
type StashOp struct {
	Account int64
	Items   []ItemState
}

func (st *accountStash) states() []ItemState {
	out := make([]ItemState, len(st.items))
	for i, it := range st.items {
		out[i] = it.state(i)
	}
	return out
}

// initStash reads balance.yaml stash: on only with transfers (Config.Transfer).
func (w *World) initStash() {
	s := w.cfg.Balance.Stash
	w.stashes = map[int64]*accountStash{}
	w.stashPend = map[int64]*accountStash{}
	w.loadingAcc = map[int64]int{}
	if !s.Enabled || w.cfg.Transfer == nil {
		return
	}
	w.stashOn = true
	w.stashSlots = s.Slots
	w.stashRefill = max(game.Tick(s.ActionRefillMs/int(game.TickDuration.Milliseconds())), 1)
	w.stashBurst = w.stashRefill * game.Tick(max(s.ActionBurst-1, 0))
}

// stashJoin gives the joining p its account's stash: the one in memory, or else the one its
// login read (c.Stash).
func (w *World) stashJoin(p *Player, c Character) {
	if !w.stashOn || w.stashes[p.accountID] != nil {
		return
	}
	st := &accountStash{account: p.accountID}
	saved := slices.Clone(c.Stash)
	slices.SortStableFunc(saved, func(a, b ItemState) int { return a.Slot - b.Slot })
	for _, s := range saved {
		if it := w.loadItem(s); it != nil {
			st.items = append(st.items, it)
		}
	}
	w.stashes[p.accountID] = st
}

// releaseStash forgets the stash of account once the database has all of it and nobody
// needs it (see above).
func (w *World) releaseStash(account int64) {
	st := w.stashes[account]
	if st == nil || st.pendChar != 0 || w.byAccount[account] > 0 || w.loadingAcc[account] > 0 {
		return
	}
	delete(w.stashes, account)
}

// stashSaved is the ack of character id's snapshot seq: it ends the pending write of a
// stash it covers.
func (w *World) stashSaved(id int64, seq uint64) {
	st := w.stashPend[id]
	if st == nil || st.pendChar != id || seq < st.pendSeq {
		return
	}
	delete(w.stashPend, id)
	st.pendChar, st.pendSeq = 0, 0
	w.releaseStash(st.account)
}

// stashLoginStarted and stashLoginDone count the logins of account reading the database.
func (w *World) stashLoginStarted(account int64) { w.loadingAcc[account]++ }

func (w *World) stashLoginDone(account int64) {
	if w.loadingAcc[account] <= 1 {
		delete(w.loadingAcc, account)
	} else {
		w.loadingAcc[account]--
	}
}

// ---- the window --------------------------------------------------------------------

// useStash opens the stash window if m points at a stash chest of the map. It reports
// whether m was about one (like useMarketBoard).
func (w *World) useStash(ctx *game.TickContext, p *Player, m *pb.UseItem) bool {
	pos, ok := posFromMsg(m.GetFrom().GetPos())
	if !ok || pos.Z != p.pos.Z || !Sees(p.pos, pos) || int(m.GetStackIndex()) >= w.staticCount(pos) {
		return false
	}
	id := w.staticAt(pos, int(m.GetStackIndex()))
	def := w.byNum[id]
	if id == 0 || uint32(id) != m.GetItemId() || def == nil || !def.Stash {
		return false
	}
	st := w.stashes[p.accountID]
	switch {
	case !w.stashOn || st == nil || w.readOnly || p.role > RolePlayer:
		w.stashAnswer(p, pos, nil, pb.StashResult_STASH_RESULT_UNAVAILABLE)
	case !w.near(p, pos):
		w.stashAnswer(p, pos, nil, pb.StashResult_STASH_RESULT_TOO_FAR)
	default:
		w.closeStash(p, false)
		p.stash, p.stashAt = st, pos
		st.viewers = append(st.viewers, p)
		p.active(ctx.Tick, antibot.KindOther)
		w.stashAnswer(p, pos, st, pb.StashResult_STASH_RESULT_OK)
	}
	return true
}

// stashAnswer sends p the window: open with st's cells, or closed (st nil).
func (w *World) stashAnswer(p *Player, chest world.Pos, st *accountStash, r pb.StashResult) {
	u := &pb.StashUpdate{Result: r, Chest: posMsg(chest), Capacity: uint32(w.stashSlots)}
	if st != nil {
		u.Open = true
		u.Items = make([]*pb.ItemStack, len(st.items))
		for i, it := range st.items {
			u.Items[i] = it.stack()
		}
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_StashUpdate{StashUpdate: u}})
}

// stashChanged sends st to every viewer: the actor gets its result, the others OK.
func (w *World) stashChanged(st *accountStash, actor *Player, r pb.StashResult) {
	for _, v := range st.viewers {
		res := pb.StashResult_STASH_RESULT_OK
		if v == actor {
			res = r
		}
		w.stashAnswer(v, v.stashAt, st, res)
	}
}

// closeStash closes p's window (if open); tell sends the closed window to p.
func (w *World) closeStash(p *Player, tell bool) {
	st := p.stash
	if st == nil {
		return
	}
	if i := slices.Index(st.viewers, p); i >= 0 {
		st.viewers = slices.Delete(st.viewers, i, i+1)
	}
	at := p.stashAt
	p.stash = nil
	if tell {
		w.stashAnswer(p, at, nil, pb.StashResult_STASH_RESULT_OK)
	}
}

// checkStash closes the window of a player that is no longer next to its chest.
func (w *World) checkStash(p *Player) {
	if p.stash != nil && !w.near(p, p.stashAt) {
		w.closeStash(p, true)
	}
}

// closeEveryStash closes every open window (the World went read-only: Tainted).
func (w *World) closeEveryStash() {
	for _, p := range w.players {
		if p.stash != nil {
			w.closeStash(p, true)
		}
	}
}

// ---- actions ------------------------------------------------------------------------

// stashCommand runs a StashCommand of p.
func (w *World) stashCommand(ctx *game.TickContext, p *Player, m *pb.StashCommand) {
	if _, ok := m.GetAction().(*pb.StashCommand_Close); ok {
		w.closeStash(p, true)
		return
	}
	st := p.stash
	if st == nil {
		w.stashAnswer(p, p.stashAt, nil, pb.StashResult_STASH_RESULT_TOO_FAR)
		return
	}
	switch {
	case !w.stashOn || w.readOnly || p.role > RolePlayer:
		w.closeStash(p, false)
		w.stashAnswer(p, p.stashAt, nil, pb.StashResult_STASH_RESULT_UNAVAILABLE)
		return
	case !w.near(p, p.stashAt):
		w.closeStash(p, false)
		w.stashAnswer(p, p.stashAt, nil, pb.StashResult_STASH_RESULT_TOO_FAR)
		return
	}
	tat := max(p.stashTAT, ctx.Tick)
	if tat-ctx.Tick > w.stashBurst {
		w.stashAnswer(p, p.stashAt, st, pb.StashResult_STASH_RESULT_TOO_FAST)
		return
	}
	p.stashTAT = tat + w.stashRefill
	if w.pvpLocked(ctx.Tick, p) {
		w.stashAnswer(p, p.stashAt, st, pb.StashResult_STASH_RESULT_IN_COMBAT)
		return
	}
	p.active(ctx.Tick, antibot.KindOther)
	var r pb.StashResult
	switch a := m.GetAction().(type) {
	case *pb.StashCommand_Deposit:
		r = w.stashDeposit(p, st, a.Deposit)
	case *pb.StashCommand_Withdraw:
		r = w.stashWithdraw(p, st, a.Withdraw)
	default:
		r = pb.StashResult_STASH_RESULT_NOT_POSSIBLE
	}
	if r != pb.StashResult_STASH_RESULT_OK {
		w.stashAnswer(p, p.stashAt, st, r)
		return
	}
	w.stashWrite(p, st)
	w.stashChanged(st, p, r)
}

// stashable reports whether it may go in the stash: tradeable, and a container only with
// tradeable content (a quest item never moves to another character of the account).
func stashable(it *Item) bool {
	if !it.def.Tradeable {
		return false
	}
	for _, c := range it.items {
		if !stashable(c) {
			return false
		}
	}
	return true
}

// stashDeposit moves the units m names from p's inventory into st.
func (w *World) stashDeposit(p *Player, st *accountStash, m *pb.StashDeposit) pb.StashResult {
	it, from := w.itemAt(p, m.GetFrom(), m.GetItemId(), 0)
	if it == nil || from.kind == locGround || it.carriedBy() != p {
		return pb.StashResult_STASH_RESULT_NOT_POSSIBLE
	}
	if !stashable(it) || offered(p, it) || slices.ContainsFunc(it.items, func(c *Item) bool { return w.offeredInside(p, c) }) {
		return pb.StashResult_STASH_RESULT_NOT_ALLOWED
	}
	count := it.count
	if it.def.Stackable {
		count = int(m.GetCount())
		if count < 1 || count > it.count {
			return pb.StashResult_STASH_RESULT_NOT_POSSIBLE
		}
	}
	merge := mergeTarget(st.items, it, count)
	if merge == nil && len(st.items) >= w.stashSlots {
		return pb.StashResult_STASH_RESULT_FULL
	}
	release := w.holdInventory(p)
	moving := it
	if count < it.count {
		it.count -= count
		moving = newItem(it.def, count)
		moving.mods = it.mods
		w.changed(it)
		w.econEntry(p, EconStash, "deposit", 0, it.def, -count, it.mods)
	} else {
		w.econTree(p, EconStash, "deposit", it, -1)
		w.closeAll(it) // its windows and those of the containers inside it
		w.detach(it)
		w.changedPlace(p, from)
	}
	if merge != nil {
		merge.count += moving.count
	} else {
		st.items = append(st.items, moving)
	}
	release()
	if from.kind == locSlot {
		w.equipmentChanged(p)
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	return pb.StashResult_STASH_RESULT_OK
}

// offeredInside reports whether c, or anything inside it, is in p's trade offer.
func (w *World) offeredInside(p *Player, c *Item) bool {
	if offered(p, c) {
		return true
	}
	return slices.ContainsFunc(c.items, func(x *Item) bool { return w.offeredInside(p, x) })
}

// stashWithdraw moves the units m names from st into p's backpack (or else its pockets).
func (w *World) stashWithdraw(p *Player, st *accountStash, m *pb.StashWithdraw) pb.StashResult {
	i := int(m.GetIndex())
	if i >= len(st.items) {
		return pb.StashResult_STASH_RESULT_CHANGED
	}
	it := st.items[i]
	if uint32(it.def.Numeric) != m.GetItemId() || it.mods != modsOf(m.GetMods()) {
		return pb.StashResult_STASH_RESULT_CHANGED
	}
	count := it.count
	if it.def.Stackable {
		count = int(m.GetCount())
		if count < 1 || count > it.count {
			return pb.StashResult_STASH_RESULT_NOT_POSSIBLE
		}
	}
	if it.def.Stackable && it.mods.Zero() && len(it.items) == 0 {
		// Plain units: they join the stacks p carries and fill free cells, like a purchase.
		if it.def.Weight*count > p.capacity-p.carried() {
			return pb.StashResult_STASH_RESULT_TOO_HEAVY
		}
		if !w.canReceive(p, it.def, count, 0) {
			return pb.StashResult_STASH_RESULT_NO_ROOM
		}
		w.giveItem(p, it.def, count)
		w.econItem(p, EconStash, "withdraw", it.def, count)
		if it.count -= count; it.count == 0 {
			st.items = slices.Delete(st.items, i, i+1)
		}
		return pb.StashResult_STASH_RESULT_OK
	}
	// The instance itself: an equipable keeps its attribute and refine, a rune its charges,
	// a container its content.
	if it.weight() > p.capacity-p.carried() {
		return pb.StashResult_STASH_RESULT_TOO_HEAVY
	}
	pack := p.packWithRoom()
	if pack == nil || depth(pack)+1+it.height() > maxDepth {
		return pb.StashResult_STASH_RESULT_NO_ROOM
	}
	st.items = slices.Delete(st.items, i, i+1)
	before := p.carried()
	w.attach(p, it, place{kind: locContainer, cont: pack})
	w.containerChanged(pack)
	w.econTree(p, EconStash, "withdraw", it, 1)
	if p.carried() != before {
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	}
	return pb.StashResult_STASH_RESULT_OK
}

// stashWrite submits the transfer of a move between p and st: p's snapshot and the whole
// stash, in one database transaction (see above).
func (w *World) stashWrite(p *Player, st *accountStash) {
	w.flushHouses() // before numbering, so transfer ids grow in submission order
	w.nextTransfer++
	t := Transfer{ID: w.nextTransfer, Stash: []StashOp{{Account: st.account, Items: st.states()}},
		OfferHigh: w.nextOffer, MailHigh: w.nextMail}
	s := w.transferSnapshot(p)
	t.Snapshots = []Snapshot{s}
	w.submitJob(Job{Transfer: &t})
	if st.pendChar != 0 && st.pendChar != p.charID {
		delete(w.stashPend, st.pendChar)
	}
	st.pendChar, st.pendSeq = p.charID, s.Seq
	w.stashPend[p.charID] = st
}

// StashItems returns the cells of the stash of account in memory (nil: none), as saved
// (tests and tools; loop goroutine only).
func (w *World) StashItems(account int64) []ItemState {
	st := w.stashes[account]
	if st == nil {
		return nil
	}
	return st.states()
}

// StashLoaded reports whether the stash of account is in memory (loop goroutine only).
func (w *World) StashLoaded(account int64) bool { return w.stashes[account] != nil }
