package session_test

import (
	"slices"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Player houses (T5.4). House "cottage": a walled room (2..4, 2..3) with its door at
// (3,4) and the exit below it; house "shed": an open 2x2 area at (8..9, 1..2), door
// (8,2), exit (7,2).
var houseMap = []string{
	"..........",
	".#####....",
	".#...#....",
	".#...#....",
	".##.##....",
	"..........",
	"..........",
}

var (
	cottageDoor = pos(3, 4)
	cottageExit = pos(3, 5)
	shedDoor    = pos(8, 2)
)

func testHouses() []world.House {
	return []world.House{
		{ID: "cottage", Name: "house.cottage.name", Rent: 150,
			Rects: []world.HouseRect{{X: 2, Y: 2, Z: 7, W: 3, H: 2}, {X: 3, Y: 4, Z: 7, W: 1, H: 1}},
			Doors: []world.Pos{cottageDoor}, Exit: cottageExit},
		{ID: "shed", Name: "house.shed.name", Rent: 50,
			Rects: []world.HouseRect{{X: 8, Y: 1, Z: 7, W: 2, H: 2}},
			Doors: []world.Pos{shedDoor}, Exit: pos(7, 2)},
	}
}

type houseHarness struct {
	*harness
	transfers []session.Transfer
	jobs      []string // "save:<char>" and "transfer:<id>" in submission order
	admin     []session.AdminJob
}

func newHouseHarness(t *testing.T, opts ...option) *houseHarness {
	t.Helper()
	hh := &houseHarness{}
	m := worldtest.WithHouses(t, worldtest.Map(t, 0, 0, 7, houseMap...), testHouses()...)
	hh.harness = newHarness(t, m, func(c *session.Config) {
		for _, o := range opts {
			defer o(c)
		}
		c.Items = marketItems(t)
		c.Balance.Market = content.Market{Enabled: true, FeePermille: 100, FeeMin: 2, FeeMax: 50, MaxOffers: 2,
			MaxAmount: 100, MaxPrice: 1000, DurationsHours: []int{1, 2}, ListSize: 5, HistorySize: 4,
			ReferenceDays: 3, MailboxShown: 10, ActionBurst: 50, ActionRefillMs: 50}
		c.Balance.Houses = content.Houses{Enabled: true, MinLevel: 5, PeriodDays: 7, MaxPeriods: 2, MaxGuests: 2,
			ItemsPerTile: 1, TransferMinutes: 5, ActionBurst: 100, ActionRefillMs: 50}
		c.Transfer = func(tr session.Transfer) bool {
			hh.transfers = append(hh.transfers, tr)
			hh.jobs = append(hh.jobs, "transfer")
			return true
		}
		save := c.Save
		c.Save = func(s session.Snapshot) bool {
			hh.jobs = append(hh.jobs, "save")
			return save(s)
		}
		c.Admin = func(j session.AdminJob) bool { hh.admin = append(hh.admin, j); return true }
	})
	return hh
}

// tenant joins a level-10 character of its own account (or of account acc) at p with a
// 4-slot backpack holding pack.
func (h *houseHarness) tenant(name string, acc int64, p world.Pos, pack ...session.ItemState) (*fakeClient, *session.Player) {
	h.t.Helper()
	nextChar++
	c := withPack(nextChar, p, pack...)
	c.Name, c.Level = name, 10
	if acc != 0 {
		c.AccountID = acc
	}
	cl, pl := h.joinChar(c)
	cl.take()
	return cl, pl
}

func houseCmd(a any) *pb.ClientMessage {
	c := &pb.HouseCommand{}
	switch a := a.(type) {
	case *pb.HouseRent:
		c.Action = &pb.HouseCommand_Rent{Rent: a}
	case *pb.HouseExtend:
		c.Action = &pb.HouseCommand_Extend{Extend: a}
	case *pb.HouseLeave:
		c.Action = &pb.HouseCommand_Leave{Leave: a}
	case *pb.HouseGuestAdd:
		c.Action = &pb.HouseCommand_GuestAdd{GuestAdd: a}
	case *pb.HouseGuestRemove:
		c.Action = &pb.HouseCommand_GuestRemove{GuestRemove: a}
	case *pb.HouseGuildAccess:
		c.Action = &pb.HouseCommand_GuildAccess{GuildAccess: a}
	case *pb.HouseTransferOffer:
		c.Action = &pb.HouseCommand_TransferOffer{TransferOffer: a}
	case *pb.HouseTransferAccept:
		c.Action = &pb.HouseCommand_TransferAccept{TransferAccept: a}
	}
	return &pb.ClientMessage{Message: &pb.ClientMessage_HouseCommand{HouseCommand: c}}
}

func lastHouse(evs []*pb.ServerMessage) *pb.HouseUpdate {
	us := find(evs, (*pb.ServerMessage).GetHouseUpdate)
	if len(us) == 0 {
		return nil
	}
	return us[len(us)-1]
}

// openDoor uses the door tile (its ground, stack index 0) and returns the window.
func (h *houseHarness) openDoor(cl *fakeClient, door world.Pos) *pb.HouseUpdate {
	h.t.Helper()
	evs := h.send(cl, useItem(onTile(door), worldtest.Grass, 0))
	u := lastHouse(evs)
	if !u.GetOpen() {
		h.t.Fatalf("door window = %v (%v)", u, systemKeys(evs))
	}
	return u
}

// rent opens the cottage door and rents it.
func (h *houseHarness) rent(cl *fakeClient) *pb.HouseUpdate {
	h.t.Helper()
	h.openDoor(cl, cottageDoor)
	u := lastHouse(h.send(cl, houseCmd(&pb.HouseRent{})))
	if !u.GetIsOwner() {
		h.t.Fatalf("after renting: %v", u)
	}
	return u
}

func (h *houseHarness) step(cl *fakeClient, d pb.Direction) []*pb.ServerMessage {
	h.input(cl, walk(d))
	h.sim.RunTicks(25)
	return cl.take()
}

func (h *houseHarness) houseOps(kind session.HouseOpKind) []session.HouseOp {
	var out []session.HouseOp
	for _, t := range h.transfers {
		for _, op := range t.Houses {
			if op.Kind == kind {
				out = append(out, op)
			}
		}
	}
	return out
}

func TestHouseRent(t *testing.T) {
	h := newHouseHarness(t)
	cl, p := h.tenant("Ana", 0, cottageExit, stack(coinID, 100, 0), stack(coinID, 100, 1))
	evs := h.send(cl, lookAt(onTile(cottageDoor), worldtest.Grass, 0))
	if !hasKey(evs, "house.look_free") {
		t.Fatalf("look at the door: %v", systemKeys(evs))
	}
	u := h.openDoor(cl, cottageDoor)
	if u.GetOwner() != "" || u.GetRent() != 150 || u.GetSize() != 7 || u.GetMaxItems() != 7 || u.GetAccess() {
		t.Fatalf("free house window = %v", u)
	}
	u = h.rent(cl)
	week := uint64(h.sim.Now().Add(7 * 24 * time.Hour).UnixMilli())
	if h.w.Money(p) != 50 || u.GetOwner() != "Ana" || u.GetPaidUntil() > week || u.GetPaidUntil() < week-1000 {
		t.Fatalf("after renting: money %d, window %v", h.w.Money(p), u)
	}
	adds := h.houseOps(session.HouseOwnerAdd)
	last := h.transfers[len(h.transfers)-1]
	if len(adds) != 1 || adds[0].Owner.CharacterID != p.CharacterID() || len(last.Snapshots) != 1 {
		t.Fatalf("rent transfer = %+v", last)
	}
	if h.w.HouseOwnerOf(p.CharacterID()) != "cottage" {
		t.Fatal("the owner index does not know the tenant")
	}
	// Extend: one more period (max 2 ahead), then refused.
	if evs := h.send(cl, houseCmd(&pb.HouseExtend{})); !hasKey(evs, "house.not_enough_money") {
		t.Fatalf("extend without money: %v", systemKeys(evs))
	}
	h.w.GiveForTest(p, "copper_coin", 100)
	h.sim.Step()
	if evs := h.send(cl, houseCmd(&pb.HouseExtend{})); !hasKey(evs, "house.extended") {
		t.Fatalf("extend: %v", systemKeys(evs))
	}
	h.w.GiveForTest(p, "copper_coin", 100)
	h.sim.Step()
	if evs := h.send(cl, houseCmd(&pb.HouseExtend{})); !hasKey(evs, "house.max_periods") {
		t.Fatalf("third period: %v", systemKeys(evs))
	}
	var rent int64
	for _, e := range h.economy {
		if e.Kind == session.EconHouse && e.Ref == "rent" {
			rent += e.Amount
		}
	}
	if rent != -300 {
		t.Fatalf("rent in the economy log = %d, want -300", rent)
	}
}

func TestHouseRentRules(t *testing.T) {
	h := newHouseHarness(t)
	cl, _ := h.tenant("Ana", 7000, cottageExit, stack(coinID, 100, 0), stack(coinID, 100, 1))
	h.rent(cl)
	// Another character of the same account: one house per account.
	c2, _ := h.tenant("Alba", 7000, pos(7, 1), stack(coinID, 100, 0))
	h.openDoor(c2, shedDoor)
	if evs := h.send(c2, houseCmd(&pb.HouseRent{})); !hasKey(evs, "house.has_house") {
		t.Fatalf("second house of an account: %v", systemKeys(evs))
	}
	// A rented house is taken; a low level cannot rent.
	c3, _ := h.tenant("Cid", 0, pos(2, 5), stack(coinID, 100, 0), stack(coinID, 100, 1))
	h.openDoor(c3, cottageDoor)
	if evs := h.send(c3, houseCmd(&pb.HouseRent{})); !hasKey(evs, "house.taken") {
		t.Fatalf("rent a taken house: %v", systemKeys(evs))
	}
	nextChar++
	low := withPack(nextChar, pos(7, 3), stack(coinID, 100, 0))
	low.Name = "Dino"
	c4, _ := h.joinChar(low)
	h.openDoor(c4, shedDoor)
	if evs := h.send(c4, houseCmd(&pb.HouseRent{})); !hasKey(evs, "house.level_required") {
		t.Fatalf("rent at level 1: %v", systemKeys(evs))
	}
	// Far from the door: no window.
	if evs := h.send(c3, useItem(onTile(shedDoor), worldtest.Grass, 0)); !hasKey(evs, "inventory.too_far") {
		t.Fatalf("door far away: %v", systemKeys(evs))
	}
}

func TestHouseDoorsGuestsAndExpel(t *testing.T) {
	h := newHouseHarness(t)
	cl, _ := h.tenant("Ana", 0, cottageExit, stack(coinID, 100, 0), stack(coinID, 100, 1))
	h.rent(cl)
	cb, b := h.tenant("Beto", 0, pos(2, 5))
	cc, c := h.tenant("Cid", 0, pos(3, 6))
	// The owner walks in; nobody else does.
	h.step(cl, N)
	h.step(cl, N)
	if evs := h.step(cb, NE); !hasKey(evs, "house.no_access") || b.Pos() != pos(2, 5) {
		t.Fatalf("Beto at the door: %v at %v", systemKeys(evs), b.Pos())
	}
	// Invited, Beto enters; Cid still does not.
	h.send(cl, houseCmd(&pb.HouseGuestAdd{Name: "Beto"}))
	if ops := h.houseOps(session.HouseAccess); len(ops) != 1 || !slices.Equal(ops[0].Guests, []string{"Beto"}) {
		t.Fatalf("access ops = %+v", ops)
	}
	h.step(cb, NE)
	if b.Pos() != cottageDoor {
		t.Fatalf("Beto at %v, want the door", b.Pos())
	}
	h.step(cb, NE)
	h.step(cc, N)
	if evs := h.step(cc, N); !hasKey(evs, "house.no_access") || c.Pos() != cottageExit {
		t.Fatalf("Cid at the door: %v at %v", systemKeys(evs), c.Pos())
	}
	// Bad names and a full list.
	if evs := h.send(cl, houseCmd(&pb.HouseGuestAdd{Name: "x"})); !hasKey(evs, "house.guest_bad_name") {
		t.Fatalf("bad guest name: %v", systemKeys(evs))
	}
	h.send(cl, houseCmd(&pb.HouseGuestAdd{Name: "Eva"}))
	if evs := h.send(cl, houseCmd(&pb.HouseGuestAdd{Name: "Fede"})); !hasKey(evs, "house.guests_full") {
		t.Fatalf("third guest: %v", systemKeys(evs))
	}
	// Removed while inside: out the door.
	evs := h.send(cl, houseCmd(&pb.HouseGuestRemove{Name: "beto"}))
	if !hasKey(evs, "house.guest_removed") {
		t.Fatalf("remove: %v", systemKeys(evs))
	}
	if !hasKey(cb.take(), "house.expelled") || h.w.Map().HouseAt(b.Pos()) != nil {
		t.Fatalf("Beto still inside at %v", b.Pos())
	}
	// Only the owner manages the house.
	h.openDoor(cb, cottageDoor)
	if evs := h.send(cb, houseCmd(&pb.HouseGuestAdd{Name: "Cid"})); !hasKey(evs, "house.not_owner") {
		t.Fatalf("guest manages: %v", systemKeys(evs))
	}
}

// Logout inside is safe: whoever lost the access while offline logs in at the door.
func TestHouseLoginOutside(t *testing.T) {
	h := newHouseHarness(t)
	cl, _ := h.tenant("Ana", 0, cottageExit, stack(coinID, 100, 0), stack(coinID, 100, 1))
	h.rent(cl)
	nextChar++
	c := withPack(nextChar, pos(3, 2))
	c.Name, c.Level = "Beto", 10
	cb, b := h.joinChar(c)
	if h.w.Map().HouseAt(b.Pos()) != nil {
		t.Fatalf("Beto logged in inside at %v", b.Pos())
	}
	cb.take()
	// The owner logs in where it logged out.
	nextChar++
	own := withPack(nextChar, pos(2, 2))
	own.Name, own.Level = "Gil", 10
	_, g := h.joinChar(own)
	if g.Pos() == pos(2, 2) {
		t.Fatal("a stranger kept its place inside")
	}
	f := h.w.Map().Flags(pos(3, 2))
	if f&world.FlagProtection == 0 || f&world.FlagHouse == 0 {
		t.Fatalf("house tile flags = %b, want protection (no combat, no PvP)", f)
	}
}

func TestHouseItemsWrittenWithTheMover(t *testing.T) {
	h := newHouseHarness(t)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(salveID, 5, 0), stack(swordID, 1, 1), stack(coinID, 100, 2),
		stack(coinID, 100, 3))
	h.rent(cl)
	h.step(cl, N)
	pack := openPack(t, h.harness, cl)
	before := len(h.transfers)
	evs := h.send(cl, moveItem(inContainer(pack, 0), salveID, 0, onTile(pos(3, 3)), 5))
	if len(h.transfers) != before+1 {
		t.Fatalf("transfers after the drop: %d, want one more (%v)", len(h.transfers)-before, systemKeys(evs))
	}
	tr := h.transfers[len(h.transfers)-1]
	if len(tr.Houses) != 1 || tr.Houses[0].Kind != session.HouseItems || len(tr.Houses[0].Items) != 1 ||
		tr.Houses[0].Items[0].Item.ItemID != salveID || len(tr.Snapshots) != 1 ||
		tr.Snapshots[0].CharacterID != a.CharacterID() {
		t.Fatalf("drop transfer = %+v", tr)
	}
	for _, it := range tr.Snapshots[0].Inventory[0].Items {
		if it.ItemID == salveID {
			t.Fatal("the snapshot of the drop still carries the salve")
		}
	}
	// A guest may bring items but not take any out.
	h.input(cl, walk(pb.Direction_DIRECTION_NORTH_WEST))
	h.sim.RunTicks(40)
	cb, b := h.tenant("Beto", 0, pos(2, 5), stack(swordID, 1, 0))
	h.send(cl, houseCmd(&pb.HouseGuestAdd{Name: "Beto"}))
	h.step(cb, NE)
	bp := openPack(t, h.harness, cb)
	if evs := h.send(cb, moveItem(onTile(pos(3, 3)), salveID, 1, inContainer(bp, 0), 5)); !hasKey(evs, "house.owner_only") {
		t.Fatalf("guest takes out: %v", systemKeys(evs))
	}
	if evs := h.send(cb, moveItem(inContainer(bp, 0), swordID, 0, onTile(pos(2, 3)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("guest brings a sword: %v", systemKeys(evs))
	}
	if h.w.CountItem(b, "test_sword") != 0 || len(h.w.GroundAt(pos(2, 3))) != 1 {
		t.Fatal("the guest's sword is not on the floor")
	}
	// The owner takes it out.
	if evs := h.send(cl, moveItem(onTile(pos(2, 3)), swordID, 1, inContainer(pack, 0), 1)); len(systemKeys(evs)) != 0 ||
		h.w.CountItem(a, "test_sword") != 2 {
		t.Fatalf("owner takes out: %v", systemKeys(evs))
	}
	// A stranger at the door cannot reach the floor of the house.
	cc, _ := h.tenant("Cid", 0, cottageExit, stack(salveID, 1, 0))
	cp := openPack(t, h.harness, cc)
	if evs := h.send(cc, moveItem(inContainer(cp, 0), salveID, 0, onTile(cottageDoor), 1)); !hasKey(evs, "house.no_access") {
		t.Fatalf("stranger throws in: %v", systemKeys(evs))
	}
	h.sim.Step() // the ledgers reconcile every tick
}

// The item limit: 1 instance per tile, 7 tiles.
func TestHouseItemLimit(t *testing.T) {
	h := newHouseHarness(t)
	cl, _ := h.tenant("Ana", 0, cottageExit, stack(salveID, 20, 0), stack(swordID, 1, 1), stack(coinID, 100, 2),
		stack(coinID, 100, 3))
	h.rent(cl)
	h.step(cl, N)
	h.step(cl, N) // (3,3): every tile of the house within reach
	pack := openPack(t, h.harness, cl)
	for _, tile := range []world.Pos{pos(2, 2), pos(3, 2), pos(4, 2), pos(2, 3), pos(3, 3), pos(4, 3), cottageDoor} {
		if evs := h.send(cl, moveItem(inContainer(pack, 0), salveID, 0, onTile(tile), 1)); len(systemKeys(evs)) != 0 {
			t.Fatalf("drop on %v: %v", tile, systemKeys(evs))
		}
	}
	if evs := h.send(cl, moveItem(inContainer(pack, 1), swordID, 0, onTile(pos(3, 2)), 1)); !hasKey(evs, "house.full") {
		t.Fatalf("over the limit: %v", systemKeys(evs))
	}
	// Merging into a stack that is there adds no instance.
	if evs := h.send(cl, moveItem(inContainer(pack, 0), salveID, 0, onTile(pos(3, 2)), 2)); len(systemKeys(evs)) != 0 {
		t.Fatalf("merge: %v", systemKeys(evs))
	}
}

func TestHouseRentFromMailboxAndRelease(t *testing.T) {
	var owner int64
	h := newHouseHarness(t)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	owner = a.CharacterID()
	h.rent(cl)
	h.step(cl, N)
	pack := openPack(t, h.harness, cl)
	h.send(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(pos(3, 3)), 1))
	// Gold in the mailbox pays the next period.
	h.w.MailGoldForTest(owner, 200)
	h.sim.Clock().Advance(7*24*time.Hour + time.Minute)
	h.sim.RunTicks(25)
	if !hasKey(cl.take(), "house.renewed") || h.w.MailGoldForTest(owner, 0) != 50 {
		t.Fatalf("not renewed (mailbox %d)", h.w.MailGoldForTest(owner, 0))
	}
	// Then there is not enough: the house is freed and the sword goes to the mailbox.
	h.sim.Clock().Advance(7 * 24 * time.Hour)
	h.sim.RunTicks(25)
	evs := cl.take()
	if !hasKey(evs, "house.lost_unpaid") || !hasKey(evs, "house.expelled") || h.w.HouseOwnerOf(owner) != "" {
		t.Fatalf("not released: %v", systemKeys(evs))
	}
	if len(h.w.GroundAt(pos(3, 3))) != 0 || h.w.MailItemsForTest(owner) != 1 {
		t.Fatalf("items: floor %d, mailbox %d", len(h.w.GroundAt(pos(3, 3))), h.w.MailItemsForTest(owner))
	}
	tr := h.transfers[len(h.transfers)-1]
	var mailAdds int
	for _, op := range tr.Market {
		if op.Kind == session.MarketMailAdd {
			mailAdds++
		}
	}
	if mailAdds != 1 || len(tr.Houses) != 2 || tr.Houses[0].Kind != session.HouseItems || len(tr.Houses[0].Items) != 0 ||
		tr.Houses[1].Kind != session.HouseOwnerRemove {
		t.Fatalf("release transfer = %+v", tr)
	}
}

func TestHouseTransfer(t *testing.T) {
	h := newHouseHarness(t)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	h.rent(cl)
	h.step(cl, N)
	pack := openPack(t, h.harness, cl)
	h.send(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(pos(3, 3)), 1))
	cb, b := h.tenant("Beto", 0, pos(4, 5), stack(coinID, 100, 0))
	if evs := h.send(cl, houseCmd(&pb.HouseTransferOffer{Name: "Nadie", Price: 10})); !hasKey(evs, "house.transfer_bad") {
		t.Fatalf("offer to nobody: %v", systemKeys(evs))
	}
	h.send(cl, houseCmd(&pb.HouseTransferOffer{Name: "Beto", Price: 80}))
	if !hasKey(cb.take(), "house.transfer_for_you") {
		t.Fatal("Beto was not told")
	}
	if u := h.openDoor(cb, cottageDoor); !u.GetTransferForMe() || u.GetTransferPrice() != 80 {
		t.Fatalf("Beto's window = %v", u)
	}
	evs := h.send(cb, houseCmd(&pb.HouseTransferAccept{}))
	if !hasKey(evs, "house.transfer_done") || h.w.HouseOwnerOf(b.CharacterID()) != "cottage" || h.w.HouseOwnerOf(a.CharacterID()) != "" {
		t.Fatalf("after accepting: %v", systemKeys(evs))
	}
	if h.w.Money(b) != 20 || h.w.MailGoldForTest(a.CharacterID(), 0) != 80 || h.w.MailItemsForTest(a.CharacterID()) != 1 {
		t.Fatalf("money %d, Ana's mailbox %d gold %d items", h.w.Money(b), h.w.MailGoldForTest(a.CharacterID(), 0),
			h.w.MailItemsForTest(a.CharacterID()))
	}
	// Ana is no longer welcome: out the door.
	ae := cl.take()
	if !hasKey(ae, "house.transferred_away") || !hasKey(ae, "house.expelled") {
		t.Fatalf("Ana got %v", systemKeys(ae))
	}
	if ch := h.houseOps(session.HouseOwnerChange); len(ch) != 1 || ch[0].CharacterID != a.CharacterID() ||
		ch[0].Owner.CharacterID != b.CharacterID() {
		t.Fatalf("owner change ops = %+v", ch)
	}
	h.sim.Step() // the ledgers reconcile every tick
}

func TestHouseLeave(t *testing.T) {
	h := newHouseHarness(t)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(coinID, 100, 0), stack(coinID, 100, 1))
	h.rent(cl)
	if evs := h.send(cl, houseCmd(&pb.HouseLeave{})); !hasKey(evs, "house.left") || h.w.HouseOwnerOf(a.CharacterID()) != "" {
		t.Fatalf("leave: %v", systemKeys(evs))
	}
	if rm := h.houseOps(session.HouseOwnerRemove); len(rm) != 1 {
		t.Fatalf("remove ops = %+v", rm)
	}
}

func TestHouseStaffCommands(t *testing.T) {
	h := newHouseHarness(t)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(coinID, 100, 0), stack(coinID, 100, 1))
	h.rent(cl)
	nextChar++
	gmc, _ := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Warden", Vocation: "guardian",
		Level: 1, Health: 145, HasPos: true, Pos: pos(0, 0), Role: session.RoleGM})
	cmd := func(line string) map[string]int {
		gmc.take()
		h.input(gmc, say(pb.ChatChannel_CHAT_CHANNEL_SAY, line))
		h.sim.Step()
		return systemKeys(gmc.take())
	}
	if k := cmd("/house cottage"); k["gm.house_info"] != 1 {
		t.Fatalf("/house: %v", k)
	}
	if k := cmd("/house nowhere"); k["gm.house_unknown"] != 1 {
		t.Fatalf("/house unknown: %v", k)
	}
	_, b := h.tenant("Beto", 0, pos(6, 6))
	if k := cmd("/housemove cottage Beto"); k["gm.house_moved"] != 1 || h.w.HouseOwnerOf(b.CharacterID()) != "cottage" {
		t.Fatalf("/housemove: %v", k)
	}
	if k := cmd("/houseevict cottage"); k["gm.house_evicted"] != 1 || h.w.HouseOwnerOf(b.CharacterID()) != "" {
		t.Fatalf("/houseevict: %v", k)
	}
	var actions []string
	for _, j := range h.admin {
		if j.Kind == session.AdminAudit {
			actions = append(actions, j.Audit.Action+":"+j.Audit.Result)
		}
	}
	want := []string{"house_info:ok", "house_info:invalid", "house_move:ok", "house_evict:ok"}
	if !slices.Equal(actions, want) {
		t.Fatalf("audit = %v, want %v", actions, want)
	}
	_ = a
}

func TestHousesLoaded(t *testing.T) {
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	h := newHouseHarness(t, func(c *session.Config) {
		c.Houses = &session.HouseData{
			Owners: []session.HouseOwner{{HouseID: "cottage", CharacterID: 9100, AccountID: 9100, Name: "Ana",
				PaidUntil: now.Add(100 * 24 * time.Hour), Since: now}},
			Guests: map[string][]string{"cottage": {"Beto"}},
			Items:  []session.HouseItem{{HouseID: "cottage", Pos: pos(2, 2), Item: session.ItemState{ItemID: swordID, Count: 1}}},
		}
	})
	if h.w.HouseOwnerOf(9100) != "cottage" || len(h.w.GroundAt(pos(2, 2))) != 1 {
		t.Fatal("the loaded house is not there")
	}
	states := h.w.HouseStates()
	if len(states) != 2 || states[0].Owner != "Ana" || states[1].Owner != "" || states[0].Size != 7 {
		t.Fatalf("states = %+v", states)
	}
	cb, b := h.tenant("Beto", 0, cottageExit)
	h.step(cb, N)
	if b.Pos() != cottageDoor {
		t.Fatalf("the loaded guest is at %v", b.Pos())
	}
}

// A drop and an autosave of the same tick: the house transfer is submitted first.
func TestHouseFlushBeforeLaterSaves(t *testing.T) {
	h := newHouseHarness(t)
	cl, _ := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	h.rent(cl)
	h.step(cl, N)
	pack := openPack(t, h.harness, cl)
	h.jobs = h.jobs[:0]
	h.input(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(pos(3, 3)), 1))
	h.sim.Command(h.w.ForceSaveForTest(cl))
	h.sim.Step()
	if !slices.Equal(h.jobs, []string{"transfer", "save"}) {
		t.Fatalf("jobs = %v, want the house transfer before the save", h.jobs)
	}
}

// After a transfer that was not stored (T5.3 falla segura) nothing moves in or out of a
// house and the rent sweep stops, until a restart.
func TestHouseReadOnly(t *testing.T) {
	h := newHouseHarness(t)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	h.rent(cl)
	h.step(cl, N)
	pack := openPack(t, h.harness, cl)
	h.sim.Command(h.w.Tainted(nil))
	h.sim.Step()
	if evs := h.send(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(pos(3, 3)), 1)); !hasKey(evs, "house.read_only") {
		t.Fatalf("drop in read-only: %v", systemKeys(evs))
	}
	if evs := h.send(cl, houseCmd(&pb.HouseLeave{})); !hasKey(evs, "house.read_only") {
		t.Fatalf("leave in read-only: %v", systemKeys(evs))
	}
	h.sim.Clock().Advance(30 * 24 * time.Hour)
	h.sim.RunTicks(25)
	if h.w.HouseOwnerOf(a.CharacterID()) != "cottage" {
		t.Fatal("the sweep released a house while read-only")
	}
}

// A guest drops an item and the owner leaves in the same tick: the guest's snapshot is
// written (with the drop) before the transfer that sends the items to the mailbox.
func TestHouseReleaseAfterAMoveInTheSameTick(t *testing.T) {
	h := newHouseHarness(t)
	cl, _ := h.tenant("Ana", 0, cottageExit, stack(coinID, 100, 0), stack(coinID, 100, 1))
	h.rent(cl)
	cb, b := h.tenant("Beto", 0, pos(2, 5), stack(swordID, 1, 0))
	h.send(cl, houseCmd(&pb.HouseGuestAdd{Name: "Beto"}))
	h.step(cl, E) // off the exit, still next to the door
	h.step(cb, NE)
	bp := openPack(t, h.harness, cb)
	before := len(h.transfers)
	h.input(cb, moveItem(inContainer(bp, 0), swordID, 0, onTile(pos(3, 3)), 1))
	h.input(cl, houseCmd(&pb.HouseLeave{}))
	h.sim.Step()
	got := h.transfers[before:]
	if len(got) != 2 || len(got[0].Snapshots) != 1 || got[0].Snapshots[0].CharacterID != b.CharacterID() ||
		len(got[0].Houses) != 1 || len(got[0].Houses[0].Items) != 1 {
		t.Fatalf("transfers = %+v, want the drop with Beto's snapshot first", got)
	}
	if len(got[1].Houses) != 2 || len(got[1].Market) != 1 || got[1].Market[0].Kind != session.MarketMailAdd {
		t.Fatalf("release = %+v", got[1])
	}
}

// Guests open containers but do not use up the owner's things, with UseItem or UseItemOn;
// strangers do not even reach them.
func TestHouseGuestUses(t *testing.T) {
	h := newHouseHarness(t)
	cl, _ := h.tenant("Ana", 0, cottageExit, stack(salveID, 5, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	h.rent(cl)
	h.step(cl, N)
	pack := openPack(t, h.harness, cl)
	h.send(cl, moveItem(inContainer(pack, 0), salveID, 0, onTile(pos(3, 3)), 5))
	h.send(cl, houseCmd(&pb.HouseGuestAdd{Name: "Beto"}))
	h.step(cl, pb.Direction_DIRECTION_NORTH_WEST)
	cb, _ := h.tenant("Beto", 0, pos(2, 5))
	h.step(cb, NE)
	if evs := h.send(cb, useItem(onTile(pos(3, 3)), salveID, 1)); !hasKey(evs, "house.owner_only") {
		t.Fatalf("guest eats: %v", systemKeys(evs))
	}
	on := &pb.ClientMessage{Message: &pb.ClientMessage_UseItemOn{UseItemOn: &pb.UseItemOn{
		From: onTile(pos(3, 3)), ItemId: salveID, StackIndex: 1,
		To: &pb.ActionTarget{Target: &pb.ActionTarget_Pos{Pos: &pb.Position{X: 3, Y: 4, Z: 7}}}}}}
	if evs := h.send(cb, on); !hasKey(evs, "house.owner_only") {
		t.Fatalf("guest uses on: %v", systemKeys(evs))
	}
	if n := h.w.GroundAt(pos(3, 3)); len(n) != 1 || n[0].Count() != 5 {
		t.Fatal("the guest used up the salves")
	}
}

// The owner of a house that left the map keeps its account's house in the database: it
// may not rent another (the database would refuse it and turn everything read-only).
func TestHouseOrphanOwner(t *testing.T) {
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	h := newHouseHarness(t, func(c *session.Config) {
		c.Houses = &session.HouseData{Owners: []session.HouseOwner{{HouseID: "gone", CharacterID: 9300,
			AccountID: 9300, Name: "Ana", PaidUntil: now, Since: now}}}
	})
	nextChar++
	c := withPack(nextChar, cottageExit, stack(coinID, 100, 0), stack(coinID, 100, 1))
	c.Name, c.Level, c.AccountID = "Alba", 10, 9300
	cl, _ := h.joinChar(c)
	h.openDoor(cl, cottageDoor)
	if evs := h.send(cl, houseCmd(&pb.HouseRent{})); !hasKey(evs, "house.has_house") {
		t.Fatalf("rent with an orphan house: %v", systemKeys(evs))
	}
}
