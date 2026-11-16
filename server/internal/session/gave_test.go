package session_test

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// The save before a transfer (T5.3 fail-safe, docs/01 "Transacciones", hold.go gaveAway).
// A character whose transfer is dropped goes back to its last written save. Whatever it
// gave away to the public ground before that transfer (thrown on the street, or made for
// it by the server and fallen at its feet) must be out of that save already: whoever
// picked it up keeps it in their own save, so otherwise it would be in two rows. That save
// is the state at the end of the command (or tick) of the give-away, whole.

// rowsDB is the database of these tests, behind a real Saver: each character's row is
// its last written snapshot. Transfers carrying the character in reject are rejected
// (ErrPermanent), as a bug or a constraint would.
type rowsDB struct {
	t       *testing.T
	saver   *session.Saver
	reject  atomic.Int64
	tainted chan []int64
	mu      sync.Mutex
	rows    map[int64]session.Snapshot
	acks    []session.Snapshot
	// Submitted by the loop (the test goroutine), in order.
	jobs []session.Job
}

// syncChar is the character of the snapshot sync submits behind the loop's jobs.
const syncChar = -1

func newRowsDB(t *testing.T) *rowsDB {
	t.Helper()
	db := &rowsDB{t: t, rows: map[int64]session.Snapshot{}, tainted: make(chan []int64, 16)}
	s, err := session.NewSaver(session.SaverConfig{
		Write: func(_ context.Context, sn session.Snapshot) error {
			db.put(sn)
			return nil
		},
		WriteTransfer: func(_ context.Context, tr session.Transfer) error {
			for _, sn := range tr.Snapshots {
				if sn.CharacterID == db.reject.Load() {
					return fmt.Errorf("%w: injected", session.ErrPermanent)
				}
			}
			db.put(tr.Snapshots...)
			return nil
		},
		Saved: func(sn session.Snapshot) {
			db.mu.Lock()
			db.acks = append(db.acks, sn)
			db.mu.Unlock()
		},
		Tainted: func(ids []int64) { db.tainted <- ids },
		Clock:   clock.NewFake(clock.Epoch),
	})
	if err != nil {
		t.Fatal(err)
	}
	db.saver = s
	s.Start()
	t.Cleanup(func() { _ = s.Stop(context.Background()) })
	return db
}

func (db *rowsDB) put(ss ...session.Snapshot) {
	db.mu.Lock()
	defer db.mu.Unlock()
	for _, s := range ss {
		db.rows[s.CharacterID] = s
	}
}

// wire is a harness option: the World's jobs go to the Saver (and to db.jobs). No
// autosave runs: its first one falls on a random tick, and a row must be the snapshot
// the test means.
func (db *rowsDB) wire(c *session.Config) {
	c.AutosaveEvery = session.DefaultAutosaveEvery * 1000
	c.Save = func(s session.Snapshot) bool {
		db.jobs = append(db.jobs, session.Job{Snapshot: s})
		return db.saver.Submit(s)
	}
	c.Transfer = func(tr session.Transfer) bool {
		db.jobs = append(db.jobs, session.Job{Transfer: &tr})
		return db.saver.SubmitTransfer(tr)
	}
}

// sync waits until the Saver has handled every job the loop submitted so far, hands its
// acks to the loop (as app does) in one tick and returns the characters it tainted
// meanwhile (not yet told to the loop). The loop does not run while it waits: the tick
// the acks arrive in does not depend on how fast the Saver's goroutine is.
func (db *rowsDB) sync(h *harness) []int64 {
	db.t.Helper()
	seq := uint64(len(db.jobs) + 1)
	if !db.saver.Submit(session.Snapshot{CharacterID: syncChar, Seq: seq}) {
		db.t.Fatal("the Saver refused the sync snapshot")
	}
	deadline := time.Now().Add(10 * time.Second) //nolint:forbidigo // bounds a wait on the Saver's goroutine
	for {
		db.mu.Lock()
		done := slices.ContainsFunc(db.acks, func(a session.Snapshot) bool { return a.CharacterID == syncChar && a.Seq == seq })
		db.mu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) { //nolint:forbidigo // bounds a wait on the Saver's goroutine
			db.t.Fatal("the Saver did not get to the sync snapshot")
		}
		time.Sleep(time.Millisecond) //nolint:forbidigo // polls the Saver's goroutine
	}
	db.mu.Lock()
	acks := db.acks
	db.acks = nil
	db.mu.Unlock()
	for _, a := range acks {
		if a.CharacterID != syncChar {
			h.sim.Command(h.w.Saved(a.CharacterID, a.Seq))
		}
	}
	h.sim.Step()
	var out []int64
	for {
		select {
		case ids := <-db.tainted:
			out = append(out, ids...)
		default:
			return out
		}
	}
}

// saveNow writes cl's player now (an autosave) and waits for it: its last written save.
func (db *rowsDB) saveNow(h *harness, cl *fakeClient) {
	db.t.Helper()
	h.sim.Command(h.w.ForceSaveForTest(cl))
	h.sim.Step()
	if ids := db.sync(h); len(ids) != 0 {
		db.t.Fatalf("tainted %v", ids)
	}
}

// rowSeq is the Seq of the row of character id: which snapshot of it the database has.
func (db *rowsDB) rowSeq(id int64) uint64 {
	db.t.Helper()
	db.mu.Lock()
	defer db.mu.Unlock()
	row, ok := db.rows[id]
	if !ok {
		db.t.Fatalf("character %d has no row", id)
	}
	return row.Seq
}

// preSeq is the Seq of the plain snapshot of character id the loop submitted last before
// the last transfer that carries it: the save before that transfer (hold.go
// transferSnapshot).
func (db *rowsDB) preSeq(id int64) uint64 {
	db.t.Helper()
	last := -1
	for i, j := range db.jobs {
		if j.Transfer != nil && slices.ContainsFunc(j.Transfer.Snapshots, func(s session.Snapshot) bool { return s.CharacterID == id }) {
			last = i
		}
	}
	for i := last - 1; i >= 0; i-- {
		if j := db.jobs[i]; j.Transfer == nil && j.Snapshot.CharacterID == id {
			return j.Snapshot.Seq
		}
	}
	db.t.Fatalf("no save of character %d before its last transfer", id)
	return 0
}

// count is how many units of item the row of character id holds.
func (db *rowsDB) count(id int64, item uint16) int {
	db.t.Helper()
	db.mu.Lock()
	row, ok := db.rows[id]
	db.mu.Unlock()
	if !ok {
		db.t.Fatalf("character %d has no row", id)
	}
	var walk func([]session.ItemState) int
	walk = func(list []session.ItemState) int {
		n := 0
		for _, s := range list {
			if s.ItemID == item {
				n += s.Count
			}
			n += walk(s.Items)
		}
		return n
	}
	return walk(row.Inventory)
}

// storage is the quest_state value key in the row of character id.
func (db *rowsDB) storage(id int64, key string) int64 {
	db.t.Helper()
	db.mu.Lock()
	defer db.mu.Unlock()
	row, ok := db.rows[id]
	if !ok {
		db.t.Fatalf("character %d has no row", id)
	}
	return row.Storage[key]
}

// Ana throws her sword on the street; Caio picks it up and logs out, his save is written.
// Then Ana's next transfer (a sell offer) is rejected and she goes back to her last
// written save: it must be the one from after the throw, or the sword is in both rows.
func TestDroppedTransferKeepsWhatWasThrownAway(t *testing.T) {
	db := newRowsDB(t)
	h := newMarketHarness(t, db.wire)
	ca, a := h.atBoard("Ana", pos(1, 0), stack(swordID, 1, 0), stack(salveID, 30, 1), stack(coinID, 50, 2))
	cc, c := h.trader("Caio", pos(1, 1), stack(coinID, 5, 0))
	db.saveNow(h.harness, ca) // her last written save has the sword

	pack := openPack(t, h.harness, ca)
	if evs := h.send(ca, moveItem(inContainer(pack, 0), swordID, 0, onTile(pos(2, 1)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Ana throws the sword away: %v", systemKeys(evs))
	}
	cp := openPack(t, h.harness, cc)
	if evs := h.send(cc, moveItem(onTile(pos(2, 1)), swordID, 1, inContainer(cp, 0), 1)); len(systemKeys(evs)) != 0 ||
		h.w.CountItem(c, "test_sword") != 1 {
		t.Fatalf("Caio picks it up: %v", systemKeys(evs))
	}
	h.sim.Command(h.w.Leave(cc))
	h.sim.Step()

	db.reject.Store(a.CharacterID())
	h.send(ca, createOffer(sell, salveID, 10, 4))
	if ids := db.sync(h.harness); !slices.Equal(ids, []int64{a.CharacterID()}) {
		t.Fatalf("tainted %v, want Ana", ids)
	}
	if n := db.count(a.CharacterID(), swordID) + db.count(c.CharacterID(), swordID); n != 1 {
		t.Fatalf("the database holds the sword %d times (Ana %d, Caio %d)", n,
			db.count(a.CharacterID(), swordID), db.count(c.CharacterID(), swordID))
	}
	if db.count(a.CharacterID(), salveID) != 30 || db.count(a.CharacterID(), coinID) != 50 ||
		db.rowSeq(a.CharacterID()) != db.preSeq(a.CharacterID()) {
		t.Fatal("Ana's row is not her save right before the rejected offer")
	}
}

// The same with a bag lying on the street: Ana puts her sword in it, Caio carries the bag
// away and logs out. Ana's next transfer is rejected: her row must not have the sword.
func TestDroppedTransferKeepsWhatWasPutInAStreetBag(t *testing.T) {
	db := newRowsDB(t)
	h := newMarketHarness(t, db.wire)
	ca, a := h.atBoard("Ana", pos(1, 0), stack(swordID, 1, 0), stack(salveID, 30, 1), stack(coinID, 50, 2))
	cc, c := h.trader("Caio", pos(1, 1), stack(coinID, 5, 0))
	h.sim.Command(gameFunc(func() { h.w.DropForTest(h.w.ItemForTest("test_bag"), 1, pos(2, 1)) }))
	h.sim.Step()
	db.saveNow(h.harness, ca) // her last written save has the sword

	pack := openPack(t, h.harness, ca)
	h.input(ca, useItem(onTile(pos(2, 1)), bagID, 1))
	h.sim.Step()
	opens := find(ca.take(), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 || opens[0].GetItemId() != bagID {
		t.Fatalf("Ana opens the bag on the street: %v", opens)
	}
	if evs := h.send(ca, moveItem(inContainer(pack, 0), swordID, 0, inContainer(opens[0].GetContainerId(), 0), 1)); len(systemKeys(evs)) != 0 ||
		h.w.CountItem(a, "test_sword") != 0 {
		t.Fatalf("Ana puts the sword in the bag: %v", systemKeys(evs))
	}
	cp := openPack(t, h.harness, cc)
	if evs := h.send(cc, moveItem(onTile(pos(2, 1)), bagID, 1, inContainer(cp, 0), 1)); len(systemKeys(evs)) != 0 ||
		h.w.CountItem(c, "test_sword") != 1 {
		t.Fatalf("Caio carries the bag away: %v", systemKeys(evs))
	}
	h.sim.Command(h.w.Leave(cc))
	h.sim.Step()

	db.reject.Store(a.CharacterID())
	h.send(ca, createOffer(sell, salveID, 10, 4))
	if ids := db.sync(h.harness); !slices.Equal(ids, []int64{a.CharacterID()}) {
		t.Fatalf("tainted %v, want Ana", ids)
	}
	if n := db.count(a.CharacterID(), swordID) + db.count(c.CharacterID(), swordID); n != 1 {
		t.Fatalf("the database holds the sword %d times (Ana %d, Caio %d)", n,
			db.count(a.CharacterID(), swordID), db.count(c.CharacterID(), swordID))
	}
	if db.rowSeq(a.CharacterID()) != db.preSeq(a.CharacterID()) {
		t.Fatal("Ana's row is not her save right before the rejected offer")
	}
}

// The harbor master takes Ana's logbook and gives her the guardian's sword, which falls
// at her feet (she carries too much); the node it leads to completes the quest, in the
// same command. Caio picks the sword up and logs out, and Ana's next trade is rejected.
// Her row must be her state at the end of that command, with the quest completed: one
// from when the sword fell has the quest still waiting for a logbook, which the foreman
// hands out again, and the sword would be paid twice.
func TestDroppedTransferKeepsTheWholeDialog(t *testing.T) {
	db := newRowsDB(t)
	h := dataHarnessWith(t, db.wire)
	sword, rope := itemNum(t, h, nil, "iron_sword"), itemNum(t, h, nil, "rope")
	backpack := itemNum(t, h, nil, "backpack")
	const questKey = "quest.ch1_shipwreck"
	ca, a := h.joinFresh(session.Character{ID: 9201, AccountID: 9201, Name: "Ana", Vocation: "guardian", Level: 1,
		Health: 145, Mana: 20, Storage: map[string]int64{questKey: 1, questKey + ".step": 3}}, pos(8, 11)) // return_logbook
	cb, b := h.joinFresh(session.Character{ID: 9202, AccountID: 9202, Name: "Beto", Vocation: "guardian", Level: 1,
		Health: 145, Mana: 20}, pos(9, 12))
	cc, c := h.joinFresh(session.Character{ID: 9203, AccountID: 9203, Name: "Caio", Vocation: "guardian", Level: 1,
		Health: 145, Mana: 20}, pos(9, 11))
	h.sim.Command(gameFunc(func() {
		h.w.GiveForTest(a, "rope", 1)
		h.w.GiveForTest(a, "bosun_logbook", 1)
	}))
	h.sim.Step()
	db.saveNow(h, ca) // her last written save has the logbook, and the quest waiting for it

	h.sim.Command(gameFunc(func() { h.w.SetCapacityForTest(a, 0) })) // the sword will not fit
	h.sim.Step()
	ca.take()
	d := h.lastDialog(h.send(ca, talkMsg(h.npc("harbor_master").ID())))
	evs := h.pick(ca, d, "npc.harbor_master.opt_ch1_logbook")
	if !messageKeys(evs)["dialog.item_on_floor"] || h.w.CountItem(a, "iron_sword") != 0 {
		t.Fatalf("the sword did not fall: %v", messageKeys(evs))
	}
	if st, _ := h.w.QuestState(a, "ch1_shipwreck"); st.String() != "completed" {
		t.Fatalf("the quest is %v after handing the logbook in", st)
	}
	h.input(cc, useItem(inSlot(slotBackpack), backpack, 0))
	h.sim.Step()
	cp := find(cc.take(), (*pb.ServerMessage).GetContainerOpen)[0].GetContainerId()
	if evs := h.send(cc, moveItem(onTile(pos(8, 11)), sword, 1, inContainer(cp, 0), 1)); len(systemKeys(evs)) != 0 ||
		h.w.CountItem(c, "iron_sword") != 1 {
		t.Fatalf("Caio picks the sword up: %v", systemKeys(evs))
	}
	h.sim.Command(h.w.Leave(cc))
	h.sim.Step()

	// Ana gives Beto her rope; the trade is rejected.
	db.reject.Store(a.CharacterID())
	h.input(ca, useItem(inSlot(slotBackpack), backpack, 0))
	h.sim.Step()
	wa := find(ca.take(), (*pb.ServerMessage).GetContainerOpen)[0].GetContainerId()
	h.send(ca, tradeReq(b.ID(), inContainer(wa, 0), rope))
	h.send(cb, tradeReq(a.ID(), nil, 0))
	h.send(ca, tradeAccept)
	if u := lastTrade(h.send(cb, tradeAccept)); u.GetState() != pb.TradeState_TRADE_STATE_COMPLETED {
		t.Fatalf("the trade did not complete: %v", u)
	}
	ids := db.sync(h)
	slices.Sort(ids)
	if !slices.Equal(ids, []int64{a.CharacterID(), b.CharacterID()}) {
		t.Fatalf("tainted %v, want Ana and Beto", ids)
	}
	if n := db.count(a.CharacterID(), uint16(sword)) + db.count(c.CharacterID(), uint16(sword)); n != 1 {
		t.Fatalf("the database holds the sword %d times", n)
	}
	if v := db.storage(a.CharacterID(), questKey); v != 2 {
		t.Fatalf("Ana's row has the quest at %d, not completed: she can hand a new logbook in", v)
	}
	if db.count(a.CharacterID(), uint16(rope)) != 1 || db.count(a.CharacterID(), uint16(itemNum(t, h, nil, "bosun_logbook"))) != 0 ||
		db.rowSeq(a.CharacterID()) != db.preSeq(a.CharacterID()) {
		t.Fatal("Ana's row is not her save right before the rejected trade")
	}
}

// The coins of an NPC sale fall at Ana's feet (she carries too much) and Caio picks them
// up. Ana's next trade is rejected: her row must not have the pelts she sold any more, or
// they are sold twice (the coins are in Caio's row).
func TestDroppedTransferKeepsTheNPCSale(t *testing.T) {
	db := newRowsDB(t)
	h := dataHarnessWith(t, db.wire)
	pelt, rope, coin := itemNum(t, h, nil, "wolf_pelt"), itemNum(t, h, nil, "rope"), itemNum(t, h, nil, "copper_coin")
	backpack := itemNum(t, h, nil, "backpack")
	ca, a := h.joinFresh(session.Character{ID: 9101, AccountID: 9101, Name: "Ana", Vocation: "guardian", Level: 1,
		Health: 145, Mana: 20}, pos(11, 11))
	cb, b := h.joinFresh(session.Character{ID: 9102, AccountID: 9102, Name: "Beto", Vocation: "guardian", Level: 1,
		Health: 145, Mana: 20}, pos(11, 12))
	cc, c := h.joinFresh(session.Character{ID: 9103, AccountID: 9103, Name: "Caio", Vocation: "guardian", Level: 1,
		Health: 145, Mana: 20}, pos(10, 11))
	h.sim.Command(gameFunc(func() {
		h.w.GiveForTest(a, "rope", 1)
		h.w.GiveForTest(a, "wolf_pelt", 3)
	}))
	h.sim.Step()
	db.saveNow(h, ca) // her last written save has the pelts

	h.sim.Command(gameFunc(func() { h.w.SetCapacityForTest(a, 0) })) // the coins will not fit
	h.sim.Step()
	ca.take()
	d := h.lastDialog(h.send(ca, talkMsg(h.npc("puerto_provisioner").ID())))
	h.pick(ca, d, "dialog.trade")
	evs := h.send(ca, &pb.ClientMessage{Message: &pb.ClientMessage_ShopSell{ShopSell: &pb.ShopSell{
		DialogId: d.DialogId, ItemId: pelt, Count: 3}}})
	if !messageKeys(evs)["dialog.item_on_floor"] || h.w.CountItem(a, "wolf_pelt") != 0 {
		t.Fatalf("the sale's coins did not fall: %v", messageKeys(evs))
	}
	h.input(cc, useItem(inSlot(slotBackpack), backpack, 0))
	h.sim.Step()
	cp := find(cc.take(), (*pb.ServerMessage).GetContainerOpen)[0].GetContainerId()
	if evs := h.send(cc, moveItem(onTile(pos(11, 11)), coin, 1, inContainer(cp, 0), 15)); len(systemKeys(evs)) != 0 ||
		h.w.Money(c) != 15 {
		t.Fatalf("Caio picks the coins up: %v, money %d", systemKeys(evs), h.w.Money(c))
	}
	h.sim.Command(h.w.Leave(cc))
	h.sim.Step()

	// Ana gives Beto her rope; the trade is rejected.
	db.reject.Store(a.CharacterID())
	h.input(ca, useItem(inSlot(slotBackpack), backpack, 0))
	h.sim.Step()
	wa := find(ca.take(), (*pb.ServerMessage).GetContainerOpen)[0].GetContainerId()
	h.send(ca, tradeReq(b.ID(), inContainer(wa, 0), rope))
	h.send(cb, tradeReq(a.ID(), nil, 0))
	h.send(ca, tradeAccept)
	if u := lastTrade(h.send(cb, tradeAccept)); u.GetState() != pb.TradeState_TRADE_STATE_COMPLETED {
		t.Fatalf("the trade did not complete: %v", u)
	}
	ids := db.sync(h)
	slices.Sort(ids)
	if !slices.Equal(ids, []int64{a.CharacterID(), b.CharacterID()}) {
		t.Fatalf("tainted %v, want Ana and Beto", ids)
	}
	if n := db.count(a.CharacterID(), uint16(pelt)); n != 0 {
		t.Fatalf("Ana's row still has the %d pelts she sold; Caio's has their coins (%d)", n,
			db.count(c.CharacterID(), uint16(coin)))
	}
	if db.count(a.CharacterID(), uint16(rope)) != 1 || db.rowSeq(a.CharacterID()) != db.preSeq(a.CharacterID()) {
		t.Fatal("Ana's row is not her save right before the rejected trade")
	}
}

// Ana, who rents the cottage, throws a salve on the street (Caio takes it and logs out)
// and then puts her sword on her house floor. That house write is rejected: her row must
// be her state between the two, without the salve and still with the sword (the house's
// row does not have it either).
func TestDroppedHouseWriteKeepsWhatWasThrownAway(t *testing.T) {
	db := newRowsDB(t)
	h := newHouseHarness(t, db.wire)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(salveID, 5, 1), stack(coinID, 100, 2),
		stack(coinID, 100, 3))
	h.rent(cl)
	h.step(cl, N) // the door tile (3,4): the house (3,3) and the street (2..4, 5) within reach
	db.sync(h.harness)
	if h.w.InFlightForTest(a.CharacterID()) {
		t.Fatal("Ana is still held by her rent")
	}
	cc, c := h.tenant("Caio", 0, pos(5, 5), stack(coinID, 1, 0))

	pack := openPack(t, h.harness, cl)
	if evs := h.send(cl, moveItem(inContainer(pack, 1), salveID, 0, onTile(pos(4, 5)), 5)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Ana throws the salves away: %v", systemKeys(evs))
	}
	cp := openPack(t, h.harness, cc)
	if evs := h.send(cc, moveItem(onTile(pos(4, 5)), salveID, 1, inContainer(cp, 0), 5)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Caio picks them up: %v", systemKeys(evs))
	}
	h.sim.Command(h.w.Leave(cc))
	h.sim.Step()

	db.reject.Store(a.CharacterID())
	if evs := h.send(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(pos(3, 3)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Ana puts her sword in the house: %v", systemKeys(evs))
	}
	if ids := db.sync(h.harness); !slices.Equal(ids, []int64{a.CharacterID()}) {
		t.Fatalf("tainted %v, want Ana", ids)
	}
	if n := db.count(a.CharacterID(), salveID) + db.count(c.CharacterID(), salveID); n != 5 {
		t.Fatalf("the database holds %d salves (Ana %d), want the 5 in Caio's row", n, db.count(a.CharacterID(), salveID))
	}
	if db.count(a.CharacterID(), swordID) != 1 || db.rowSeq(a.CharacterID()) != db.preSeq(a.CharacterID()) {
		t.Fatal("Ana's row is not her save between the throw and the rejected house write")
	}
}

// The taint spreads to a trade partner (the Saver's fixed point): Beto, who threw his
// sword on the street before (Caio has it now, saved), trades with Ana right after her
// rejected offer. The trade is skipped and Beto goes back to his last written save: the
// one from after the throw.
func TestSkippedTransferKeepsWhatThePartnerThrewAway(t *testing.T) {
	db := newRowsDB(t)
	h := newMarketHarness(t, db.wire)
	ca, a := h.atBoard("Ana", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.trader("Beto", pos(2, 1), stack(swordID, 1, 0), stack(coinID, 10, 1))
	cc, c := h.trader("Caio", pos(3, 1), stack(coinID, 5, 0))
	db.saveNow(h.harness, cb) // Beto's last written save has the sword

	wb := openPack(t, h.harness, cb)
	if evs := h.send(cb, moveItem(inContainer(wb, 0), swordID, 0, onTile(pos(3, 2)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Beto throws the sword away: %v", systemKeys(evs))
	}
	cp := openPack(t, h.harness, cc)
	if evs := h.send(cc, moveItem(onTile(pos(3, 2)), swordID, 1, inContainer(cp, 0), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Caio picks it up: %v", systemKeys(evs))
	}
	h.sim.Command(h.w.Leave(cc))
	h.sim.Step()

	// Ana's offer is rejected; the loop does not know yet when she trades with Beto.
	db.reject.Store(a.CharacterID())
	h.send(ca, createOffer(sell, salveID, 10, 4))
	wa := openPack(t, h.harness, ca)
	h.send(ca, tradeReq(b.ID(), inContainer(wa, 0), salveID))
	h.send(cb, tradeReq(a.ID(), nil, 0))
	h.send(ca, tradeAccept)
	if u := lastTrade(h.send(cb, tradeAccept)); u.GetState() != pb.TradeState_TRADE_STATE_COMPLETED {
		t.Fatalf("the trade did not complete: %v", u)
	}
	if ids := db.sync(h.harness); !slices.Equal(ids, []int64{a.CharacterID(), b.CharacterID()}) {
		t.Fatalf("tainted %v, want Ana then Beto", ids)
	}
	if n := db.count(b.CharacterID(), swordID) + db.count(c.CharacterID(), swordID); n != 1 {
		t.Fatalf("the database holds the sword %d times (Beto %d)", n, db.count(b.CharacterID(), swordID))
	}
	if db.count(b.CharacterID(), salveID) != 0 || db.count(b.CharacterID(), coinID) != 10 ||
		db.rowSeq(b.CharacterID()) != db.preSeq(b.CharacterID()) {
		t.Fatal("Beto's row is not his save right before the skipped trade")
	}
}

// jobLog records the jobs the World submits, in order (no Saver behind).
type jobLog struct{ jobs []session.Job }

func (l *jobLog) wire(c *session.Config) {
	c.Save = func(s session.Snapshot) bool { l.jobs = append(l.jobs, session.Job{Snapshot: s}); return true }
	c.Transfer = func(tr session.Transfer) bool { l.jobs = append(l.jobs, session.Job{Transfer: &tr}); return true }
}

// since returns the jobs after the first n.
func (l *jobLog) since(n int) []session.Job { return l.jobs[n:] }

// The cost and the order of the save before a transfer: a transfer of a character that
// gave nothing away since its last snapshot costs no extra write; after a throw, its next
// transfer comes right behind one snapshot of the character from the moment of the throw
// (numbered then, so its ack ends no hold of the transfer), and only once; a later
// autosave or the logout's final save replaces it.
func TestSaveBeforeTransferOnlyAfterAThrow(t *testing.T) {
	log := &jobLog{}
	h := newMarketHarness(t, log.wire)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0), stack(swordID, 1, 1), stack(bagID, 1, 2))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	offer := h.w.MarketOffers(s.CharacterID())[0]

	// Nothing thrown away: the purchase is one job.
	n := len(log.jobs)
	h.send(cb, acceptOffer(offer, 1))
	if jobs := log.since(n); len(jobs) != 1 || jobs[0].Transfer == nil {
		t.Fatalf("a transfer without a throw before it = %d jobs", len(jobs))
	}
	bought := jobs0Snapshot(t, log.jobs[len(log.jobs)-1], b.CharacterID())
	h.sim.Command(h.w.Saved(b.CharacterID(), bought.Seq))
	h.sim.Step()

	// Bruno throws his sword away, then buys again: his snapshot of the throw goes first.
	pack := openPack(t, h.harness, cb)
	n = len(log.jobs)
	if evs := h.send(cb, moveItem(inContainer(pack, 1), swordID, 0, onTile(pos(0, 2)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Bruno throws the sword away: %v", systemKeys(evs))
	}
	if len(log.since(n)) != 0 {
		t.Fatal("throwing something away wrote at once")
	}
	h.send(cb, acceptOffer(offer, 1))
	jobs := log.since(n)
	if len(jobs) != 2 || jobs[0].Transfer != nil || jobs[1].Transfer == nil {
		t.Fatalf("a transfer after a throw = %d jobs, want the snapshot then the transfer", len(jobs))
	}
	pre, again := jobs[0].Snapshot, jobs0Snapshot(t, jobs[1], b.CharacterID())
	if pre.CharacterID != b.CharacterID() || pre.Final || pre.Seq <= bought.Seq || pre.Seq >= again.Seq {
		t.Fatalf("snapshot before the transfer %+v (bought %d, transfer %d)", pre, bought.Seq, again.Seq)
	}
	if countState(pre.Inventory, swordID) != 0 || countState(pre.Inventory, salveID) != 1 {
		t.Fatal("the snapshot before the transfer is not Bruno's state between the throw and the purchase")
	}
	h.sim.Command(h.w.Saved(b.CharacterID(), pre.Seq))
	h.sim.Step()
	if !h.w.InFlightForTest(b.CharacterID()) {
		t.Fatal("the ack of the snapshot before the transfer ended its hold")
	}

	// Only once: the next transfer has no snapshot before it.
	n = len(log.jobs)
	h.send(cb, acceptOffer(offer, 1))
	if jobs := log.since(n); len(jobs) != 1 {
		t.Fatalf("a second transfer wrote %d jobs", len(jobs))
	}
	h.sim.Command(h.w.Saved(b.CharacterID(), jobs0Snapshot(t, log.jobs[len(log.jobs)-1], b.CharacterID()).Seq))
	h.sim.Step()

	// An autosave after a throw replaces the snapshot of the throw.
	if evs := h.send(cb, moveItem(inContainer(pack, 0), coinID, 0, onTile(pos(0, 2)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Bruno throws a coin away: %v", systemKeys(evs))
	}
	h.sim.Command(h.w.ForceSaveForTest(cb))
	h.sim.Step()
	n = len(log.jobs)
	h.send(cb, acceptOffer(offer, 1))
	if jobs := log.since(n); len(jobs) != 1 {
		t.Fatalf("a transfer after an autosave wrote %d jobs", len(jobs))
	}

	// The logout's final save replaces it too: nothing else is written for Bruno.
	h.sim.Command(h.w.Saved(b.CharacterID(), jobs0Snapshot(t, log.jobs[len(log.jobs)-1], b.CharacterID()).Seq))
	h.sim.Step()
	if evs := h.send(cb, moveItem(inContainer(pack, 0), coinID, 0, onTile(pos(0, 2)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Bruno throws another coin away: %v", systemKeys(evs))
	}
	n = len(log.jobs)
	h.sim.Command(h.w.Leave(cb))
	h.sim.Step()
	if jobs := log.since(n); len(jobs) != 1 || !jobs[0].Snapshot.Final {
		t.Fatalf("the logout wrote %d jobs", len(jobs))
	}
}

// A gift that falls in many piles keeps one snapshot, from the end of the tick (or of the
// command), not one per pile: five swords that do not fit cost one snapshot in memory,
// and it holds none of them.
func TestGiftThatFallsKeepsOneSnapshot(t *testing.T) {
	log := &jobLog{}
	h := newMarketHarness(t, log.wire)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	offer := h.w.MarketOffers(s.CharacterID())[0]
	h.send(cb, acceptOffer(offer, 1))
	bought := jobs0Snapshot(t, log.jobs[len(log.jobs)-1], b.CharacterID())
	h.sim.Command(h.w.Saved(b.CharacterID(), bought.Seq))
	h.sim.Step()

	h.sim.Command(gameFunc(func() {
		h.w.SetCapacityForTest(b, 0)
		h.w.GiveForTest(b, "test_sword", 5)
		h.w.SetCapacityForTest(b, 1_000_000)
	}))
	h.sim.Step()
	if n := len(h.w.GroundAt(pos(0, 1))); n != 5 {
		t.Fatalf("%d swords fell, want 5", n)
	}
	n := len(log.jobs)
	h.send(cb, acceptOffer(offer, 1))
	jobs := log.since(n)
	if len(jobs) != 2 || jobs[0].Transfer != nil || jobs[1].Transfer == nil {
		t.Fatalf("a transfer after the gift = %d jobs, want the snapshot then the transfer", len(jobs))
	}
	if pre := jobs[0].Snapshot; pre.Seq != bought.Seq+1 || countState(pre.Inventory, swordID) != 0 {
		t.Fatalf("snapshot before the transfer: seq %d (last one %d), %d swords", pre.Seq, bought.Seq,
			countState(pre.Inventory, swordID))
	}
	// From the end of the gift's tick: nothing of the purchase that follows.
	if pre := jobs[0].Snapshot; countState(pre.Inventory, salveID) != 1 || countState(pre.Inventory, coinID) != 96 {
		t.Fatalf("the snapshot before the transfer holds part of it: %+v", pre.Inventory)
	}
}

// The snapshot of a throw is the state at the end of the throw's command, also when a
// transfer of the same player runs later in the same tick: it never holds part of that
// transfer, which would then be written outside the transfer's database transaction.
func TestSaveBeforeTransferIsFromTheThrowsCommand(t *testing.T) {
	log := &jobLog{}
	h := newMarketHarness(t, log.wire)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, _ := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0), stack(swordID, 1, 1))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	offer := h.w.MarketOffers(s.CharacterID())[0]
	pack := openPack(t, h.harness, cb)

	n := len(log.jobs)
	h.input(cb, moveItem(inContainer(pack, 1), swordID, 0, onTile(pos(0, 2)), 1))
	h.input(cb, acceptOffer(offer, 1))
	h.sim.Step()
	jobs := log.since(n)
	if len(jobs) != 2 || jobs[0].Transfer != nil || jobs[1].Transfer == nil {
		t.Fatalf("a throw and a purchase in one tick = %d jobs, want the snapshot then the transfer", len(jobs))
	}
	if pre := jobs[0].Snapshot; countState(pre.Inventory, swordID) != 0 || countState(pre.Inventory, salveID) != 0 ||
		countState(pre.Inventory, coinID) != 100 {
		t.Fatalf("the snapshot before the transfer is not Bruno's state between the throw and the purchase: %+v",
			pre.Inventory)
	}
}

// A relogin while the old login is still in the world (the new connection takes it over
// and closes the old one, LOGGED_IN_ELSEWHERE) with the snapshot of a throw pending: the
// old login's final snapshot comes after the throw and replaces it, and the new login's
// first transfer writes nothing before it. The same when the old login is link-dead under
// its PvP lock (Leave in a fight): its takeover (pvpCarry) goes through the same final
// snapshot.
func TestReloginReplacesTheSaveBeforeTransfer(t *testing.T) {
	for _, way := range []string{"online", "link-dead"} {
		t.Run(way, func(t *testing.T) {
			log := &jobLog{}
			h := newMarketHarness(t, log.wire, func(c *session.Config) { c.Balance.PvP = pvpRules() })
			cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
			cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0), stack(swordID, 1, 1))
			h.send(cs, createOffer(sell, salveID, 10, 4))
			offer := h.w.MarketOffers(s.CharacterID())[0]

			pack := openPack(t, h.harness, cb)
			if evs := h.send(cb, moveItem(inContainer(pack, 1), swordID, 0, onTile(pos(0, 2)), 1)); len(systemKeys(evs)) != 0 {
				t.Fatalf("Bruno throws the sword away: %v", systemKeys(evs))
			}
			n := len(log.jobs)
			if way == "link-dead" {
				h.sim.Command(gameFunc(func() { h.w.SetPvPLockForTest(b, h.sim.Tick()+20) }))
				h.sim.Command(h.w.Leave(cb))
				h.sim.Step()
				if !b.LinkDead() || h.w.PlayerByCharacter(b.CharacterID()) != b || len(log.since(n)) != 0 {
					t.Fatalf("Bruno link-dead %v in the world, %d jobs written", b.LinkDead(), len(log.since(n)))
				}
			}
			again := withPack(b.CharacterID(), pos(0, 1))
			again.Name = "Bruno"
			cb2, _ := h.joinChar(again)
			jobs := log.since(n)
			if len(jobs) != 1 || jobs[0].Transfer != nil || !jobs[0].Snapshot.Final ||
				countState(jobs[0].Snapshot.Inventory, swordID) != 0 || countState(jobs[0].Snapshot.Inventory, coinID) != 100 {
				t.Fatalf("the relogin wrote %d jobs, want the old login's final snapshot after the throw", len(jobs))
			}
			h.sim.RunFor(2 * time.Second) // past the lock the link-dead login carried
			if u := lastMarket(h.send(cb2, useBoard())); !u.GetOpen() {
				t.Fatal("the market did not open")
			}
			n = len(log.jobs)
			h.send(cb2, acceptOffer(offer, 1))
			if jobs := log.since(n); len(jobs) != 1 || jobs[0].Transfer == nil {
				t.Fatalf("the new login's first transfer wrote %d jobs", len(jobs))
			}
		})
	}
}

// What falls at the feet of a held player stays reserved to it until the ack of the
// transfer it was held for; the snapshot of that gift, written before its next transfer,
// ends no hold: only the ack of the newer transfer does.
func TestGiftWhileHeldBeforeAnotherTransfer(t *testing.T) {
	log := &jobLog{}
	h := newMarketHarness(t, log.wire)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0))
	cc, c := h.trader("Caio", pos(1, 1), stack(coinID, 5, 0))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	offer := h.w.MarketOffers(s.CharacterID())[0]
	h.send(cb, acceptOffer(offer, 1))
	first := jobs0Snapshot(t, log.jobs[len(log.jobs)-1], b.CharacterID()) // not acked: Bruno is held

	h.sim.Command(gameFunc(func() {
		h.w.SetCapacityForTest(b, 0)
		h.w.GiveForTest(b, "test_sword", 1)
		h.w.SetCapacityForTest(b, 1_000_000)
	}))
	h.sim.Step()
	n := len(log.jobs)
	h.send(cb, acceptOffer(offer, 1))
	jobs := log.since(n)
	if len(jobs) != 2 || jobs[0].Transfer != nil || jobs[1].Transfer == nil {
		t.Fatalf("a transfer after the gift = %d jobs, want the snapshot then the transfer", len(jobs))
	}
	pre, second := jobs[0].Snapshot, jobs0Snapshot(t, jobs[1], b.CharacterID())

	cp := openPack(t, h.harness, cc)
	take := moveItem(onTile(pos(0, 1)), swordID, 1, inContainer(cp, 0), 1)
	if !hasKey(h.send(cc, take), "inventory.not_yours") {
		t.Fatal("the gift was not reserved to Bruno while his first transfer waits")
	}
	h.sim.Command(h.w.Saved(b.CharacterID(), first.Seq))
	h.sim.Step()
	if !h.w.InFlightForTest(b.CharacterID()) {
		t.Fatal("the ack of the first transfer ended the hold of the second")
	}
	if evs := h.send(cc, take); len(systemKeys(evs)) != 0 || h.w.CountItem(c, "test_sword") != 1 {
		t.Fatalf("pick up after the first transfer's ack: %v", systemKeys(evs))
	}
	h.sim.Command(h.w.Saved(b.CharacterID(), pre.Seq))
	h.sim.Step()
	if !h.w.InFlightForTest(b.CharacterID()) {
		t.Fatal("the ack of the snapshot of the gift ended the hold of the second transfer")
	}
	h.sim.Command(h.w.Saved(b.CharacterID(), second.Seq))
	h.sim.Step()
	if h.w.InFlightForTest(b.CharacterID()) {
		t.Fatal("Bruno is still held after his last transfer's ack")
	}
}

// What a character takes out of a house to the street stays reserved until the house
// write that took it out is confirmed. A snapshot of a throw before it, written first,
// is numbered at the throw: its ack frees nothing that left the house later.
func TestSaveBeforeHouseWriteFreesNothingThatLeftTheHouse(t *testing.T) {
	log := &jobLog{}
	h := newHouseHarness(t, log.wire)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(salveID, 5, 1), stack(coinID, 100, 2),
		stack(coinID, 100, 3))
	h.rent(cl)
	h.step(cl, N) // the door tile (3,4)
	pack := openPack(t, h.harness, cl)
	h.send(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(pos(3, 3)), 1)) // the sword in the house
	h.sim.Command(h.w.Saved(a.CharacterID(), lastJobSnapshot(t, log.jobs, a.CharacterID()).Seq))
	h.sim.Step()
	if h.w.InFlightForTest(a.CharacterID()) {
		t.Fatal("Ana is still held")
	}
	cc, c := h.tenant("Caio", 0, pos(5, 5), stack(coinID, 1, 0))

	if evs := h.send(cl, moveItem(inContainer(pack, 0), salveID, 0, onTile(pos(2, 5)), 5)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Ana throws the salves away: %v", systemKeys(evs))
	}
	n := len(log.jobs)
	if evs := h.send(cl, moveItem(onTile(pos(3, 3)), swordID, 1, onTile(pos(4, 5)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Ana takes the sword out: %v", systemKeys(evs))
	}
	jobs := log.since(n)
	if len(jobs) != 2 || jobs[0].Transfer != nil || jobs[1].Transfer == nil {
		t.Fatalf("taking it out wrote %d jobs, want the snapshot of the throw then the house write", len(jobs))
	}
	cp := openPack(t, h.harness, cc)
	take := moveItem(onTile(pos(4, 5)), swordID, 1, inContainer(cp, 0), 1)
	h.sim.Command(h.w.Saved(a.CharacterID(), jobs[0].Snapshot.Seq))
	h.sim.Step()
	if !hasKey(h.send(cc, take), "inventory.not_yours") {
		t.Fatal("the ack of the snapshot of the throw freed what left the house after it")
	}
	h.sim.Command(h.w.Saved(a.CharacterID(), jobs0Snapshot(t, jobs[1], a.CharacterID()).Seq))
	h.sim.Step()
	if evs := h.send(cc, take); len(systemKeys(evs)) != 0 || h.w.CountItem(c, "test_sword") != 1 {
		t.Fatalf("pick up after the house write's ack: %v", systemKeys(evs))
	}
}

// A gift the server drops on the street outside a command (here a test command, as a
// Join's tutorial reward does), then in the same tick an Input that takes something out
// of a house to the street: the snapshot of the gift is written before the house write,
// and its ack must not free what left the house (the house write is not confirmed yet).
func TestGiftOutsideACommandFreesNothingThatLeftTheHouse(t *testing.T) {
	log := &jobLog{}
	var logged bytes.Buffer
	h := newHouseHarness(t, log.wire, logTo(&logged))
	cl, a := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(salveID, 5, 1), stack(coinID, 100, 2),
		stack(coinID, 100, 3))
	h.rent(cl)
	pack := openPack(t, h.harness, cl)
	if evs := h.send(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(cottageDoor), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Ana puts her sword in the house: %v", systemKeys(evs))
	}
	h.sim.Command(h.w.Saved(a.CharacterID(), lastJobSnapshot(t, log.jobs, a.CharacterID()).Seq))
	h.sim.Step()
	if h.w.InFlightForTest(a.CharacterID()) {
		t.Fatal("Ana is still held")
	}
	cc, c := h.tenant("Caio", 0, pos(5, 5), stack(coinID, 1, 0))

	n := len(log.jobs)
	h.sim.Command(gameFunc(func() {
		h.w.SetCapacityForTest(a, 0)
		h.w.GiveForTest(a, "test_bag", 1) // falls at her feet, on the street
		h.w.SetCapacityForTest(a, 1_000_000)
	}))
	h.input(cl, moveItem(onTile(cottageDoor), swordID, 1, onTile(pos(4, 5)), 1))
	h.sim.Step()
	jobs := log.since(n)
	if len(jobs) != 2 || jobs[0].Transfer != nil || jobs[1].Transfer == nil {
		t.Fatalf("the gift and the move wrote %d jobs, want the snapshot of the gift then the house write", len(jobs))
	}
	pre, house := jobs[0].Snapshot, jobs0Snapshot(t, jobs[1], a.CharacterID())
	if pre.CharacterID != a.CharacterID() || pre.Seq >= house.Seq {
		t.Fatalf("snapshot of the gift %d, house write %d", pre.Seq, house.Seq)
	}
	if strings.Contains(logged.String(), giftAndHouse) {
		t.Fatal("a gift of another command was logged as given in the house's command")
	}
	cp := openPack(t, h.harness, cc)
	take := moveItem(onTile(pos(4, 5)), swordID, 1, inContainer(cp, 0), 1)
	h.sim.Command(h.w.Saved(a.CharacterID(), pre.Seq))
	h.sim.Step()
	if !hasKey(h.send(cc, take), "inventory.not_yours") {
		t.Fatal("the ack of the snapshot of the gift freed the sword before the house write's ack")
	}
	h.sim.Command(h.w.Saved(a.CharacterID(), house.Seq))
	h.sim.Step()
	if evs := h.send(cc, take); len(systemKeys(evs)) != 0 || h.w.CountItem(c, "test_sword") != 1 {
		t.Fatalf("pick up after the house write's ack: %v", systemKeys(evs))
	}
}

// The same gift outside a command, then in the same tick an Input that takes the sword
// out of the house into Ana's backpack; that house write is rejected. The snapshot of the
// gift, written before it, is her state before that Input: her row must not have the
// sword, which the house's row still has.
func TestGiftOutsideACommandKeepsNothingTakenOutOfTheHouse(t *testing.T) {
	db := newRowsDB(t)
	h := newHouseHarness(t, db.wire)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(salveID, 5, 1), stack(coinID, 100, 2),
		stack(coinID, 100, 3))
	h.rent(cl)
	pack := openPack(t, h.harness, cl)
	if evs := h.send(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(cottageDoor), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Ana puts her sword in the house: %v", systemKeys(evs))
	}
	if ids := db.sync(h.harness); len(ids) != 0 {
		t.Fatalf("tainted %v", ids)
	}

	db.reject.Store(a.CharacterID())
	n := len(db.jobs)
	h.sim.Command(gameFunc(func() {
		h.w.SetCapacityForTest(a, 0)
		h.w.GiveForTest(a, "test_bag", 1) // falls at her feet, on the street
		h.w.SetCapacityForTest(a, 1_000_000)
	}))
	h.input(cl, moveItem(onTile(cottageDoor), swordID, 1, inContainer(pack, 0), 1))
	h.sim.Step()
	if h.w.CountItem(a, "test_sword") != 1 {
		t.Fatal("Ana did not take her sword out of the house")
	}
	if jobs := db.jobs[n:]; len(jobs) != 2 || jobs[0].Transfer != nil || jobs[1].Transfer == nil {
		t.Fatalf("the gift and the move wrote %d jobs, want the snapshot of the gift then the house write", len(jobs))
	}
	if ids := db.sync(h.harness); !slices.Equal(ids, []int64{a.CharacterID()}) {
		t.Fatalf("tainted %v, want Ana", ids)
	}
	if db.count(a.CharacterID(), swordID) != 0 || db.rowSeq(a.CharacterID()) != db.preSeq(a.CharacterID()) {
		t.Fatal("Ana's row has the sword the rejected house write took out: the house's row has it too")
	}
}

// One command takes the sword out of the house to the street and gives Ana a gift that
// falls on the street (as a rune of the house floor used from the street that kills a
// quest monster does, hold.go): no snapshot of the gift is written apart. The house write
// carries her state after both, and the sword and the gift stay reserved to her until
// that write is confirmed, whatever older ack comes in between.
func TestGiftAndHouseInOneCommandWaitForTheHouseWrite(t *testing.T) {
	log := &jobLog{}
	var logged bytes.Buffer
	h := newHouseHarness(t, log.wire, logTo(&logged))
	cl, a := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(salveID, 5, 1), stack(coinID, 100, 2),
		stack(coinID, 100, 3))
	h.rent(cl)
	pack := openPack(t, h.harness, cl)
	if evs := h.send(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(cottageDoor), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Ana puts her sword in the house: %v", systemKeys(evs))
	}
	before := lastJobSnapshot(t, log.jobs, a.CharacterID())
	h.sim.Command(h.w.Saved(a.CharacterID(), before.Seq))
	h.sim.Step()
	cc, c := h.tenant("Caio", 0, pos(4, 6), stack(coinID, 1, 0)) // next to the street tiles of both

	n := len(log.jobs)
	h.sim.Command(h.w.InputAndGiftForTest(cl, moveItem(onTile(cottageDoor), swordID, 1, onTile(pos(4, 5)), 1), "test_bag", 1))
	h.sim.Step()
	jobs := log.since(n)
	if len(jobs) != 1 || jobs[0].Transfer == nil || len(jobs[0].Transfer.Houses) != 1 {
		t.Fatalf("the command wrote %d jobs, want the house write alone", len(jobs))
	}
	if len(h.w.GroundAt(pos(4, 5))) != 1 || len(h.w.GroundAt(cottageExit)) != 1 {
		t.Fatal("the sword is not on the street, or the gift did not fall")
	}
	if strings.Contains(logged.String(), giftAndHouse) {
		t.Fatalf("a gift reserved with the house write was logged: %q", logged.String())
	}
	house := jobs0Snapshot(t, jobs[0], a.CharacterID())
	cp := openPack(t, h.harness, cc)
	takeSword := moveItem(onTile(pos(4, 5)), swordID, 1, inContainer(cp, 0), 1)
	takeGift := moveItem(onTile(cottageExit), bagID, 1, inContainer(cp, 0), 1)
	h.sim.Command(h.w.Saved(a.CharacterID(), house.Seq-1)) // an older ack frees neither
	h.sim.Step()
	for name, take := range map[string]*pb.ClientMessage{"sword": takeSword, "gift": takeGift} {
		if !hasKey(h.send(cc, take), "inventory.not_yours") {
			t.Fatalf("the %s was not reserved to Ana until the house write's ack", name)
		}
	}
	h.sim.Command(h.w.Saved(a.CharacterID(), house.Seq))
	h.sim.Step()
	if evs := h.send(cc, takeSword); len(systemKeys(evs)) != 0 || h.w.CountItem(c, "test_sword") != 1 {
		t.Fatalf("pick the sword up after the house write's ack: %v", systemKeys(evs))
	}
	if evs := h.send(cc, takeGift); len(systemKeys(evs)) != 0 || h.w.CountItem(c, "test_bag") != 1 {
		t.Fatalf("pick the gift up after the house write's ack: %v", systemKeys(evs))
	}
}

// The same command with the sword taken into Ana's backpack, and that house write
// rejected: Ana goes back to her save before the command, without the sword (the house's
// row still has it), and the gift that fell on the street stays hers for good. A snapshot
// of the gift written before the house write would hold the sword: it would be in two
// rows.
func TestGiftAndHouseInOneCommandKeepNothingTwice(t *testing.T) {
	db := newRowsDB(t)
	h := newHouseHarness(t, db.wire)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(salveID, 5, 1), stack(coinID, 100, 2),
		stack(coinID, 100, 3))
	h.rent(cl)
	pack := openPack(t, h.harness, cl)
	if evs := h.send(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(cottageDoor), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Ana puts her sword in the house: %v", systemKeys(evs))
	}
	if ids := db.sync(h.harness); len(ids) != 0 {
		t.Fatalf("tainted %v", ids)
	}
	last := db.rowSeq(a.CharacterID())
	cc, _ := h.tenant("Caio", 0, pos(4, 6), stack(coinID, 1, 0)) // next to the exit

	db.reject.Store(a.CharacterID())
	n := len(db.jobs)
	h.sim.Command(h.w.InputAndGiftForTest(cl, moveItem(onTile(cottageDoor), swordID, 1, inContainer(pack, 0), 1), "test_bag", 1))
	h.sim.Step()
	if h.w.CountItem(a, "test_sword") != 1 || len(h.w.GroundAt(cottageExit)) != 1 {
		t.Fatal("Ana did not take her sword out of the house, or the gift did not fall")
	}
	if jobs := db.jobs[n:]; len(jobs) != 1 || jobs[0].Transfer == nil {
		t.Fatalf("the command wrote %d jobs, want the house write alone", len(jobs))
	}
	if ids := db.sync(h.harness); !slices.Equal(ids, []int64{a.CharacterID()}) {
		t.Fatalf("tainted %v, want Ana", ids)
	}
	if db.count(a.CharacterID(), swordID) != 0 || db.rowSeq(a.CharacterID()) != last {
		t.Fatal("Ana's row is not her save before the command: it has the sword the house's row has too")
	}
	cp := openPack(t, h.harness, cc)
	if !hasKey(h.send(cc, moveItem(onTile(cottageExit), bagID, 1, inContainer(cp, 0), 1)), "inventory.not_yours") {
		t.Fatal("the gift of the rejected command was not kept from Caio")
	}
}

// A give-away into something that cannot be reserved (a stranger's pile on the street) in
// a command that also changes a house (the gift falls on Ana's house floor): the snapshot
// of the give-away is written before the house write, as before, and the command is
// logged as an error (hold.go settleGave). No command does this today.
func TestGiftIntoAStrangersPileWithAHouseIsLogged(t *testing.T) {
	log := &jobLog{}
	var logged bytes.Buffer
	h := newHouseHarness(t, log.wire, logTo(&logged))
	cl, a := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(salveID, 5, 1), stack(coinID, 100, 2),
		stack(coinID, 100, 3))
	h.rent(cl)
	h.step(cl, N) // the door tile (3,4), a house tile, with the street (2..4, 5) within reach
	h.sim.Command(gameFunc(func() { h.w.DropForTest(h.w.ItemForTest("test_salve"), 1, pos(2, 5)) }))
	h.sim.Step()
	h.sim.Command(h.w.Saved(a.CharacterID(), lastJobSnapshot(t, log.jobs, a.CharacterID()).Seq))
	h.sim.Step()
	pack := openPack(t, h.harness, cl)

	n := len(log.jobs)
	h.sim.Command(h.w.InputAndGiftForTest(cl, moveItem(inContainer(pack, 1), salveID, 0, onTile(pos(2, 5)), 5), "test_bag", 1))
	h.sim.Step()
	if g := h.w.GroundAt(pos(2, 5)); len(g) != 1 || len(h.w.GroundAt(cottageDoor)) != 1 {
		t.Fatalf("the salves did not join the pile (%d piles), or the gift did not fall on the house floor", len(g))
	}
	jobs := log.since(n)
	if len(jobs) != 2 || jobs[0].Transfer != nil || jobs[1].Transfer == nil {
		t.Fatalf("the command wrote %d jobs, want the snapshot of the give-away then the house write", len(jobs))
	}
	if pre := jobs[0].Snapshot; pre.CharacterID != a.CharacterID() || countState(pre.Inventory, salveID) != 0 {
		t.Fatalf("the snapshot before the house write is not Ana's after the give-away: %+v", pre)
	}
	if !strings.Contains(logged.String(), giftAndHouse) {
		t.Fatalf("a give-away into a stranger's pile with a house change was not logged: %q", logged.String())
	}
}

// A command that gives something away and then makes a transfer of its own (no command
// does: a transfer checks first that everything fits) is logged as an error (hold.go
// transferSnapshot); a give-away of an earlier command of the same tick is not (the
// start of the next command settles it).
func TestTransferAfterAGiftOfItsCommandIsLogged(t *testing.T) {
	var logged bytes.Buffer
	h := newMarketHarness(t, logTo(&logged))
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	h.sim.Command(gameFunc(func() {
		h.w.SetCapacityForTest(s, 0)
		h.w.GiveForTest(s, "test_sword", 1) // falls at her feet
		h.w.SetCapacityForTest(s, 1_000_000)
	}))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	if len(h.w.MarketOffers(s.CharacterID())) != 1 || strings.Contains(logged.String(), giftThenTransfer) {
		t.Fatalf("%d offers after a gift of another command, logged %q", len(h.w.MarketOffers(s.CharacterID())), logged.String())
	}
	h.sim.Command(h.w.GiftAndInputForTest(cs, "test_sword", 1, createOffer(sell, salveID, 10, 4)))
	h.sim.Step()
	if len(h.w.MarketOffers(s.CharacterID())) != 2 || !strings.Contains(logged.String(), giftThenTransfer) {
		t.Fatalf("a transfer after a gift of its own command: %d offers, logged %q", len(h.w.MarketOffers(s.CharacterID())), logged.String())
	}
}

// giftThenTransfer is the error logged when a transfer follows a give-away of its own
// command (hold.go transferSnapshot).
const giftThenTransfer = "a transfer follows a give-away of its own command"

// giftAndHouse is the error logged when one command gives something away and changes a
// house (hold.go settleGave).
const giftAndHouse = "a command gave something away and changed a house"

// logTo is a harness option: the World logs to buf.
func logTo(buf *bytes.Buffer) option {
	return func(c *session.Config) { c.Logger = slog.New(slog.NewTextHandler(buf, nil)) }
}

// jobs0Snapshot is the snapshot of character id in the transfer job j.
func jobs0Snapshot(t *testing.T, j session.Job, id int64) session.Snapshot {
	t.Helper()
	if j.Transfer != nil {
		for _, s := range j.Transfer.Snapshots {
			if s.CharacterID == id {
				return s
			}
		}
	}
	t.Fatalf("job %+v carries no snapshot of %d in a transfer", j, id)
	return session.Snapshot{}
}

// lastJobSnapshot is the last snapshot of character id among jobs (plain or in a transfer).
func lastJobSnapshot(t *testing.T, jobs []session.Job, id int64) session.Snapshot {
	t.Helper()
	for i := len(jobs) - 1; i >= 0; i-- {
		if jobs[i].Transfer == nil {
			if jobs[i].Snapshot.CharacterID == id {
				return jobs[i].Snapshot
			}
			continue
		}
		for _, s := range jobs[i].Transfer.Snapshots {
			if s.CharacterID == id {
				return s
			}
		}
	}
	t.Fatalf("no job carries character %d", id)
	return session.Snapshot{}
}

func countState(list []session.ItemState, item uint16) int {
	n := 0
	for _, s := range list {
		if s.ItemID == item {
			n += s.Count
		}
		n += countState(s.Items, item)
	}
	return n
}

// A quest reward that does not fit falls on Ana's house floor in questRecheck, after
// checkHouses wrote the tick's house changes: that house write goes out in the same tick,
// with her snapshot, not with whatever command flushes next (whose player did not change
// the house).
func TestQuestRewardOnAHouseFloorIsWrittenInItsTick(t *testing.T) {
	log := &jobLog{}
	q, err := content.ParseQuest([]byte(`{id: fetch, name: quest.fetch.name,
		steps: [{id: salves, complete_when: {has_item: {item: test_salve, count: 6}}}],
		rewards: [{item: test_sword}]}`))
	if err != nil {
		t.Fatal(err)
	}
	h := newHouseHarness(t, log.wire, func(c *session.Config) {
		c.Quests = content.Quests{q.ID: q}
		c.AutosaveEvery = session.DefaultAutosaveEvery * 1000 // no autosave writes the house first
	})
	cl, a := h.tenant("Ana", 0, cottageExit, stack(salveID, 5, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	h.rent(cl)
	h.step(cl, N) // the door tile (3,4), a house tile

	n := len(log.jobs)
	h.sim.Command(gameFunc(func() {
		a.SetStorageForTest("quest.fetch", int64(quest.InProgress))
		h.w.GiveForTest(a, "test_salve", 1) // the sixth salve: the step is done at the end of the tick
		h.w.SetCapacityForTest(a, 0)        // and the reward does not fit
	}))
	h.sim.Step()
	if st, _ := h.w.QuestState(a, "fetch"); st != quest.Completed || len(h.w.GroundAt(cottageDoor)) != 1 {
		t.Fatalf("quest %v, %d items on the house floor", st, len(h.w.GroundAt(cottageDoor)))
	}
	jobs := log.since(n)
	if len(jobs) != 1 || jobs[0].Transfer == nil || len(jobs[0].Transfer.Houses) != 1 ||
		len(jobs[0].Transfer.Houses[0].Items) != 1 || jobs[0].Transfer.Houses[0].Items[0].Item.ItemID != swordID {
		t.Fatalf("the tick of the reward wrote %d jobs, want the house write with the sword", len(jobs))
	}
	if s := jobs0Snapshot(t, jobs[0], a.CharacterID()); s.Storage["quest.fetch"] != int64(quest.Completed) {
		t.Fatalf("Ana's snapshot in the house write has the quest at %d", s.Storage["quest.fetch"])
	}
}

// The snapshot kept for the next transfer is the state at the end of the command, or of
// the tick, of the give-away (hold.go settleGivers): a change of the player later in that
// tick, or in the next one before its command, is not in it.
func TestSaveBeforeTransferIsFromTheGiftsCommandOrTick(t *testing.T) {
	for _, way := range []string{"command", "tick"} {
		t.Run(way, func(t *testing.T) {
			log := &jobLog{}
			h := newMarketHarness(t, log.wire)
			cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
			cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0), stack(swordID, 1, 1))
			h.send(cs, createOffer(sell, salveID, 10, 4))
			offer := h.w.MarketOffers(s.CharacterID())[0]
			pack := openPack(t, h.harness, cb)
			more := gameFunc(func() { h.w.GiveForTest(b, "copper_coin", 7) })

			if way == "command" {
				// The throw, then 7 coins in the same tick.
				h.input(cb, moveItem(inContainer(pack, 1), swordID, 0, onTile(pos(0, 2)), 1))
				h.sim.Command(more)
				h.sim.Step()
			} else {
				// A gift that falls outside a command; 7 coins in the next tick, before the
				// purchase.
				h.sim.Command(gameFunc(func() {
					h.w.SetCapacityForTest(b, 0)
					h.w.GiveForTest(b, "test_bag", 1)
					h.w.SetCapacityForTest(b, 1_000_000)
				}))
				h.sim.Step()
				h.sim.Command(more)
			}
			n := len(log.jobs)
			h.send(cb, acceptOffer(offer, 1))
			jobs := log.since(n)
			if len(jobs) != 2 || jobs[0].Transfer != nil || jobs[1].Transfer == nil {
				t.Fatalf("a transfer after the give-away = %d jobs, want the snapshot then the transfer", len(jobs))
			}
			if pre := jobs[0].Snapshot; pre.CharacterID != b.CharacterID() || countState(pre.Inventory, coinID) != 100 {
				t.Fatalf("the snapshot before the transfer has %d coins, want the 100 from before the later 7",
					countState(pre.Inventory, coinID))
			}
		})
	}
}

// queueGate is a harness option: while full is set, the persistence queue takes no job
// (Config.Save and Config.Transfer refuse it, as a full Saver queue does). Put it before
// the option it wraps (rowsDB.wire): the harness applies its options last first.
func queueGate(full *atomic.Bool) option {
	return func(c *session.Config) {
		save, transfer := c.Save, c.Transfer
		c.Save = func(s session.Snapshot) bool { return !full.Load() && save(s) }
		c.Transfer = func(tr session.Transfer) bool { return !full.Load() && transfer(tr) }
	}
}

// With the queue full, the snapshot of a throw and the transfer behind it both wait in
// the loop (World.retry), in that order, and go out in that order once the queue takes
// jobs again.
func TestQueueFullKeepsTheSaveBeforeTheTransferFirst(t *testing.T) {
	var full atomic.Bool
	db := newRowsDB(t)
	h := newMarketHarness(t, queueGate(&full), db.wire)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0), stack(swordID, 1, 1))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	offer := h.w.MarketOffers(s.CharacterID())[0]
	db.saveNow(h.harness, cb)
	pack := openPack(t, h.harness, cb)
	if evs := h.send(cb, moveItem(inContainer(pack, 1), swordID, 0, onTile(pos(0, 2)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Bruno throws the sword away: %v", systemKeys(evs))
	}

	full.Store(true)
	n := len(db.jobs)
	h.send(cb, acceptOffer(offer, 1))
	if len(db.jobs) != n || h.w.PendingJobs() != 2 {
		t.Fatalf("with the queue full: %d jobs taken, %d waiting, want 0 and 2", len(db.jobs)-n, h.w.PendingJobs())
	}
	full.Store(false)
	h.sim.Step()
	jobs := db.jobs[n:]
	if len(jobs) != 2 || jobs[0].Transfer != nil || jobs[1].Transfer == nil {
		t.Fatalf("the retry submitted %d jobs, want the snapshot of the throw then the transfer", len(jobs))
	}
	pre, tr := jobs[0].Snapshot, jobs0Snapshot(t, jobs[1], b.CharacterID())
	if pre.CharacterID != b.CharacterID() || countState(pre.Inventory, swordID) != 0 || pre.Seq >= tr.Seq {
		t.Fatalf("snapshot before the transfer %+v, transfer's %d", pre, tr.Seq)
	}
}

// At shutdown (World.SaveAll, Saver.WritePending) with the snapshot of a throw pending:
// kept in memory, the final snapshot replaces it; waiting in the loop with the transfer
// behind it, it is written first, and a rejected transfer then abandons the rest (crash
// semantics) and leaves Bruno's row at that snapshot, without the sword.
func TestShutdownWithTheSaveBeforeATransferPending(t *testing.T) {
	type world struct {
		db    *rowsDB
		h     *marketHarness
		full  *atomic.Bool
		cb    *fakeClient
		b     *session.Player
		offer int64
	}
	setup := func(t *testing.T) world {
		var full atomic.Bool
		db := newRowsDB(t)
		h := newMarketHarness(t, queueGate(&full), db.wire)
		cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
		cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0), stack(swordID, 1, 1))
		h.send(cs, createOffer(sell, salveID, 10, 4))
		db.saveNow(h.harness, cb)
		pack := openPack(t, h.harness, cb)
		if evs := h.send(cb, moveItem(inContainer(pack, 1), swordID, 0, onTile(pos(0, 2)), 1)); len(systemKeys(evs)) != 0 {
			t.Fatalf("Bruno throws the sword away: %v", systemKeys(evs))
		}
		return world{db: db, h: h, full: &full, cb: cb, b: b, offer: h.w.MarketOffers(s.CharacterID())[0]}
	}

	t.Run("in memory", func(t *testing.T) {
		g := setup(t)
		n := len(g.db.jobs)
		if pending := g.h.w.SaveAll(); len(pending) != 0 {
			t.Fatalf("%d jobs pending with the queue free", len(pending))
		}
		for _, j := range g.db.jobs[n:] {
			if j.Transfer != nil || !j.Snapshot.Final {
				t.Fatalf("the shutdown wrote %+v besides the final snapshots", j)
			}
		}
		g.db.sync(g.h.harness)
		if g.db.count(g.b.CharacterID(), swordID) != 0 || g.db.count(g.b.CharacterID(), coinID) != 100 {
			t.Fatal("Bruno's row is not his final snapshot after the throw")
		}
	})

	t.Run("in the retry", func(t *testing.T) {
		g := setup(t)
		g.full.Store(true)
		g.h.send(g.cb, acceptOffer(g.offer, 1))
		pending := g.h.w.SaveAll()
		if len(pending) != 4 || pending[0].Transfer != nil || pending[0].Snapshot.CharacterID != g.b.CharacterID() ||
			pending[0].Snapshot.Final || pending[1].Transfer == nil || !pending[2].Snapshot.Final || !pending[3].Snapshot.Final {
			t.Fatalf("pending at shutdown: %d jobs, want the snapshot of the throw, the transfer and two final ones", len(pending))
		}
		g.db.reject.Store(g.b.CharacterID())
		if err := g.db.saver.Stop(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := g.db.saver.WritePending(context.Background(), pending); err == nil {
			t.Fatal("the rejected transfer at shutdown reported no error")
		}
		if g.db.rowSeq(g.b.CharacterID()) != pending[0].Snapshot.Seq || g.db.count(g.b.CharacterID(), swordID) != 0 {
			t.Fatal("Bruno's row is not the snapshot of the throw")
		}
	})
}
