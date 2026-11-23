package session_test

import (
	"context"
	"slices"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Account stash (docs/02 "Baúl de la cuenta"). The chest is the 'v' of the drawing.
const stashChestID = worldtest.Vein

var stashMap = []string{
	"v.....",
	"......",
	"......",
	"......",
	"......",
}

var stashChest = pos(0, 0)

type stashHarness struct {
	*harness
	transfers []session.Transfer
}

// newStashHarness has a stash of slots cells; the transfers are logged by log (or kept in
// stashHarness.transfers without one).
func newStashHarness(t *testing.T, slots int, log *jobLog) *stashHarness {
	t.Helper()
	sh := &stashHarness{}
	sh.harness = newHarness(t, worldtest.Map(t, 0, 0, 7, stashMap...), func(c *session.Config) {
		items := marketItems(t)
		delete(items, "market_board") // its numeric id is the chest's
		var def content.Item
		if err := yaml.Unmarshal([]byte("{id: stash_chest, kind: decoration, pickupable: false, blocks_movement: true, stash: true}"), &def); err != nil {
			t.Fatal(err)
		}
		def.Numeric = stashChestID
		items[def.ID] = &def
		c.Items = items
		c.Balance.Stash = content.Stash{Enabled: true, Slots: slots, ActionBurst: 100, ActionRefillMs: 50}
		c.Transfer = func(tr session.Transfer) bool { sh.transfers = append(sh.transfers, tr); return true }
		if log != nil {
			log.wire(c)
		}
	})
	return sh
}

// account joins character id of account acc at p with pack in its backpack (and stash,
// what its login read of the stash).
func (h *stashHarness) account(id, acc int64, name string, p world.Pos, stash []session.ItemState,
	pack ...session.ItemState) (*fakeClient, *session.Player) {
	h.t.Helper()
	c := withPack(id, p, pack...)
	c.AccountID, c.Name, c.Stash = acc, name, stash
	cl, pl := h.joinChar(c)
	cl.take()
	return cl, pl
}

func openStash() *pb.ClientMessage { return useItem(onTile(stashChest), stashChestID, 1) }

func stashDeposit(from *pb.ItemLocation, item, count uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_StashCommand{StashCommand: &pb.StashCommand{
		Action: &pb.StashCommand_Deposit{Deposit: &pb.StashDeposit{From: from, ItemId: item, Count: count}}}}}
}

func stashWithdraw(index, item, count uint32, mods *pb.ItemMods) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_StashCommand{StashCommand: &pb.StashCommand{
		Action: &pb.StashCommand_Withdraw{Withdraw: &pb.StashWithdraw{Index: index, ItemId: item, Count: count, Mods: mods}}}}}
}

// lastStash is the last StashUpdate of evs, or nil.
func lastStash(evs []*pb.ServerMessage) *pb.StashUpdate {
	us := find(evs, (*pb.ServerMessage).GetStashUpdate)
	if len(us) == 0 {
		return nil
	}
	return us[len(us)-1]
}

func (h *stashHarness) open(cl *fakeClient) *pb.StashUpdate {
	h.t.Helper()
	evs := h.send(cl, openStash())
	u := lastStash(evs)
	if !u.GetOpen() || u.GetResult() != pb.StashResult_STASH_RESULT_OK {
		h.t.Fatalf("the stash did not open: %v (%v)", u, evs)
	}
	return u
}

// stashCount is how many units of item the account's stash holds (top level).
func (h *stashHarness) stashCount(acc int64, item uint16) int {
	n := 0
	h.do(func(*game.TickContext) { n = countState(h.w.StashItems(acc), item) })
	return n
}

// Deposits and withdrawals: a split stack, a whole instance with its attribute, each one
// a transfer with the character's snapshot and the whole stash; the instance comes back
// with its attribute, and the ledgers reconcile every tick.
func TestStashDepositAndWithdraw(t *testing.T) {
	h := newStashHarness(t, 30, nil)
	cl, p := h.account(1, 100, "Ana", pos(1, 1), nil, stack(salveID, 30, 0), rolled(swordID, 1, "armor", 3))
	h.open(cl)
	pack := openPack(t, h.harness, cl)

	u := lastStash(h.send(cl, stashDeposit(inContainer(pack, 0), salveID, 10)))
	if u.GetResult() != pb.StashResult_STASH_RESULT_OK || len(u.GetItems()) != 1 || u.GetItems()[0].GetCount() != 10 {
		t.Fatalf("deposit of 10 salves: %v", u)
	}
	if h.w.CountItem(p, "test_salve") != 20 {
		t.Fatalf("Ana carries %d salves, want 20", h.w.CountItem(p, "test_salve"))
	}
	u = lastStash(h.send(cl, stashDeposit(inContainer(pack, 1), swordID, 1)))
	if u.GetResult() != pb.StashResult_STASH_RESULT_OK || len(u.GetItems()) != 2 ||
		u.GetItems()[1].GetMods().GetAttribute() != "armor" || h.w.CountItem(p, "test_sword") != 0 {
		t.Fatalf("deposit of the sword: %v", u)
	}
	if len(h.transfers) != 2 {
		t.Fatalf("%d transfers, want one per move", len(h.transfers))
	}
	tr := h.transfers[1]
	if len(tr.Snapshots) != 1 || tr.Snapshots[0].CharacterID != 1 || len(tr.Stash) != 1 || tr.Stash[0].Account != 100 ||
		len(tr.Stash[0].Items) != 2 || tr.Stash[0].Items[1].Mods != mods("armor", 3) ||
		countState(tr.Snapshots[0].Inventory, swordID) != 0 {
		t.Fatalf("the transfer of the sword is %+v", tr)
	}

	u = lastStash(h.send(cl, stashWithdraw(1, swordID, 0, &pb.ItemMods{Attribute: "armor", Value: 3})))
	if u.GetResult() != pb.StashResult_STASH_RESULT_OK || len(u.GetItems()) != 1 || h.w.CountItem(p, "test_sword") != 1 {
		t.Fatalf("withdraw of the sword: %v", u)
	}
	var back session.Mods
	h.do(func(*game.TickContext) {
		for _, it := range p.Equipped(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK).Items() {
			if it.Def().Numeric == swordID {
				back = it.Mods()
			}
		}
	})
	if back != mods("armor", 3) {
		t.Fatalf("the sword came back with %+v", back)
	}
	u = lastStash(h.send(cl, stashWithdraw(0, salveID, 4, nil)))
	if u.GetResult() != pb.StashResult_STASH_RESULT_OK || u.GetItems()[0].GetCount() != 6 || h.w.CountItem(p, "test_salve") != 24 {
		t.Fatalf("withdraw of 4 salves: %v", u)
	}
	var stash int
	for _, e := range h.economy {
		if e.Kind == session.EconStash {
			stash++
		}
	}
	if stash != 4 {
		t.Fatalf("%d stash economy entries, want 4", stash)
	}
	h.sim.Step()
}

// A stack joins the stash's stack of the same item; a full stash takes no new cell but
// still takes units into a stack with room.
func TestStashMergesStacksAndFills(t *testing.T) {
	h := newStashHarness(t, 2, nil)
	cl, _ := h.account(1, 100, "Ana", pos(1, 1), nil, stack(salveID, 30, 0), stack(swordID, 1, 1), stack(coinID, 50, 2),
		stack(bagID, 1, 3))
	h.open(cl)
	pack := openPack(t, h.harness, cl)
	h.send(cl, stashDeposit(inContainer(pack, 0), salveID, 10))
	u := lastStash(h.send(cl, stashDeposit(inContainer(pack, 0), salveID, 5)))
	if len(u.GetItems()) != 1 || u.GetItems()[0].GetCount() != 15 {
		t.Fatalf("the second deposit did not merge: %v", u)
	}
	h.send(cl, stashDeposit(inContainer(pack, 1), swordID, 1))
	// The pack is now salves, coins, bag: the coins take no cell.
	if u := lastStash(h.send(cl, stashDeposit(inContainer(pack, 1), coinID, 10))); u.GetResult() != pb.StashResult_STASH_RESULT_FULL {
		t.Fatalf("a third cell: %v", u)
	}
	if u := lastStash(h.send(cl, stashDeposit(inContainer(pack, 0), salveID, 5))); u.GetResult() != pb.StashResult_STASH_RESULT_OK ||
		u.GetItems()[0].GetCount() != 20 {
		t.Fatalf("units into a stack of a full stash: %v", u)
	}
	if h.stashCount(100, salveID) != 20 {
		t.Fatal("the stash in memory is not what the window shows")
	}
}

// Only a character next to the chest opens it; walking away closes the window, and a
// command after that does nothing. Items that are not tradeable never go in.
func TestStashDistanceAndRefusals(t *testing.T) {
	h := newStashHarness(t, 30, nil)
	cl, p := h.account(1, 100, "Ana", pos(3, 3), nil, stack(salveID, 30, 0), stack(pebbleID, 2, 1))
	if u := lastStash(h.send(cl, openStash())); u.GetOpen() || u.GetResult() != pb.StashResult_STASH_RESULT_TOO_FAR {
		t.Fatalf("opened from 3 tiles away: %v", u)
	}
	h.do(func(*game.TickContext) { h.w.Teleport(p, pos(1, 0)) })
	cl.take()
	h.open(cl)
	pack := openPack(t, h.harness, cl)
	if u := lastStash(h.send(cl, stashDeposit(inContainer(pack, 1), pebbleID, 1))); u.GetResult() != pb.StashResult_STASH_RESULT_NOT_ALLOWED {
		t.Fatalf("a pebble went in: %v", u)
	}
	if u := lastStash(h.send(cl, stashDeposit(inContainer(pack, 0), salveID, 31))); u.GetResult() != pb.StashResult_STASH_RESULT_NOT_POSSIBLE {
		t.Fatalf("31 of 30 salves: %v", u)
	}
	h.input(cl, walk(pb.Direction_DIRECTION_EAST))
	h.sim.RunTicks(30)
	h.input(cl, walk(pb.Direction_DIRECTION_EAST))
	h.sim.RunTicks(30)
	if u := lastStash(cl.take()); u == nil || u.GetOpen() {
		t.Fatalf("the window stayed open after walking away: %v", u)
	}
	if u := lastStash(h.send(cl, stashDeposit(inContainer(pack, 0), salveID, 1))); u.GetOpen() ||
		u.GetResult() != pb.StashResult_STASH_RESULT_TOO_FAR || h.stashCount(100, salveID) != 0 {
		t.Fatalf("a deposit from away: %v", u)
	}
	if len(h.transfers) != 0 {
		t.Fatalf("%d transfers for refused moves", len(h.transfers))
	}
}

// Two characters of one account online at once share the one stash in memory: the second
// login ignores the stale stash it read, each sees the other's moves, and when both ask
// for the same sword in the same tick only one gets it.
func TestStashTwoCharactersRaceForOneItem(t *testing.T) {
	h := newStashHarness(t, 30, nil)
	ca, a := h.account(1, 100, "Ana", pos(1, 1), nil, stack(swordID, 1, 0))
	cb, b := h.account(2, 100, "Beto", pos(0, 1), []session.ItemState{stack(salveID, 99, 0)}) // stale read
	h.open(ca)
	if u := h.open(cb); len(u.GetItems()) != 0 {
		t.Fatalf("Beto's login used the stash it read, not the one in the world: %v", u)
	}
	pack := openPack(t, h.harness, ca)
	h.send(ca, stashDeposit(inContainer(pack, 0), swordID, 1))
	if u := lastStash(cb.take()); len(u.GetItems()) != 1 || u.GetResult() != pb.StashResult_STASH_RESULT_OK {
		t.Fatalf("Beto did not see Ana's deposit: %v", u)
	}
	h.input(ca, stashWithdraw(0, swordID, 0, nil))
	h.input(cb, stashWithdraw(0, swordID, 0, nil))
	h.sim.Step()
	ra, rb := lastStash(ca.take()), lastStash(cb.take())
	if h.w.CountItem(a, "test_sword")+h.w.CountItem(b, "test_sword")+h.stashCount(100, swordID) != 1 {
		t.Fatal("the sword is not in exactly one place")
	}
	if h.w.CountItem(a, "test_sword") != 1 || ra.GetResult() != pb.StashResult_STASH_RESULT_OK {
		t.Fatalf("Ana, first in the queue, did not get it: %v", ra)
	}
	// Beto's answer to his own command is the last update he got.
	if rb.GetResult() != pb.StashResult_STASH_RESULT_CHANGED {
		t.Fatalf("Beto's withdraw: %v", rb)
	}
	if len(h.transfers) != 2 {
		t.Fatalf("%d transfers, want the deposit and one withdrawal", len(h.transfers))
	}
}

// stashRows is a crashDB that also keeps the stash rows its transfers wrote.
type stashRows struct {
	crashDB
	stash map[int64][]session.ItemState
}

func newStashRows() *stashRows {
	return &stashRows{crashDB: crashDB{rows: map[int64]session.Snapshot{}}, stash: map[int64][]session.ItemState{}}
}

func (d *stashRows) writeAll(h *harness) {
	for _, j := range d.log.jobs[d.written:] {
		if j.Transfer != nil {
			for _, op := range j.Transfer.Stash {
				d.stash[op.Account] = op.Items
			}
		}
	}
	d.crashDB.writeAll(h)
}

// total is how many units of item the rows of the characters ids and the stash of acc hold.
func (d *stashRows) total(acc int64, item uint16, ids ...int64) int {
	n := countState(d.stash[acc], item)
	for _, id := range ids {
		n += d.count(id, item)
	}
	return n
}

// A crash between a move and the database's ack never makes two swords nor loses one:
// lost before the write, the move is undone on both sides; written, it is whole on both.
// Ana deposits, Beto (same account) withdraws; whatever crashes, one sword.
func TestStashCrashKeepsOneItem(t *testing.T) {
	for _, cut := range []string{"before any write", "after the deposit", "after both"} {
		t.Run(cut, func(t *testing.T) {
			d := newStashRows()
			h := newStashHarness(t, 30, &d.log)
			ca, _ := h.account(1, 100, "Ana", pos(1, 1), nil, stack(swordID, 1, 0))
			cb, _ := h.account(2, 100, "Beto", pos(0, 1), nil)
			h.sim.Command(h.w.ForceSaveForTest(ca))
			h.sim.Command(h.w.ForceSaveForTest(cb))
			h.sim.Step()
			d.writeAll(h.harness)
			h.open(ca)
			h.open(cb)
			pack := openPack(t, h.harness, ca)
			h.send(ca, stashDeposit(inContainer(pack, 0), swordID, 1))
			if cut != "before any write" {
				d.writeAll(h.harness)
			}
			if u := lastStash(h.send(cb, stashWithdraw(0, swordID, 0, nil))); u.GetResult() != pb.StashResult_STASH_RESULT_OK {
				t.Fatalf("Beto's withdraw: %v", u)
			}
			if cut == "after both" {
				d.writeAll(h.harness)
			}
			d.crash()
			if n := d.total(100, swordID, 1, 2); n != 1 {
				t.Fatalf("the database holds the sword %d times (Ana %d, Beto %d, stash %d)", n, d.count(1, swordID),
					d.count(2, swordID), countState(d.stash[100], swordID))
			}
		})
	}
}

// The stash leaves memory only when the database has it and nobody needs it: after the
// last character of the account leaves and the last write is acked, and not while a
// login of the account is reading the database (that read may be older than the write).
func TestStashStaysUntilSavedAndNoLoginReads(t *testing.T) {
	d := newStashRows()
	h := newStashHarness(t, 30, &d.log)
	ca, _ := h.account(1, 100, "Ana", pos(1, 1), nil, stack(swordID, 1, 0))
	h.open(ca)
	pack := openPack(t, h.harness, ca)
	h.send(ca, stashDeposit(inContainer(pack, 0), swordID, 1))
	h.sim.Command(h.w.LoginStarted(2, 100)) // Beto's login reads the row now: no sword yet
	h.sim.Command(h.w.Leave(ca))
	h.sim.Step()
	d.writeAll(h.harness)
	if !h.w.StashLoaded(100) {
		t.Fatal("the stash left memory while a login of the account was reading")
	}
	cb, b := h.account(2, 100, "Beto", pos(0, 1), nil) // the stale read: an empty stash
	h.open(cb)
	if u := lastStash(h.send(cb, stashWithdraw(0, swordID, 0, nil))); u.GetResult() != pb.StashResult_STASH_RESULT_OK ||
		h.w.CountItem(b, "test_sword") != 1 {
		t.Fatalf("Beto did not get the sword Ana left: %v", u)
	}
	h.sim.Command(h.w.Leave(cb))
	h.sim.Step()
	if !h.w.StashLoaded(100) {
		t.Fatal("the stash left memory before its last write was acked")
	}
	d.writeAll(h.harness)
	if h.w.StashLoaded(100) {
		t.Fatal("the stash stayed in memory with nobody online and everything written")
	}
	// An aborted login does not keep it either.
	h.sim.Command(h.w.LoginStarted(1, 100))
	h.sim.Command(h.w.LoginAborted(1, 100))
	h.sim.Step()
	if h.w.StashLoaded(100) {
		t.Fatal("an aborted login brought the stash back")
	}
	// The next login reads the database: the stash is empty, Beto has the sword.
	if d.total(100, swordID, 1, 2) != 1 || d.count(2, swordID) != 1 {
		t.Fatal("the rows do not hold the sword once, with Beto")
	}
}

// A withdrawal holds the character like any transfer: what it took out does not reach the
// street (and someone else's save) before the database has the withdrawal.
func TestStashWithdrawHoldsTheCharacter(t *testing.T) {
	d := newStashRows()
	h := newStashHarness(t, 30, &d.log)
	ca, a := h.account(1, 100, "Ana", pos(1, 1), []session.ItemState{stack(swordID, 1, 0)})
	h.open(ca)
	h.send(ca, stashWithdraw(0, swordID, 0, nil))
	if !h.w.InFlightForTest(a.CharacterID()) {
		t.Fatal("the withdrawal did not hold Ana")
	}
	pack := openPack(t, h.harness, ca)
	if !hasKey(h.send(ca, moveItem(inContainer(pack, 0), swordID, 0, onTile(pos(2, 2)), 1)), "inventory.saving") {
		t.Fatal("Ana threw the sword on the street before the withdrawal was written")
	}
	d.writeAll(h.harness)
	if h.w.InFlightForTest(a.CharacterID()) {
		t.Fatal("the ack did not end the hold")
	}
}

// A transfer that could not be stored makes the World read-only: every stash window
// closes and nothing more goes in or out until a restart.
func TestStashClosesWhenReadOnly(t *testing.T) {
	h := newStashHarness(t, 30, nil)
	cl, _ := h.account(1, 100, "Ana", pos(1, 1), nil, stack(salveID, 5, 0))
	h.open(cl)
	h.sim.Command(h.w.Tainted(nil))
	h.sim.Step()
	if u := lastStash(cl.take()); u == nil || u.GetOpen() {
		t.Fatalf("the window stayed open: %v", u)
	}
	if u := lastStash(h.send(cl, openStash())); u.GetOpen() || u.GetResult() != pb.StashResult_STASH_RESULT_UNAVAILABLE {
		t.Fatalf("the stash opened read-only: %v", u)
	}
}

func stashTransfer(id uint64, acc int64, chars ...int64) session.Transfer {
	t := tr(id, chars...)
	t.Stash = []session.StashOp{{Account: acc}}
	return t
}

// The Saver guards a stash like a house floor: once a transfer that replaced it is
// dropped, no later transfer writes it, and whoever moves things through it after that is
// tainted too; another account's stash is still written.
func TestSaverTaintsTheStash(t *testing.T) {
	f := &fakeDB{reject: map[uint64]bool{1: true}}
	s := f.saver(t)
	s.Start()
	s.SubmitTransfer(stashTransfer(1, 100, 1)) // Ana's deposit: rejected
	s.SubmitTransfer(stashTransfer(2, 100, 2)) // Beto takes it out: skipped, Beto tainted
	s.SubmitTransfer(stashTransfer(3, 200, 3)) // another account: written
	if err := s.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(f.stored, []string{"transfer 3"}) {
		t.Fatalf("stored %v", f.stored)
	}
	if len(f.tainted) != 2 || !slices.Equal(f.tainted[1], []int64{2}) {
		t.Fatalf("tainted %v", f.tainted)
	}
	if !s.Tainted(session.Job{Transfer: &session.Transfer{Stash: []session.StashOp{{Account: 100}}}}) {
		t.Fatal("the stash of account 100 is not tainted")
	}
}
