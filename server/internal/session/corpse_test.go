package session_test

import (
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// furID is remains_fur, the fallen body of a furred beast (data/items), in these tests.
const furID = 91

// corpseTestItems are testItems plus remains_fur and a pickupable bag of the wrong kind.
func corpseTestItems() content.Items {
	items := testItems()
	for n, src := range map[uint16]string{
		furID: "{id: remains_fur, kind: container, pickupable: false, blocks_movement: false, container: {slots: 10}}",
		92:    "{id: loose_sack, kind: container, weight: 300, container: {slots: 4}}",
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

// killAll kills every monster of h in the same tick, in creature id order.
func killAll(h *harness) {
	h.sim.Command(ctxFunc(func(ctx *game.TickContext) {
		for _, m := range h.w.Monsters() {
			h.w.KillForTest(ctx, m)
		}
	}))
	h.sim.Step()
}

// The remains a monster leaves are its family's (data/monsters `corpse`), or the default
// remains without one; the loot lands inside them, and both decay after
// combat.monster_corpse_ms exactly as before.
func TestMonsterLeavesTheRemainsOfItsFamily(t *testing.T) {
	wolf := wolfDef()
	wolf.Behavior.Aggressive = false
	wolf.Loot = []content.LootEntry{{Item: "copper_coin", Chance: 1, Count: []int{3, 3}}}
	wolf.Corpse = "remains_fur"
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 64), func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": wolf, "rat": ratDef()}
		c.Items = corpseTestItems()
		c.Map.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 20, 20, 0, 600), spawnAt("rat", 26, 20, 0, 600)}
	})
	cl, _ := h.join("Witness", at(23, 24))
	h.sim.Step()
	where := map[string]world.Pos{}
	for _, m := range h.w.Monsters() {
		where[m.Kind()] = m.Pos()
	}
	if len(where) != 2 {
		t.Fatalf("monsters: %v", where)
	}
	cl.take()
	killAll(h)
	died := h.sim.Tick()

	top := map[world.Pos]uint32{}
	for _, tu := range find(cl.take(), (*pb.ServerMessage).GetTileUpdate) {
		p := tu.GetPos()
		items := tu.GetTile().GetItems()
		top[world.Pos{X: uint16(p.GetX()), Y: uint16(p.GetY()), Z: uint8(p.GetZ())}] = items[len(items)-1].GetItemId()
	}
	for kind, want := range map[string]struct {
		item    string
		numeric uint32
	}{"wolf": {"remains_fur", furID}, "rat": {session.CorpseItem, corpseID}} {
		cs := h.w.CorpsesAt(where[kind])
		if len(cs) != 1 || cs[0].Monster != kind {
			t.Fatalf("%s: remains %+v at %v", kind, cs, where[kind])
		}
		if got := cs[0].Item.Def().ID; got != want.item {
			t.Errorf("%s left %q, want %q", kind, got, want.item)
		}
		if got := top[where[kind]]; got != want.numeric {
			t.Errorf("%s: the clients saw item %d on its tile, want %d", kind, got, want.numeric)
		}
		loot := cs[0].Loot()
		if len(loot) != 1 || loot[0].GetItemId() != coinID {
			t.Errorf("%s: loot %v, want its coins inside its remains", kind, loot)
		}
	}

	// Both decay after monster_corpse_ms (60 s in the tests), not a tick sooner.
	h.sim.RunFor(60*time.Second - 2*game.TickDuration)
	for kind, p := range where {
		if len(h.w.CorpsesAt(p)) != 1 {
			t.Fatalf("%s: remains gone %v after death, before monster_corpse_ms", kind,
				time.Duration(h.sim.Tick()-died)*game.TickDuration)
		}
	}
	h.sim.RunFor(2 * time.Second)
	for kind, p := range where {
		if n := len(h.w.CorpsesAt(p)); n != 0 {
			t.Errorf("%s: %d remains still there after monster_corpse_ms", kind, n)
		}
	}
}

// A `corpse` must be a container that cannot be picked up: the world refuses anything else.
func TestMonsterCorpseMustBeFixedContainer(t *testing.T) {
	for corpse, want := range map[string]string{
		"no_such_item": "no_such_item",
		"copper_coin":  "copper_coin", // not a container
		"loose_sack":   "loose_sack",  // a container that can be picked up
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
