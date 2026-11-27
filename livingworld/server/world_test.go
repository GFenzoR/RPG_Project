package livingworld

import (
	"math/rand/v2"
	"strings"
	"testing"
)

// fakeHost is a small map: every tile in 0..19 is walkable unless walls says otherwise.
type fakeHost struct {
	walls     map[Pos]bool
	creatures map[Pos]bool
	items     map[Pos]bool
	// watched are tiles some player has in its view.
	watched map[Pos]bool
	// stuck are tiles whose loose items cannot move (no room nearby, remains).
	stuck   map[Pos]bool
	cleared []Pos
	block   map[Pos][2]bool
	changed []Pos
	events  []Event
	loot    [][]Drop
}

func newHost() *fakeHost {
	return &fakeHost{walls: map[Pos]bool{}, creatures: map[Pos]bool{}, items: map[Pos]bool{}, watched: map[Pos]bool{}, stuck: map[Pos]bool{}, block: map[Pos][2]bool{}}
}

func (h *fakeHost) Free(p Pos) bool {
	return p.X < 20 && p.Y < 20 && !h.walls[p] && !h.block[p][0] && !h.creatures[p] && !h.items[p]
}
func (h *fakeHost) ClearItems(p Pos) bool {
	if h.items[p] && !h.stuck[p] {
		delete(h.items, p)
		h.cleared = append(h.cleared, p)
	}
	return !h.items[p]
}
func (h *fakeHost) Occupied(p Pos) bool              { return h.creatures[p] }
func (h *fakeHost) Watched(p Pos) bool               { return h.watched[p] }
func (h *fakeHost) SetBlock(p Pos, move, sight bool) { h.block[p] = [2]bool{move, sight} }
func (h *fakeHost) TileChanged(p Pos)                { h.changed = append(h.changed, p) }
func (h *fakeHost) Event(e Event)                    { h.events = append(h.events, e) }
func (h *fakeHost) DropLoot(_ Pos, _ int64, _ string, d []Drop) {
	h.loot = append(h.loot, d)
}

func (h *fakeHost) kinds() []EventKind {
	var out []EventKind
	for _, e := range h.events {
		out = append(out, e.Kind)
	}
	return out
}

var testItems = map[string]ItemInfo{
	"crate":        {Num: 10, Kind: "decoration", BlocksMove: true, BlocksSight: true},
	"crate_debris": {Num: 11, Kind: "decoration"},
	"rock":         {Num: 12, Kind: "decoration", BlocksMove: true},
	"boulder":      {Num: 13, Kind: "decoration", BlocksMove: true},
	"gate":         {Num: 14, Kind: "decoration", BlocksMove: true},
	"gate_open":    {Num: 15, Kind: "decoration"},
	"plate":        {Num: 16, Kind: "decoration"},
	"coin":         {Num: 17, Kind: "currency"},
	"stone_wall":   {Num: 18, Kind: "wall", BlocksMove: true},
	"door":         {Num: 19, Kind: "door", BlocksMove: true, Door: true},
	"vines":        {Num: 20, Kind: "decoration", BlocksMove: true},
}

func lookup(id string) (ItemInfo, bool) {
	i, ok := testItems[id]
	return i, ok
}

const testYAML = `
- item: crate
  breakable:
    hp: 10
    by: [melee, any_attack, fire]
    becomes: crate_debris
    debris_seconds: 2
    respawn_seconds: 5
    effect: wood
    loot:
      - { item: coin, chance: 1, count: [3, 3] }
- item: rock
  breakable: { hp: 4, by: ["tool:pick"], becomes: none, respawn_seconds: 3, effect: stone }
- item: vines
  breakable: { hp: 1, by: [melee, "tool:axe"], becomes: none, respawn_seconds: 3, effect: plant }
- item: boulder
  pushable: { reset_seconds: 10 }
- item: gate
  gate: { open: gate_open }
- item: plate
  plate: { radius: 4 }
`

const tps = 20

func setup(t *testing.T) (*World, *fakeHost) {
	t.Helper()
	defs, err := Parse([]byte(testYAML))
	if err != nil {
		t.Fatal(err)
	}
	cat, err := Resolve(defs, lookup, nil, tps)
	if err != nil {
		t.Fatal(err)
	}
	h := newHost()
	return New(cat, h), h
}

func at(x, y int) Pos { return Pos{X: uint16(x), Y: uint16(y), Z: 7} }

func melee(dmg int) Hit { return Hit{Methods: []string{ByMelee, ByAnyAttack}, Damage: dmg, Actor: 1} }

func TestPlaceTakesObjectsAndKeepsPlates(t *testing.T) {
	w, h := setup(t)
	if !w.Place(at(1, 1), 10) || w.Place(at(2, 2), 16) || w.Place(at(3, 3), 17) {
		t.Fatal("Place: crate is an object, plate and coin are not")
	}
	if w.ItemAt(at(1, 1)) != 10 || !h.block[at(1, 1)][0] || !h.block[at(1, 1)][1] {
		t.Fatalf("crate shows %d, blocks %v", w.ItemAt(at(1, 1)), h.block[at(1, 1)])
	}
	if w.Place(at(1, 1), 12) {
		t.Fatal("a second object on a tile must stay a map item")
	}
}

func TestBreakWithTheRightWayOnly(t *testing.T) {
	w, h := setup(t)
	rnd := rand.New(rand.NewPCG(1, 2))
	w.Place(at(1, 1), 12) // rock: pick only
	if r := w.OnAttackObject(at(1, 1), melee(100), rnd); r != HitWrongWay {
		t.Fatalf("sword on rock: %v, want HitWrongWay", r)
	}
	if w.Breaks(at(1, 1), []string{ByMelee}) || !w.Breaks(at(1, 1), []string{ByPick}) {
		t.Fatal("Breaks disagrees with by")
	}
	pick := Hit{Methods: []string{ByPick}, Damage: 2}
	if r := w.OnAttackObject(at(1, 1), pick, rnd); r != HitDamaged {
		t.Fatalf("first pick: %v", r)
	}
	if r := w.OnAttackObject(at(1, 1), pick, rnd); r != HitBroken {
		t.Fatalf("second pick: %v", r)
	}
	if w.ItemAt(at(1, 1)) != 0 || h.block[at(1, 1)][0] {
		t.Fatal("a rock without debris leaves nothing and blocks nothing")
	}
	if r := w.OnAttackObject(at(1, 1), pick, rnd); r != HitAlreadyBroken {
		t.Fatalf("pick on nothing: %v", r)
	}
	if r := w.OnAttackObject(at(5, 5), pick, rnd); r != HitNoObject {
		t.Fatalf("pick on an empty tile: %v", r)
	}
	if got := h.kinds(); len(got) != 2 || got[0] != EventHit || got[1] != EventBreak {
		t.Fatalf("events %v", got)
	}
	if h.events[0].HPPermille != 500 {
		t.Fatalf("hit at half hp: %d", h.events[0].HPPermille)
	}
}

func TestDebrisFadesThenRespawnWaitsForTheOccupant(t *testing.T) {
	w, h := setup(t)
	rnd := rand.New(rand.NewPCG(1, 2))
	p := at(1, 1)
	w.Place(p, 10)
	w.OnTick(100)
	if w.OnAttackObject(p, melee(10), rnd) != HitBroken {
		t.Fatal("crate did not break")
	}
	if w.ItemAt(p) != 11 || h.block[p][0] {
		t.Fatal("debris must show and be walkable")
	}
	w.OnTick(100 + 2*tps - 1)
	if w.ItemAt(p) != 11 {
		t.Fatal("debris faded early")
	}
	w.OnTick(100 + 2*tps)
	if w.ItemAt(p) != 0 {
		t.Fatal("debris did not fade")
	}
	h.creatures[p] = true // someone stands where it would come back
	w.OnTick(100 + 5*tps)
	if w.ItemAt(p) != 0 || h.block[p][0] {
		t.Fatal("respawned on a creature")
	}
	w.OnTick(100 + 5*tps + 10)
	delete(h.creatures, p)
	w.OnTick(100 + 5*tps + 19)
	if w.ItemAt(p) != 0 {
		t.Fatal("the retry waits a second")
	}
	w.OnTick(100 + 5*tps + tps)
	if w.ItemAt(p) != 10 || !h.block[p][0] {
		t.Fatal("crate did not respawn on a free tile")
	}
	s := w.Snapshot()[0]
	if s.HP != 10 || s.State != "intact" {
		t.Fatalf("respawned with %+v", s)
	}
}

func TestLootRolledOncePerBreak(t *testing.T) {
	w, h := setup(t)
	rnd := rand.New(rand.NewPCG(1, 2))
	p := at(1, 1)
	w.Place(p, 10)
	w.OnAttackObject(p, melee(5), rnd)
	if len(h.loot) != 0 {
		t.Fatal("loot before the break")
	}
	w.OnAttackObject(p, melee(5), rnd)
	for range 5 {
		w.OnAttackObject(p, melee(50), rnd) // strikes on the debris
	}
	if len(h.loot) != 1 || len(h.loot[0]) != 1 || h.loot[0][0] != (Drop{Item: "coin", Count: 3}) {
		t.Fatalf("loot %v, want one drop of 3 coins", h.loot)
	}
}

func TestPushIntoBlockedTile(t *testing.T) {
	w, h := setup(t)
	w.Place(at(5, 5), 13)
	h.walls[at(6, 5)] = true
	if r := w.Push(at(5, 5), 1, 0); r != PushBlocked {
		t.Fatalf("into a wall: %v", r)
	}
	h.creatures[at(4, 5)] = true
	if r := w.Push(at(5, 5), -1, 0); r != PushBlocked {
		t.Fatalf("onto a creature: %v", r)
	}
	h.items[at(5, 6)] = true
	if r := w.Push(at(5, 5), 0, 1); r != PushBlocked {
		t.Fatalf("onto loose items: %v", r)
	}
	w.Place(at(5, 3), 12)
	w.OnAttackObject(at(5, 3), Hit{Methods: []string{ByPick}, Damage: 99}, rand.New(rand.NewPCG(1, 1)))
	w.Push(at(5, 5), 0, -1)
	if r := w.Push(at(5, 4), 0, -1); r != PushBlocked {
		t.Fatalf("onto a broken rock's tile: %v", r)
	}
	if w.ItemAt(at(5, 4)) != 13 || !h.block[at(5, 4)][0] || h.block[at(5, 5)][0] {
		t.Fatal("the boulder must have moved one tile, its old tile free")
	}
	if r := w.Push(at(5, 5), 0, -1); r != PushNoObject {
		t.Fatalf("pushing the empty tile: %v", r)
	}
	if r := w.Push(at(5, 4), 0, 0); r != PushBlocked {
		t.Fatalf("no direction: %v", r)
	}
}

func TestTwoPushesOfOneBoulderInOneTick(t *testing.T) {
	w, _ := setup(t)
	w.Place(at(5, 5), 13)
	w.OnTick(10)
	// Two players next to it push it on the same tick: one east, one south. The loop
	// runs their commands one after the other.
	first, second := w.Push(at(5, 5), 1, 0), w.Push(at(5, 5), 0, 1)
	if first != PushMoved || second != PushNoObject {
		t.Fatalf("pushes: %v, %v", first, second)
	}
	if n := len(w.Snapshot()); n != 1 || w.Snapshot()[0].Pos != at(6, 5) {
		t.Fatalf("one boulder at 6,5, got %+v", w.Snapshot())
	}
}

func TestBoulderGoesHomeWhenFree(t *testing.T) {
	w, h := setup(t)
	w.Place(at(5, 5), 13)
	w.OnTick(10)
	w.Push(at(5, 5), 1, 0)
	h.creatures[at(5, 5)] = true
	w.OnTick(10 + 10*tps)
	if w.ItemAt(at(6, 5)) != 13 {
		t.Fatal("reset onto a creature")
	}
	delete(h.creatures, at(5, 5))
	w.OnTick(10 + 10*tps + tps)
	if w.ItemAt(at(5, 5)) != 13 || w.ItemAt(at(6, 5)) != 0 {
		t.Fatal("boulder did not go home")
	}
}

func TestPlatesOpenTheGate(t *testing.T) {
	w, h := setup(t)
	w.Place(at(10, 10), 14) // gate
	w.Place(at(8, 10), 16)  // plates
	w.Place(at(12, 10), 16)
	w.Place(at(8, 11), 13) // boulder below the first plate
	w.Link()
	w.OnTick(1)
	if w.ItemAt(at(10, 10)) != 14 {
		t.Fatal("gate starts closed")
	}
	w.Push(at(8, 11), 0, -1) // boulder onto plate 1
	if !w.Pressed(at(8, 10)) || w.ItemAt(at(10, 10)) != 14 {
		t.Fatal("one plate of two must not open it")
	}
	h.creatures[at(12, 10)] = true
	w.OnStep(at(13, 10), at(12, 10))
	if w.ItemAt(at(10, 10)) != 15 || h.block[at(10, 10)][0] {
		t.Fatal("both plates pressed: the gate must be open and walkable")
	}
	h.creatures[at(10, 10)] = true // someone in the gateway
	delete(h.creatures, at(12, 10))
	w.OnTick(2)
	if w.ItemAt(at(10, 10)) != 15 {
		t.Fatal("the gate closed on a creature")
	}
	delete(h.creatures, at(10, 10))
	w.OnTick(3)
	if w.ItemAt(at(10, 10)) != 14 || !h.block[at(10, 10)][0] {
		t.Fatal("the gate must close once its plates are free and nobody is in it")
	}
}

func TestResolveRefusesWallsDoorsAndBadData(t *testing.T) {
	cases := map[string]string{
		"- item: stone_wall\n  breakable: { hp: 1, by: [melee], becomes: none }":                                           "wall",
		"- item: door\n  pushable: {}":                                                                                     "door",
		"- item: crate\n  breakable: { hp: 1, by: [kick], becomes: none }":                                                 "kick",
		"- item: crate\n  breakable: { hp: 1, by: [melee], becomes: rock }":                                                "debris must be walkable",
		"- item: crate\n  breakable: { hp: 0, by: [melee], becomes: none }":                                                "hp",
		"- item: crate\n  breakable: { hp: 1, by: [melee], becomes: none }\n  pushable: {}":                                "exactly one",
		"- item: plate\n  plate: { radius: 0 }":                                                                            "radius",
		"- item: boulder\n  pushable: { reset_seconds: 0 }":                                                                "reset_seconds",
		"- item: boulder\n  pushable: {}":                                                                                  "reset_seconds",
		"- item: crate_debris\n  pushable: {}":                                                                             "block movement",
		"- item: gate\n  gate: { open: rock }":                                                                             "walkable",
		"- item: crate\n  breakable: { hp: 1, by: [melee], becomes: none, loot: [{ item: x, chance: 1 }] }":                "loot item",
		"- item: crate\n  breakable: { hp: 1, by: [melee], becomes: crate_debris, debris_seconds: 9, respawn_seconds: 3 }": "longer",
	}
	for src, want := range cases {
		defs, err := Parse([]byte(src))
		if err != nil {
			t.Fatalf("%s: %v", src, err)
		}
		if _, err := Resolve(defs, lookup, nil, tps); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: error %v, want it to mention %q", src, err, want)
		}
	}
}

func TestLoadDirMissingIsEmpty(t *testing.T) {
	defs, err := LoadDir(t.TempDir() + "/nope")
	if err != nil || defs != nil {
		t.Fatalf("LoadDir of a missing dir: %v, %v", defs, err)
	}
}

// A blocked respawn waits one second of the loop's own ticks (Resolve's tps), not a
// fixed count that assumes 50 ms ticks.
func TestRespawnRetryFollowsTicksPerSecond(t *testing.T) {
	defs, err := Parse([]byte(testYAML))
	if err != nil {
		t.Fatal(err)
	}
	const slow = 10
	cat, err := Resolve(defs, lookup, nil, slow)
	if err != nil {
		t.Fatal(err)
	}
	h := newHost()
	w := New(cat, h)
	rnd := rand.New(rand.NewPCG(1, 2))
	w.Place(at(1, 1), 12) // rock: respawns after 3 s, no debris
	w.OnTick(1)
	if r := w.OnAttackObject(at(1, 1), Hit{Methods: []string{ByPick}, Damage: 10}, rnd); r != HitBroken {
		t.Fatalf("pick: %v", r)
	}
	h.creatures[at(1, 1)] = true
	w.OnTick(1 + 3*slow) // due, but someone stands there
	if w.Breakable(at(1, 1)) {
		t.Fatal("respawned on a creature")
	}
	delete(h.creatures, at(1, 1))
	w.OnTick(1 + 3*slow + slow - 1)
	if w.Breakable(at(1, 1)) {
		t.Fatal("respawned before a second went by")
	}
	w.OnTick(1 + 3*slow + slow)
	if !w.Breakable(at(1, 1)) {
		t.Fatal("not respawned one second after the blocked try")
	}
	if w.Timers() != 0 {
		t.Fatalf("%d timers left once everything stands", w.Timers())
	}
}

// The timers run from a queue: a push that restarts a boulder's reset leaves a stale
// entry that never moves it early, and the queue empties once every timer ran.
func TestTimersQueueSkipsStaleEntries(t *testing.T) {
	w, _ := setup(t)
	w.Place(at(5, 5), 13) // boulder: resets after 10 s
	w.OnTick(1)
	if w.Push(at(5, 5), 1, 0) != PushMoved {
		t.Fatal("first push")
	}
	w.OnTick(1 + 5*tps)
	if w.Push(at(6, 5), 1, 0) != PushMoved {
		t.Fatal("second push")
	}
	w.OnTick(1 + 10*tps) // the first push's reset is stale now
	if w.Has(at(5, 5)) || !w.Has(at(7, 5)) {
		t.Fatal("the stale timer of the first push sent the boulder home")
	}
	w.OnTick(1 + 15*tps)
	if !w.Has(at(5, 5)) || w.Has(at(7, 5)) {
		t.Fatal("the boulder did not go home 10 s after the last push")
	}
	if w.Timers() != 0 {
		t.Fatalf("%d timers left", w.Timers())
	}
	if g := w.Gates(); len(g) != 0 {
		t.Fatalf("gates %v", g)
	}
}

// TestLooseItemsNeverHoldAnObjectBack: the loot nobody took (or a coin dropped to jam it)
// is moved aside so the crate stands again, the boulder goes home and the gate closes; a
// creature still holds each of them back, and items that cannot move make them retry.
func TestLooseItemsNeverHoldAnObjectBack(t *testing.T) {
	w, h := setup(t)
	rnd := rand.New(rand.NewPCG(1, 2))
	crate := at(1, 1)
	w.Place(crate, 10)
	w.Place(at(10, 10), 14) // gate
	w.Place(at(8, 10), 16)  // its plate
	w.Place(at(8, 11), 13)  // boulder below the plate
	w.Link()
	w.OnTick(100)
	w.OnAttackObject(crate, melee(10), rnd)
	h.items[crate] = true // its loot, never picked up
	h.stuck[crate] = true // ... and nowhere to put it yet
	w.OnTick(100 + 2*tps) // the debris fades
	w.OnTick(100 + 5*tps)
	if w.ItemAt(crate) != 0 {
		t.Fatal("respawned over items that could not move")
	}
	delete(h.stuck, crate)
	w.OnTick(100 + 5*tps + tps)
	if w.ItemAt(crate) != 10 || h.items[crate] {
		t.Fatal("the loot nobody took must be moved aside and the crate stand again")
	}

	// The boulder on the plate opens the gate; an item in the gateway and one on the
	// boulder's home.
	w.Push(at(8, 11), 0, -1)
	if w.ItemAt(at(10, 10)) != 15 {
		t.Fatal("gate did not open")
	}
	h.items[at(10, 10)] = true
	h.items[at(8, 11)] = true
	h.creatures[at(8, 11)] = true // someone on the boulder's home: it waits
	w.OnTick(100 + 16*tps)        // its reset is due (pushed at 100+6s, reset_seconds 10)
	if w.ItemAt(at(8, 10)) != 13 || !h.items[at(8, 11)] {
		t.Fatal("the boulder went home onto a creature, or its items moved under one")
	}
	delete(h.creatures, at(8, 11))
	w.OnTick(100 + 17*tps)
	if w.ItemAt(at(8, 11)) != 13 || h.items[at(8, 11)] {
		t.Fatal("the boulder must go home once its items are moved aside")
	}
	if w.ItemAt(at(10, 10)) != 14 || h.items[at(10, 10)] {
		t.Fatal("an item in the gateway must not keep the gate open")
	}
}

// Nothing comes back in a player's view: a broken crate whose respawn is due stays gone
// while its tile is watched, keeps the loose items on it where they lie, and stands again
// on the first retry after the last player looked away.
func TestRespawnWaitsWhileWatched(t *testing.T) {
	w, h := setup(t)
	p := at(1, 1)
	w.Place(p, 10)
	w.OnTick(100)
	if w.OnAttackObject(p, melee(10), rand.New(rand.NewPCG(1, 2))) != HitBroken {
		t.Fatal("crate did not break")
	}
	h.watched[p] = true
	h.items[p] = true // loot nobody took
	for tick := uint64(100); tick <= 100+60*tps; tick++ {
		w.OnTick(tick)
	}
	if w.ItemAt(p) != 0 || h.block[p][0] || len(h.cleared) != 0 {
		t.Fatalf("watched: item %d, cleared %v: the crate came back in sight or moved the loot", w.ItemAt(p), h.cleared)
	}
	for _, k := range h.kinds() {
		if k == EventRespawn {
			t.Fatal("a respawn event while watched")
		}
	}
	delete(h.watched, p)
	w.OnTick(100 + 61*tps)
	if w.ItemAt(p) != 10 || !h.block[p][0] {
		t.Fatal("crate did not respawn once nobody watched")
	}
}

// A player locked in behind a boulder (it cannot push it back: a push needs the tile behind
// it) sees it all the time. Sight holds the reset only for resetSightHold reset times from
// the last push: then the boulder goes home in view and the way is open again.
func TestResetDoesNotWaitForEverWhileWatched(t *testing.T) {
	w, h := setup(t)
	w.Place(at(5, 5), 13) // boulder: resets after 10 s
	w.OnTick(1)
	if w.Push(at(5, 5), 1, 0) != PushMoved {
		t.Fatal("boulder did not move")
	}
	h.watched[at(6, 5)], h.watched[at(5, 5)] = true, true
	limit := uint64(1 + resetSightHold*10*tps)
	for tick := uint64(1); tick < limit; tick++ {
		w.OnTick(tick)
	}
	if w.ItemAt(at(6, 5)) != 13 {
		t.Fatal("the boulder went home in sight before the hold ran out")
	}
	for tick := limit; tick <= limit+tps; tick++ { // the retry is every second
		w.OnTick(tick)
	}
	if w.ItemAt(at(5, 5)) != 13 || w.ItemAt(at(6, 5)) != 0 {
		t.Fatal("a watched boulder never went home: whoever is behind it stays locked in")
	}
	// A new push starts the hold again.
	if w.Push(at(5, 5), 1, 0) != PushMoved {
		t.Fatal("boulder did not move again")
	}
	for tick := limit + tps + 1; tick <= limit+tps+15*tps; tick++ {
		w.OnTick(tick)
	}
	if w.ItemAt(at(6, 5)) != 13 {
		t.Fatal("the hold did not start again with the new push")
	}
}

// A pushed boulder goes home only when no player sees the tile it leaves nor its home.
func TestResetWaitsWhileWatched(t *testing.T) {
	for _, c := range []struct {
		name string
		seen Pos
	}{{"where it lies", at(6, 5)}, {"its home", at(5, 5)}} {
		t.Run(c.name, func(t *testing.T) {
			w, h := setup(t)
			w.Place(at(5, 5), 13) // boulder: resets after 10 s
			w.OnTick(1)
			if w.Push(at(5, 5), 1, 0) != PushMoved {
				t.Fatal("boulder did not move")
			}
			h.watched[c.seen] = true
			for tick := uint64(1); tick <= 1+18*tps; tick++ {
				w.OnTick(tick)
			}
			if w.ItemAt(at(6, 5)) != 13 || w.ItemAt(at(5, 5)) != 0 {
				t.Fatal("the boulder went home in sight")
			}
			delete(h.watched, c.seen)
			w.OnTick(1 + 19*tps)
			if w.ItemAt(at(5, 5)) != 13 || w.ItemAt(at(6, 5)) != 0 {
				t.Fatal("the boulder did not go home once nobody watched")
			}
		})
	}
}
