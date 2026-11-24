package session_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

const (
	// furID is remains_fur, the fallen body of a furred beast (data/items), in these tests.
	furID = 91
	// chitinID is remains_chitin with a single slot here (10 in data/items): fewer than the
	// default remains, so the loot that fits is the family's remains' to decide.
	chitinID = 93
)

// corpseTestItems are testItems plus remains_fur, a one-slot remains_chitin and the wrong
// kinds of remains: a pickupable bag and a fixed decoration with a container block.
func corpseTestItems() content.Items {
	items := testItems()
	for n, src := range map[uint16]string{
		furID:    "{id: remains_fur, kind: container, pickupable: false, blocks_movement: false, container: {slots: 10}}",
		92:       "{id: loose_sack, kind: container, weight: 300, container: {slots: 4}}",
		chitinID: "{id: remains_chitin, kind: container, pickupable: false, blocks_movement: false, container: {slots: 1}}",
		94:       "{id: odd_chest, kind: decoration, pickupable: false, container: {slots: 4}}",
	} {
		var it content.Item
		_ = yaml.Unmarshal([]byte(src), &it)
		it.Numeric = n
		items[it.ID] = &it
	}
	return items
}

// ratDef is a monster without a `corpse` of its own: it leaves the default remains.
func ratDef() *content.Monster {
	return &content.Monster{ID: "rat", Health: 10, Experience: 5, Speed: 150,
		Behavior: content.MonsterBehavior{TargetDistance: 1},
		Attacks:  []content.MonsterAttack{{Type: "melee", Element: "physical", Min: 0, Max: 2, IntervalMs: 2000, Chance: 1}},
		Loot:     []content.LootEntry{{Item: "copper_coin", Chance: 1, Count: []int{2, 2}}},
	}
}

// crabDef leaves remains_chitin (one slot in these tests) and drops two stacks of coins.
func crabDef() *content.Monster {
	crab := ratDef()
	crab.ID = "crab"
	crab.Corpse = "remains_chitin"
	crab.Loot = []content.LootEntry{{Item: "copper_coin", Chance: 1, Count: []int{150, 150}}}
	return crab
}

// killAll kills every monster of h in the same tick, in creature id order. Each kill takes
// the monster out of h.w.Monsters(), so it walks a copy of the list.
func killAll(h *harness) {
	h.sim.Command(ctxFunc(func(ctx *game.TickContext) {
		for _, m := range slices.Clone(h.w.Monsters()) {
			h.w.KillForTest(ctx, m)
		}
	}))
	h.sim.Step()
}

// The remains a monster leaves are its family's (data/monsters `corpse`), or the default
// remains without one; the loot lands inside them, as much as their own slots hold, and
// they decay after combat.monster_corpse_ms exactly as before.
func TestMonsterLeavesTheRemainsOfItsFamily(t *testing.T) {
	wolf := wolfDef()
	wolf.Behavior.Aggressive = false
	wolf.Loot = []content.LootEntry{{Item: "copper_coin", Chance: 1, Count: []int{3, 3}}}
	wolf.Corpse = "remains_fur"
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 64), func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": wolf, "rat": ratDef(), "crab": crabDef()}
		c.Items = corpseTestItems()
		c.Map.Islands()[0].Spawns = []world.Spawn{
			spawnAt("wolf", 20, 20, 0, 600), spawnAt("rat", 26, 20, 0, 600), spawnAt("crab", 23, 28, 0, 600),
		}
	})
	cl, _ := h.join("Witness", at(23, 24))
	h.sim.Step()
	where := map[string]world.Pos{}
	for _, m := range h.w.Monsters() {
		where[m.Kind()] = m.Pos()
	}
	if len(where) != 3 {
		t.Fatalf("monsters: %v", where)
	}
	cl.take()
	killAll(h)

	top := map[world.Pos]*pb.ItemStack{}
	for _, tu := range find(cl.take(), (*pb.ServerMessage).GetTileUpdate) {
		p := tu.GetPos()
		items := tu.GetTile().GetItems()
		top[world.Pos{X: uint16(p.GetX()), Y: uint16(p.GetY()), Z: uint8(p.GetZ())}] = items[len(items)-1]
	}
	for kind, want := range map[string]struct {
		item    string
		numeric uint32
		coins   []uint32 // the stacks inside, in order
	}{
		"wolf": {"remains_fur", furID, []uint32{3}},
		"rat":  {session.CorpseItem, corpseID, []uint32{2}},
		// 150 coins are two stacks; its one-slot remains keep the first.
		"crab": {"remains_chitin", chitinID, []uint32{100}},
	} {
		cs := h.w.CorpsesAt(where[kind])
		if len(cs) != 1 || cs[0].Monster != kind {
			t.Fatalf("%s: remains %+v at %v", kind, cs, where[kind])
		}
		if got := cs[0].Item.Def().ID; got != want.item {
			t.Errorf("%s left %q, want %q", kind, got, want.item)
		}
		if got := top[where[kind]].GetItemId(); got != want.numeric {
			t.Errorf("%s: the clients saw item %d on its tile, want %d", kind, got, want.numeric)
		}
		// Whose remains they are travels with the item, on the server and to the clients:
		// the client names them "remains of <monster>" and draws that monster's corpse.
		if got := cs[0].Item.Mods().RemainsOf; got != kind {
			t.Errorf("%s: remains of %q", kind, got)
		}
		if got := top[where[kind]].GetMods().GetRemainsOf(); got != kind {
			t.Errorf("%s: the clients saw remains of %q", kind, got)
		}
		var coins []uint32
		for _, it := range cs[0].Loot() {
			if it.GetItemId() != coinID {
				t.Errorf("%s: item %d in its remains, want only coins", kind, it.GetItemId())
			}
			coins = append(coins, it.GetCount())
		}
		if !slices.Equal(coins, want.coins) {
			t.Errorf("%s: coin stacks %v in its remains, want %v", kind, coins, want.coins)
		}
	}

	// They decay on the tick monster_corpse_ms (60 s in the tests) after the death, not a
	// tick sooner nor later, all three on the same tick.
	anyGone := func() bool {
		for _, p := range where {
			if len(h.w.CorpsesAt(p)) == 0 {
				return true
			}
		}
		return false
	}
	if n, want := h.sim.RunUntil(anyGone, sim.MaxSeconds(70)), int(game.TicksFor(60*time.Second)); n != want {
		t.Errorf("remains decayed %d ticks after the death, want %d (monster_corpse_ms)", n, want)
	}
	for kind, p := range where {
		if n := len(h.w.CorpsesAt(p)); n != 0 {
			t.Errorf("%s: %d remains still there on the tick the others decayed", kind, n)
		}
	}
}

// A `corpse` must be a container item that cannot be picked up: the world refuses anything
// else (as the content validator does, packages/content-schema).
func TestMonsterCorpseMustBeFixedContainer(t *testing.T) {
	for corpse, want := range map[string]string{
		"no_such_item": "no_such_item",
		"copper_coin":  "copper_coin", // not a container
		"loose_sack":   "loose_sack",  // a container that can be picked up
		"odd_chest":    "odd_chest",   // a container block, but not of kind container
	} {
		wolf := wolfDef()
		wolf.Corpse = corpse
		_, err := session.New(session.Config{Map: worldtest.Open(t, 0, 0, 16, 16), Balance: testBalance(),
			Vocations: testVocations, Monsters: content.Monsters{"wolf": wolf}, Items: corpseTestItems(),
			Save: func(session.Snapshot) bool { return true }})
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("corpse %q: err = %v", corpse, err)
		}
	}
}
