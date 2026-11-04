package session_test

import (
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Boat travel (T3.5) on the data harness: the harbor master stands at (8, 10); the dock
// is (8, 11) and the routes arrive at (50, 50), far out of view of the dock.
var arrival = pos(50, 50)

func testRoutes() content.BoatRoutes {
	dock := content.Position{X: 8, Y: 11, Z: 7}
	far := content.Position{X: 50, Y: 50, Z: 7}
	return content.BoatRoutes{
		{ID: "cheap", Captain: "harbor_master", Text: "route.cheap", From: dock, To: far, Price: 30},
		{ID: "veteran", Captain: "harbor_master", Text: "route.veteran", From: dock, To: far, Price: 10,
			Requires: content.RouteRequires{Level: 5}},
		{ID: "chapter", Captain: "harbor_master", Text: "route.chapter", From: dock, To: far,
			Requires: content.RouteRequires{Quest: "ch1_shipwreck"}},
		{ID: "ticket", Captain: "harbor_master", Text: "route.ticket", From: dock, To: far, Price: 5,
			Requires: content.RouteRequires{Item: &content.RouteItem{Item: "rope", Consume: true}}},
	}
}

func travelHarness(t *testing.T, edit func(*session.Config)) *harness {
	t.Helper()
	return dataHarnessWith(t, func(c *session.Config) {
		c.BoatRoutes = testRoutes()
		if edit != nil {
			edit(c)
		}
	})
}

var nextTraveller int64 = 5000

// traveller joins a fresh level-1 guardian at pos with coins copper coins.
func (h *harness) traveller(name string, at world.Pos, coins int) (*fakeClient, *session.Player) {
	h.t.Helper()
	nextTraveller++
	c := session.Character{ID: nextTraveller, AccountID: nextTraveller, Name: name, Vocation: "guardian", Level: 1, Health: 150, Mana: 20}
	cl, p := h.joinFresh(c, at)
	h.sim.Command(gameFunc(func() {
		h.w.GiveForTest(p, "copper_coin", coins-int(h.w.Money(p)))
	}))
	h.sim.Step()
	cl.take()
	return cl, p
}

// travelWindow opens the harbor master's travel node.
func (h *harness) travelWindow(cl *fakeClient) *pb.DialogOpen {
	h.t.Helper()
	d := h.lastDialog(h.send(cl, talkMsg(h.npc("harbor_master").ID())))
	return h.lastDialog(h.pick(cl, d, "dialog.ask_travel"))
}

func TestBoatTravelOffersRoutesAndSails(t *testing.T) {
	h := travelHarness(t, nil)
	cl, p := h.traveller("Sailor", pos(8, 12), 100)
	bob, _ := h.traveller("Bob", pos(10, 12), 0)
	cy, _ := h.traveller("Cy", pos(52, 52), 0)
	h.sim.Step()
	bob.take()
	cy.take()

	d := h.travelWindow(cl)
	var texts []string
	for _, o := range d.Options {
		texts = append(texts, o.Text.Key)
	}
	// Generated route options come first, then the node's own (back).
	want := []string{"route.cheap", "route.veteran", "route.chapter", "route.ticket", "dialog.back"}
	if len(texts) != len(want) {
		t.Fatalf("options %v, want %v", texts, want)
	}
	for i := range want {
		if texts[i] != want[i] {
			t.Fatalf("options %v, want %v", texts, want)
		}
	}

	evs := h.pick(cl, d, "route.cheap")
	keys := messageKeys(evs)
	if !keys["travel.sailed"] || !keys["dialog.paid"] {
		t.Fatalf("no sail messages: %v", keys)
	}
	if p.Pos() != arrival || h.w.Money(p) != 70 {
		t.Fatalf("at %v with %d coins, want %v and 70", p.Pos(), h.w.Money(p), arrival)
	}
	if len(find(evs, (*pb.ServerMessage).GetDialogClose)) != 1 {
		t.Fatal("the dialog did not close")
	}
	for _, m := range find(evs, (*pb.ServerMessage).GetChatMessage) {
		if m.GetLocalized().GetKey() == "travel.sailed" {
			if ps := m.GetLocalized().GetParams(); len(ps) != 1 || ps[0].GetName() != "island" || ps[0].GetContentId() != "test" {
				t.Fatalf("sailed params %v", ps)
			}
		}
	}
	// AOI: the dock watcher sees the sailor go, the arrival watcher sees it come.
	if !hasDisappear(bob.take(), p.ID()) {
		t.Fatal("Bob did not see the sailor leave")
	}
	if !hasAppear(cy.take(), p.ID()) {
		t.Fatal("Cy did not see the sailor arrive")
	}
}

func hasDisappear(evs []*pb.ServerMessage, id uint32) bool {
	for _, d := range find(evs, (*pb.ServerMessage).GetCreatureDisappear) {
		if d.GetId() == id {
			return true
		}
	}
	return false
}

func hasAppear(evs []*pb.ServerMessage, id uint32) bool {
	for _, a := range find(evs, (*pb.ServerMessage).GetCreatureAppear) {
		if a.GetCreature().GetId() == id {
			return true
		}
	}
	return false
}

// refused picks route key and checks the refusal: p stays, keeps its money and the
// dialog stays open.
func (h *harness) refused(cl *fakeClient, p *session.Player, key, want string) {
	h.t.Helper()
	at, money := p.Pos(), h.w.Money(p)
	d := h.travelWindow(cl)
	evs := h.pick(cl, d, key)
	if !messageKeys(evs)[want] {
		h.t.Fatalf("%s: got %v, want %s", key, messageKeys(evs), want)
	}
	if p.Pos() != at || h.w.Money(p) != money {
		h.t.Fatalf("%s: moved to %v or paid (%d -> %d)", key, p.Pos(), money, h.w.Money(p))
	}
}

func TestBoatTravelRequirements(t *testing.T) {
	h := travelHarness(t, nil)
	cl, p := h.traveller("Rookie", pos(8, 12), 100)
	h.refused(cl, p, "route.veteran", "travel.need_level")
	h.refused(cl, p, "route.chapter", "travel.need_quest")
	h.refused(cl, p, "route.ticket", "travel.need_item")

	// With the ticket it sails and the ticket is used up.
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "rope", 1) }))
	h.sim.Step()
	h.pick(cl, h.travelWindow(cl), "route.ticket")
	if p.Pos() != arrival || h.w.CountItem(p, "rope") != 0 || h.w.Money(p) != 95 {
		t.Fatalf("ticket route: at %v, %d ropes, %d coins", p.Pos(), h.w.CountItem(p, "rope"), h.w.Money(p))
	}

	// The quest route opens once the quest is completed.
	cl2, q := h.traveller("Veteran", pos(8, 12), 0)
	h.sim.Command(gameFunc(func() { q.SetStorageForTest("quest.ch1_shipwreck", int64(quest.Completed)) }))
	h.sim.Step()
	h.pick(cl2, h.travelWindow(cl2), "route.chapter")
	if q.Pos().Z != 7 || chebyshevT(q.Pos(), arrival) > 1 {
		t.Fatalf("chapter route: at %v", q.Pos())
	}
}

func TestBoatTravelIsAtomic(t *testing.T) {
	h := travelHarness(t, nil)
	// Ticket but no money: nothing is taken.
	cl, p := h.traveller("Broke", pos(8, 12), 0)
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "rope", 1) }))
	h.sim.Step()
	h.refused(cl, p, "route.ticket", "dialog.no_money")
	if h.w.CountItem(p, "rope") != 1 {
		t.Fatal("the ticket was taken without sailing")
	}
	h.refused(cl, p, "route.cheap", "dialog.no_money")

}

func TestBoatTravelTooFarAndInCombat(t *testing.T) {
	h := travelHarness(t, nil)
	cl, p := h.traveller("Fighter", pos(8, 12), 100)

	// Walking out of talk range closes the window: an old option does nothing.
	d := h.travelWindow(cl)
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(20, 20)) }))
	h.sim.Step()
	cl.take()
	for _, o := range d.Options {
		if o.Text.Key == "route.cheap" {
			h.send(cl, chooseMsg(d.DialogId, o.OptionId))
		}
	}
	if p.Pos() != pos(20, 20) || h.w.Money(p) != 100 {
		t.Fatalf("sailed from afar: at %v, %d coins", p.Pos(), h.w.Money(p))
	}

	// Hurt a moment ago: refused until travel.combat_block_ms has passed.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(8, 12)) }))
	h.sim.Step()
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) { h.w.HurtForTest(ctx, p, 1) }))
	h.sim.Step()
	cl.take()
	h.refused(cl, p, "route.cheap", "travel.in_combat")
	h.sim.RunFor(13 * time.Second)
	cl.take()
	h.pick(cl, h.travelWindow(cl), "route.cheap")
	if p.Pos() != arrival {
		t.Fatalf("not sailing after the fight: at %v", p.Pos())
	}
}

func TestBoatTravelArrivalTaken(t *testing.T) {
	h := travelHarness(t, nil)
	_, _ = h.traveller("Squatter", arrival, 0)
	cl, p := h.traveller("Late", pos(8, 12), 100)
	h.pick(cl, h.travelWindow(cl), "route.cheap")
	if p.Pos() == arrival || chebyshevT(p.Pos(), arrival) != 1 {
		t.Fatalf("landed at %v, want next to %v", p.Pos(), arrival)
	}

	// No free tile within arrival_radius (0 here): refused, nothing charged.
	h2 := travelHarness(t, func(c *session.Config) { c.Balance.Travel.ArrivalRadius = 0 })
	_, _ = h2.traveller("Squatter", arrival, 0)
	cl2, q := h2.traveller("Late", pos(8, 12), 100)
	h2.refused(cl2, q, "route.cheap", "travel.no_room")
}

func TestBoatRoutesCheckedAtStart(t *testing.T) {
	bad := map[string]func(*content.BoatRoute){
		"dock far from captain":   func(r *content.BoatRoute) { r.From = content.Position{X: 30, Y: 30, Z: 7} },
		"arrival off the map":     func(r *content.BoatRoute) { r.To = content.Position{X: 500, Y: 500, Z: 7} },
		"captain sells no routes": func(r *content.BoatRoute) { r.Captain = "puerto_priest" },
		"unknown quest":           func(r *content.BoatRoute) { r.Requires.Quest = "nope" },
		"coins as the ticket": func(r *content.BoatRoute) {
			r.Requires.Item = &content.RouteItem{Item: "copper_coin", Count: 5, Consume: true}
		},
	}
	for name, edit := range bad {
		t.Run(name, func(t *testing.T) {
			routes := testRoutes()
			edit(routes[0])
			if _, err := session.New(dataConfig(t, routes)); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func chebyshevT(a, b world.Pos) int {
	return max(absT(int(a.X)-int(b.X)), absT(int(a.Y)-int(b.Y)))
}

func absT(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
