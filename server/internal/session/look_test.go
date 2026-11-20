package session_test

import (
	"os"
	"path/filepath"
	"testing"

	"go.yaml.in/yaml/v3"
	"google.golang.org/protobuf/proto"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Appearance (docs/02 "Apariencia", docs/05 "Apariencia y equipo visible", look.go).

// testLooks is data/looks.yaml.
func testLooks(t testing.TB) *content.Looks {
	t.Helper()
	l, err := content.LoadLooks(filepath.Join("..", "..", "..", "data"))
	if err != nil || l == nil {
		t.Fatalf("looks: %v", err)
	}
	return l
}

func withLooks(t testing.TB) option {
	looks := testLooks(t)
	return func(c *session.Config) { c.Looks = looks }
}

func setLook(l content.Look) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_SetLook{SetLook: &pb.SetLook{Look: &pb.BodyLook{
		Body: l.Body, Skin: l.Skin, Hair: l.Hair, HairColor: l.HairColor, Beard: l.Beard}}}}
}

func lookOf(m *pb.BodyLook) content.Look {
	return content.Look{Body: m.GetBody(), Skin: m.GetSkin(), Hair: m.GetHair(), HairColor: m.GetHairColor(), Beard: m.GetBeard()}
}

// seenCreature is the last Creature of id in evs (FullMapView, MapSlice or CreatureAppear).
func seenCreature(evs []*pb.ServerMessage, id uint32) *pb.Creature {
	var out *pb.Creature
	for _, e := range evs {
		for _, cr := range e.GetFullMapView().GetArea().GetCreatures() {
			if cr.GetId() == id {
				out = cr
			}
		}
		for _, cr := range e.GetMapSlice().GetArea().GetCreatures() {
			if cr.GetId() == id {
				out = cr
			}
		}
		if cr := e.GetCreatureAppear().GetCreature(); cr.GetId() == id {
			out = cr
		}
	}
	return out
}

var (
	lookMira = content.Look{Body: "slender", Skin: "olive", Hair: "ponytail", HairColor: "auburn", Beard: "none"}
	lookTom  = content.Look{Body: "sturdy", Skin: "deep", Hair: "crop", HairColor: "grey", Beard: "full"}
)

// At login a saved look a player may wear is kept; none, or one that is not a player's
// (a creatures-only skin), becomes the one picked from the id. It goes in the player's
// Creature, to itself and to everyone around, and in its snapshot.
func TestLookAtLogin(t *testing.T) {
	looks := testLooks(t)
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), withLooks(t))
	nextChar++
	mira := session.Character{ID: nextChar, AccountID: nextChar, Name: "Mira", Vocation: "guardian", Level: 1,
		Health: 145, Pos: pos(10, 10), HasPos: true, Look: lookMira}
	clA, pA := h.joinChar(mira)
	if pA.LookForTest() != lookMira {
		t.Fatalf("saved look %+v, want %+v", pA.LookForTest(), lookMira)
	}
	if got := seenCreature(clA.take(), pA.ID()); got == nil || lookOf(got.GetLook()) != lookMira {
		t.Fatalf("own creature %v", got)
	}

	clB, pB := h.join("Antigua", at(12, 10)) // created before looks: none saved
	if want := looks.DefaultLook(pB.CharacterID()); pB.LookForTest() != want {
		t.Fatalf("no look: got %+v, want the id's %+v", pB.LookForTest(), want)
	}
	if got := seenCreature(clB.take(), pA.ID()); got == nil || lookOf(got.GetLook()) != lookMira {
		t.Fatalf("the other sees %v", got)
	}
	if got := seenCreature(clA.take(), pB.ID()); got == nil || lookOf(got.GetLook()) != pB.LookForTest() {
		t.Fatalf("Mira sees %v", got)
	}

	nextChar++
	drowned := session.Character{ID: nextChar, AccountID: nextChar, Name: "Ahogada", Vocation: "guardian", Level: 1,
		Health: 145, Pos: pos(14, 10), HasPos: true,
		Look: content.Look{Body: "sturdy", Skin: "drowned", Hair: "short", HairColor: "black", Beard: "none"}}
	_, pC := h.joinChar(drowned)
	if want := looks.DefaultLook(drowned.ID); pC.LookForTest() != want {
		t.Fatalf("a creatures-only skin: got %+v, want the id's %+v", pC.LookForTest(), want)
	}

	// The look given at login is saved, so it stays even if data/looks.yaml changes.
	h.sim.Command(h.w.Leave(clB))
	h.sim.Step()
	if last := h.saves[len(h.saves)-1]; last.CharacterID != pB.CharacterID() || last.Look != pB.LookForTest() {
		t.Fatalf("saved %+v, want the look %+v", last, pB.LookForTest())
	}
}

// SetLook: free, any time; everyone who sees the player gets a CreatureLook. An invalid
// look is refused (appearance.invalid, the player gets its look back); too many changes in a row
// are dropped; without data/looks.yaml it is unavailable.
func TestSetLook(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 48, 32), withLooks(t))
	nextChar++
	clA, pA := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Mira", Vocation: "guardian",
		Level: 1, Health: 145, Pos: pos(10, 10), HasPos: true, Look: lookMira})
	clB, _ := h.join("Watcher", at(14, 10))
	clFar, _ := h.join("Far", at(40, 10)) // out of view (31x21)
	clA.take()
	clB.take()
	clFar.take()

	evs := h.send(clA, setLook(lookTom))
	if pA.LookForTest() != lookTom {
		t.Fatalf("look %+v, want %+v", pA.LookForTest(), lookTom)
	}
	own := find(evs, (*pb.ServerMessage).GetCreatureLook)
	if len(own) != 1 || own[0].GetId() != pA.ID() || lookOf(own[0].GetLook()) != lookTom {
		t.Fatalf("own CreatureLook %v", own)
	}
	seen := find(clB.take(), (*pb.ServerMessage).GetCreatureLook)
	if len(seen) != 1 || lookOf(seen[0].GetLook()) != lookTom {
		t.Fatalf("watcher CreatureLook %v", seen)
	}
	if far := find(clFar.take(), (*pb.ServerMessage).GetCreatureLook); len(far) != 0 {
		t.Fatalf("a player out of view got %v", far)
	}

	// The same look again: nothing to tell.
	if evs := h.send(clA, setLook(lookTom)); len(find(evs, (*pb.ServerMessage).GetCreatureLook)) != 0 {
		t.Fatalf("an unchanged look was sent: %v", kinds(evs))
	}

	for name, bad := range map[string]content.Look{
		"a creatures-only skin": {Body: "sturdy", Skin: "ashen", Hair: "short", HairColor: "black", Beard: "none"},
		"an unknown hair":       {Body: "sturdy", Skin: "fair", Hair: "spikes", HairColor: "black", Beard: "none"},
	} {
		evs := h.send(clA, setLook(bad))
		back := find(evs, (*pb.ServerMessage).GetCreatureLook)
		if !hasKey(evs, "appearance.invalid") || len(back) != 1 || lookOf(back[0].GetLook()) != lookTom {
			t.Errorf("%s: %v", name, kinds(evs))
		}
		if pA.LookForTest() != lookTom {
			t.Fatalf("%s changed the look to %+v", name, pA.LookForTest())
		}
	}
	if got := find(clB.take(), (*pb.ServerMessage).GetCreatureLook); len(got) != 0 {
		t.Fatalf("a refused look was broadcast: %v", got)
	}

	// Without data/looks.yaml.
	h2 := newHarness(t, worldtest.Open(t, 0, 0, 16, 16))
	cl, p := h2.join("Plain", at(5, 5))
	if seen := seenCreature(cl.take(), p.ID()); seen.GetLook() != nil {
		t.Fatalf("a look without data/looks.yaml: %v", seen.GetLook())
	}
	if evs := h2.send(cl, setLook(lookMira)); !hasKey(evs, "appearance.unavailable") {
		t.Fatalf("SetLook without looks: %v", kinds(evs))
	}

	// A saved look survives a server without data/looks.yaml: it is not sent, but the
	// next snapshot keeps it.
	nextChar++
	clM, pM := h2.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Mira", Vocation: "guardian",
		Level: 1, Health: 145, Pos: pos(7, 5), HasPos: true, Look: lookMira})
	if seen := seenCreature(clM.take(), pM.ID()); seen.GetLook() != nil {
		t.Fatalf("a look sent without data/looks.yaml: %v", seen.GetLook())
	}
	h2.sim.Command(h2.w.Leave(clM))
	h2.sim.Step()
	if last := h2.saves[len(h2.saves)-1]; last.CharacterID != pM.CharacterID() || last.Look != lookMira {
		t.Fatalf("saved %+v, want the look %+v kept", last, lookMira)
	}
}

// The SetLook anti-flood (data/looks.yaml limits): exactly a burst of changes in one
// tick, the rest dropped; one more passes after change_refill_ms, and only one.
func TestSetLookFlood(t *testing.T) {
	lim := testLooks(t).Limits
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), withLooks(t))
	nextChar++
	clA, _ := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Mira", Vocation: "guardian",
		Level: 1, Health: 145, Pos: pos(10, 10), HasPos: true, Look: lookMira})
	clB, _ := h.join("Watcher", at(14, 10))
	clA.take()
	clB.take()

	cur := lookMira
	next := func() content.Look { // always a change
		if cur == lookMira {
			cur = lookTom
		} else {
			cur = lookMira
		}
		return cur
	}
	broadcast := func() int { return len(find(clB.take(), (*pb.ServerMessage).GetCreatureLook)) }

	for range lim.ChangeBurst + 1 {
		h.input(clA, setLook(next()))
	}
	h.sim.Step()
	if got := broadcast(); got != lim.ChangeBurst {
		t.Fatalf("%d look changes broadcast in one tick, want the burst %d", got, lim.ChangeBurst)
	}
	next() // the dropped change did not apply: back to the look in effect

	refill := (lim.ChangeRefillMs + 49) / 50 // ticks of 50 ms
	for range refill - 2 {
		h.sim.Step()
	}
	h.input(clA, setLook(next())) // one tick short of change_refill_ms
	h.sim.Step()
	if got := broadcast(); got != 0 {
		t.Fatalf("%d changes passed before change_refill_ms", got)
	}
	next() // dropped
	h.input(clA, setLook(next()))
	h.input(clA, setLook(next()))
	h.sim.Step()
	if got := broadcast(); got != 1 {
		t.Fatalf("%d changes passed after change_refill_ms, want 1", got)
	}
}

// equipmentIDs is a VisibleEquipment as [head, torso, legs, feet, left, right].
func equipmentIDs(e *pb.VisibleEquipment) [6]uint32 {
	return [6]uint32{e.GetHead(), e.GetTorso(), e.GetLegs(), e.GetFeet(), e.GetLeftHand(), e.GetRightHand()}
}

// What a player shows it wears: the item ids of its visible slots in its Creature, and a
// CreatureLook to everyone who knows it whenever one changes (equip, take off); never the
// backpack or what is inside a container. A viewer that comes into range gets it in the
// CreatureAppear.
func TestVisibleEquipment(t *testing.T) {
	h := deathHarness(t, withLooks(t))
	clA, pA := h.geared("Mira", 20, 0) // sword (right), shield (left), tunic, backpack at (40, 40)
	want := [6]uint32{0, tunicID, 0, 0, shieldID, swordID}
	if got := seenCreature(clA.take(), pA.ID()); got == nil || equipmentIDs(got.GetEquipment()) != want {
		t.Fatalf("own creature equipment %v, want %v", got.GetEquipment(), want)
	}
	clB, _ := h.join("Watcher", at(43, 40))
	if got := seenCreature(clB.take(), pA.ID()); equipmentIDs(got.GetEquipment()) != want {
		t.Fatalf("watcher sees %v, want %v", got.GetEquipment(), want)
	}

	// The sword into the backpack: the right hand shows nothing.
	pack := openPack(t, h, clA)
	clA.take()
	h.send(clA, moveItem(inSlot(slotRight), swordID, 0, inContainer(pack, 0), 1))
	want[5] = 0
	looks := find(clB.take(), (*pb.ServerMessage).GetCreatureLook)
	if len(looks) != 1 || looks[0].GetId() != pA.ID() || equipmentIDs(looks[0].GetEquipment()) != want {
		t.Fatalf("after taking the sword off the watcher got %v, want %v", looks, want)
	}
	if looks[0].GetLook() == nil {
		t.Fatal("a CreatureLook without the body")
	}

	// indexOf is where an item is in the backpack.
	indexOf := func(id uint16) uint32 {
		for i, it := range pA.Equipped(slotBackpack).Items() {
			if it.Def().Numeric == id {
				return uint32(i)
			}
		}
		t.Fatalf("no item %d in the backpack", id)
		return 0
	}
	// Coins moved out of the backpack and back show nothing: no CreatureLook.
	h.send(clA, moveItem(inContainer(pack, indexOf(coinID)), coinID, 0, onTile(pos(41, 40)), 10))
	if n := len(pA.Equipped(slotBackpack).Items()); n != 2 { // the sword and 40 coins
		t.Fatalf("the backpack holds %d stacks after dropping 10 coins", n)
	}
	h.send(clA, moveItem(onTile(pos(41, 40)), coinID, 1, inContainer(pack, 0), 10))
	if n := pA.Equipped(slotBackpack).Items()[indexOf(coinID)].Count(); n != 50 {
		t.Fatalf("%d coins in the backpack after picking them up", n)
	}
	if got := find(clB.take(), (*pb.ServerMessage).GetCreatureLook); len(got) != 0 {
		t.Fatalf("moving coins was broadcast: %v", got)
	}

	// The sword back in the hand.
	h.send(clA, moveItem(inContainer(pack, indexOf(swordID)), swordID, 0, inSlot(slotRight), 1))
	want[5] = swordID
	if looks := find(clB.take(), (*pb.ServerMessage).GetCreatureLook); len(looks) != 1 || equipmentIDs(looks[0].GetEquipment()) != want {
		t.Fatalf("after equipping the sword the watcher got %v", looks)
	}

	// A viewer walking into range (the view is 31x21 plus a margin of one: 16 tiles to
	// either side) gets the look and the equipment in the CreatureAppear.
	clC, pC := h.join("Walker", at(57, 40))
	if got := seenCreature(clC.take(), pA.ID()); got != nil {
		t.Fatalf("seen from 17 tiles: %v", got)
	}
	h.input(clC, walk(pb.Direction_DIRECTION_WEST))
	h.sim.RunUntil(func() bool { return pC.Pos() == pos(56, 40) }, sim.MaxSeconds(5))
	got := seenCreature(clC.take(), pA.ID())
	if got == nil || equipmentIDs(got.GetEquipment()) != want || lookOf(got.GetLook()) != pA.LookForTest() {
		t.Fatalf("a viewer coming into range got %v", got)
	}
}

// What falls at a death is no longer shown: the watchers of the dead player get a
// CreatureLook with what it still wears.
func TestDeathDropShowsInTheLook(t *testing.T) {
	h := deathHarness(t, withLooks(t), func(c *session.Config) {
		c.Balance.Death.EquipmentDropPct, c.Balance.Death.BackpackDropPct = 100, 100
	})
	_, pA := h.geared("Mira", 20, 0)
	clB, _ := h.join("Watcher", at(43, 40))
	clB.take()
	h.kill(pA)
	looks := find(clB.take(), (*pb.ServerMessage).GetCreatureLook)
	if len(looks) != 1 || looks[0].GetId() != pA.ID() || looks[0].GetEquipment() != nil {
		t.Fatalf("the watcher of the death got %v, want a CreatureLook showing nothing", looks)
	}
}

// NPCs and humanoid monsters send the look and the pieces of their data, the same
// messages for every Creature of a definition; a beast sends none.
func TestCreatureLooksFromData(t *testing.T) {
	looker := wolfDef()
	looker.ID = "test_looter"
	looker.Behavior.Aggressive = false
	looker.Look = &content.CreatureLook{
		Look: content.Look{Body: "sturdy", Skin: "ashen", Hair: "short", HairColor: "black", Beard: "full"},
		Worn: map[string]content.WornPiece{"head": {Shape: "cap", Tint: "wine"}, "weapon": {Shape: "sword", Tint: "rust"}},
	}
	h := lookedMonsters(t, []*content.Monster{wolfDef(), looker},
		spawnAt("test_looter", 20, 20, 0, 600), spawnAt("wolf", 24, 20, 0, 600))
	cl, _ := h.join("Watcher", at(22, 22))
	evs := cl.take()
	var man, beast *pb.Creature
	for _, m := range h.w.Monsters() {
		switch m.Kind() {
		case "test_looter":
			man = seenCreature(evs, m.ID())
		case "wolf":
			beast = seenCreature(evs, m.ID())
		}
	}
	if man == nil || beast == nil {
		t.Fatalf("monsters not seen: %v %v", man, beast)
	}
	if lookOf(man.GetLook()) != looker.Look.Look {
		t.Fatalf("looter look %v", man.GetLook())
	}
	wantWorn := &pb.Worn{Head: &pb.WornPiece{Shape: "cap", Tint: "wine"}, Weapon: &pb.WornPiece{Shape: "sword", Tint: "rust"}}
	if !proto.Equal(man.GetWorn(), wantWorn) || man.GetEquipment() != nil {
		t.Fatalf("looter worn %v, equipment %v", man.GetWorn(), man.GetEquipment())
	}
	if beast.GetLook() != nil || beast.GetWorn() != nil {
		t.Fatalf("a beast with a look: %v", beast)
	}

	// A look that is not drawn does not start (make validate refuses it too).
	bad := *looker
	bad.Look = &content.CreatureLook{Look: looker.Look.Look, Worn: map[string]content.WornPiece{"weapon": {Shape: "tunic", Tint: "rust"}}}
	bad.ID = "bad_looter"
	cfg := session.Config{Map: worldtest.Open(t, 0, 0, 16, 16), Balance: testBalance(), Vocations: testVocations,
		Monsters: content.Monsters{bad.ID: &bad}, Items: testItems(), Looks: testLooks(t),
		Save: func(session.Snapshot) bool { return true }}
	if _, err := session.New(cfg); err == nil {
		t.Fatal("a monster wearing a tunic in its hand started")
	}
}

// lookedMonsters is monsterHarness with data/looks.yaml.
func lookedMonsters(t *testing.T, defs []*content.Monster, spawns ...world.Spawn) *harness {
	t.Helper()
	m := worldtest.Open(t, 0, 0, 64, 64)
	m.Islands()[0].Spawns = spawns
	ms := content.Monsters{}
	for _, d := range defs {
		ms[d.ID] = d
	}
	return newHarness(t, m, func(c *session.Config) {
		c.Monsters = ms
		c.Items = testItems()
	}, withLooks(t))
}

// The real NPCs: their Creature carries the look of data/npcs.
func TestNPCLooksFromData(t *testing.T) {
	h := dataHarness(t)
	cl, _ := h.join("Visitor", at(10, 12))
	evs := cl.take()
	n := h.npc("harbor_master")
	seen := seenCreature(evs, n.ID())
	if seen == nil || seen.GetLook() == nil || seen.GetLook().GetBody() == "" {
		t.Fatalf("harbor master seen as %v", seen)
	}
	if seen.GetWorn() == nil {
		t.Fatalf("harbor master wears nothing: %v", seen)
	}
}

// A wielded piece that breaks at the forge is no longer shown: the watchers get a
// CreatureLook with an empty hand.
func TestForgeBreakShowsInTheLook(t *testing.T) {
	h := refineHarness(t, withLooks(t), func(c *session.Config) { c.Balance.Forge.Levels[5].Chance = 0 })
	cl, p := forger(h, 5) // a +5 sword: the attempt at +6 fails and breaks it
	clB, _ := h.join("Watcher", at(3, 0))
	if seen := seenCreature(clB.take(), p.ID()); seen.GetEquipment().GetRightHand() != swordID {
		t.Fatalf("the watcher does not see the sword: %v", seen.GetEquipment())
	}
	evs := h.refineSword(cl, 5, false)
	if r := refineResult(t, evs); r.GetOutcome() != pb.RefineOutcome_REFINE_OUTCOME_BROKEN {
		t.Fatalf("outcome %v", r.GetOutcome())
	}
	looks := find(clB.take(), (*pb.ServerMessage).GetCreatureLook)
	if len(looks) != 1 || looks[0].GetId() != p.ID() || looks[0].GetEquipment().GetRightHand() != 0 {
		t.Fatalf("the watcher got %v after the sword broke", looks)
	}
}

// The answers of SetLook have their text in every language (i18n/).
func TestLookMessagesTranslated(t *testing.T) {
	for _, lang := range []string{"es", "en"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "i18n", lang, "client.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		texts := map[string]string{}
		if err := yaml.Unmarshal(raw, &texts); err != nil {
			t.Fatal(err)
		}
		for _, k := range []string{"appearance.invalid", "appearance.unavailable"} {
			if texts[k] == "" {
				t.Errorf("%s: %s has no text", lang, k)
			}
		}
	}
}
