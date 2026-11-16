package session_test

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
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

// wire is a harness option: the World's jobs go to the Saver (and to db.jobs).
func (db *rowsDB) wire(c *session.Config) {
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
// acks to the loop (as app does) and returns the characters it tainted meanwhile (not
// yet told to the loop).
func (db *rowsDB) sync(h *harness) []int64 {
	db.t.Helper()
	seq := uint64(len(db.jobs) + 1)
	if !db.saver.Submit(session.Snapshot{CharacterID: syncChar, Seq: seq}) {
		db.t.Fatal("the Saver refused the sync snapshot")
	}
	deadline := time.Now().Add(10 * time.Second) //nolint:forbidigo // bounds a wait on the Saver's goroutine
	for {
		db.mu.Lock()
		acks := db.acks
		db.acks = nil
		db.mu.Unlock()
		done := false
		for _, a := range acks {
			if a.CharacterID == syncChar {
				done = done || a.Seq == seq
				continue
			}
			h.sim.Command(h.w.Saved(a.CharacterID, a.Seq))
		}
		h.sim.Step()
		if done {
			break
		}
		if time.Now().After(deadline) { //nolint:forbidigo // bounds a wait on the Saver's goroutine
			db.t.Fatal("the Saver did not get to the sync snapshot")
		}
		time.Sleep(time.Millisecond) //nolint:forbidigo // polls the Saver's goroutine
	}
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
	if db.count(a.CharacterID(), salveID) != 30 || db.count(a.CharacterID(), coinID) != 50 {
		t.Fatal("Ana's row is not her state right before the rejected offer")
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
	if db.count(a.CharacterID(), uint16(rope)) != 1 || db.count(a.CharacterID(), uint16(itemNum(t, h, nil, "bosun_logbook"))) != 0 {
		t.Fatal("Ana's row is not her state right before the rejected trade")
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
	if db.count(a.CharacterID(), uint16(rope)) != 1 {
		t.Fatal("Ana's row lost the rope of the rejected trade")
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
	if db.count(a.CharacterID(), swordID) != 1 {
		t.Fatal("Ana's row lost the sword of the rejected house write")
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
	if db.count(b.CharacterID(), salveID) != 0 || db.count(b.CharacterID(), coinID) != 10 {
		t.Fatal("Beto's row is not his state right before the skipped trade")
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

// A relogin (as the takeover of a link-dead) with the snapshot of a throw pending: the old
// login's final snapshot comes after the throw and replaces it, and the new login's first
// transfer writes nothing before it.
func TestReloginReplacesTheSaveBeforeTransfer(t *testing.T) {
	log := &jobLog{}
	h := newMarketHarness(t, log.wire)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0), stack(swordID, 1, 1))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	offer := h.w.MarketOffers(s.CharacterID())[0]

	pack := openPack(t, h.harness, cb)
	if evs := h.send(cb, moveItem(inContainer(pack, 1), swordID, 0, onTile(pos(0, 2)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Bruno throws the sword away: %v", systemKeys(evs))
	}
	n := len(log.jobs)
	again := withPack(b.CharacterID(), pos(0, 1))
	again.Name = "Bruno"
	cb2, _ := h.joinChar(again)
	jobs := log.since(n)
	if len(jobs) != 1 || jobs[0].Transfer != nil || !jobs[0].Snapshot.Final ||
		countState(jobs[0].Snapshot.Inventory, swordID) != 0 || countState(jobs[0].Snapshot.Inventory, coinID) != 100 {
		t.Fatalf("the relogin wrote %d jobs, want the old login's final snapshot after the throw", len(jobs))
	}
	if u := lastMarket(h.send(cb2, useBoard())); !u.GetOpen() {
		t.Fatal("the market did not open")
	}
	n = len(log.jobs)
	h.send(cb2, acceptOffer(offer, 1))
	if jobs := log.since(n); len(jobs) != 1 || jobs[0].Transfer == nil {
		t.Fatalf("the new login's first transfer wrote %d jobs", len(jobs))
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
