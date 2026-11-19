package session_test

import (
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Reward chests (docs/02 "Libros y cofres", chest.go): a chest of the map gives its rewards
// once per character, all of them or nothing, and logs each one under the chest source.

const (
	chestID  = worldtest.Vein // the 'v' of chestMap
	chestKey = "chest.test_cache"
)

// testChest gives 50 copper, 3 salves and a tunic (an equipable: it rolls).
const testChest = "{id: test_chest, kind: decoration, pickupable: false, blocks_movement: true, " +
	"chest: {id: test_cache, rewards: [{item: copper_coin, count: 50}, {item: test_salve, count: 3}, " +
	"{item: test_tunic, count: 1}]}}"

var chestMap = []string{
	"v...",
	"....",
	"....",
}

var chestPos = pos(0, 0)

// chestItems are the inventory test items with the chest, and copper coins of worth 1.
func chestItems(t testing.TB, chest string) content.Items {
	t.Helper()
	items := testItems()
	var it content.Item
	if err := yaml.Unmarshal([]byte(chest), &it); err != nil {
		t.Fatal(err)
	}
	it.Numeric = chestID
	items[it.ID] = &it
	coin := *items["copper_coin"]
	if err := yaml.Unmarshal([]byte("{currency: {worth: 1}}"), &coin); err != nil {
		t.Fatal(err)
	}
	items["copper_coin"] = &coin
	return items
}

func chestHarness(t *testing.T, opts ...option) *harness {
	t.Helper()
	return newHarness(t, worldtest.Map(t, 0, 0, 7, chestMap...), append([]option{func(c *session.Config) {
		c.Items = chestItems(t, testChest)
	}, withAttributes(t)}, opts...)...)
}

// opener joins a character at p with a 4-slot backpack holding pack.
func opener(h *harness, p world.Pos, pack ...session.ItemState) (*fakeClient, *session.Player) {
	h.t.Helper()
	nextChar++
	cl, pl := h.joinChar(withPack(nextChar, p, pack...))
	cl.take()
	return cl, pl
}

var useChest = useItem(onTile(chestPos), chestID, 1)

// chestEntries are the economy entries of the chest source.
func (h *harness) chestEntries() []session.EconomyEntry {
	var out []session.EconomyEntry
	for _, e := range h.economy {
		if e.Kind == session.EconChest {
			out = append(out, e)
		}
	}
	return out
}

// checkRewards fails unless p holds exactly one chest's rewards (n = 1) or none (0), and the
// log says so.
func checkRewards(t *testing.T, h *harness, p *session.Player, n int) {
	t.Helper()
	if got := [3]int{h.w.CountItem(p, "copper_coin"), h.w.CountItem(p, "test_salve"), h.w.CountItem(p, "test_tunic")}; got != [3]int{50 * n, 3 * n, n} {
		t.Fatalf("coins, salves, tunics = %v, want %d chest(s)", got, n)
	}
	if got := len(h.chestEntries()); got != 3*n {
		t.Fatalf("%d chest entries in the log, want %d: %+v", got, 3*n, h.chestEntries())
	}
	if got := p.Storage(chestKey); got != int64(min(n, 1)) {
		t.Fatalf("%s = %d", chestKey, got)
	}
}

// The first use gives everything (the tunic rolls its attribute), logs it under the chest
// and says what was in it; the next says it is empty and gives nothing.
func TestChestGivesItsRewardsOnce(t *testing.T) {
	h := chestHarness(t)
	cl, p := opener(h, pos(1, 1))
	h.input(cl, useChest)
	h.sim.Step()
	evs := cl.take()
	checkRewards(t, h, p, 1)
	found := find(evs, (*pb.ServerMessage).GetChatMessage)
	if len(found) != 1 || found[0].GetLocalized().GetKey() != "chest.found" || len(found[0].GetLocalized().GetParams()) != 3 {
		t.Fatalf("messages %v", systemKeys(evs))
	}
	tunics := h.w.ItemsForTest(p, "test_tunic")
	checkRolled(t, attrPool(t), h.w.ItemForTest("test_tunic"), tunics[0].Mods())
	for _, e := range h.chestEntries() {
		switch {
		case e.Ref != "test_cache" || e.CharacterID != p.CharacterID():
			t.Fatalf("entry %+v", e)
		case e.ItemID == 0 && e.Amount != 50, e.ItemID == salveID && e.Count != 3:
			t.Fatalf("entry %+v", e)
		case e.ItemID == tunicID && (e.Count != 1 || e.Mods != tunics[0].Mods()):
			t.Fatalf("the tunic's entry %+v, its mods %+v", e, tunics[0].Mods())
		}
	}

	h.input(cl, useChest)
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "chest.empty") {
		t.Fatalf("second use: %v", systemKeys(evs))
	}
	checkRewards(t, h, p, 1)
}

// Two uses in the same tick: the second finds it empty.
func TestChestUsedTwiceInOneTick(t *testing.T) {
	h := chestHarness(t)
	cl, p := opener(h, pos(1, 0))
	h.input(cl, useChest)
	h.input(cl, useChest)
	h.sim.Step()
	if keys := systemKeys(cl.take()); keys["chest.found"] != 1 || keys["chest.empty"] != 1 {
		t.Fatalf("messages %v", keys)
	}
	checkRewards(t, h, p, 1)
}

// A use and a disconnect in the same tick: the final save holds the rewards and the flag
// together, and the character that comes back finds the chest empty.
func TestChestAndDisconnectInTheSameTick(t *testing.T) {
	h := chestHarness(t)
	cl, p := opener(h, pos(1, 0))
	id := p.CharacterID()
	h.input(cl, useChest)
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	if h.w.PlayerByCharacter(id) != nil {
		t.Fatal("still online")
	}
	last := h.saves[len(h.saves)-1]
	if !last.Final || last.CharacterID != id || last.Storage[chestKey] != 1 {
		t.Fatalf("final save %+v", last)
	}
	held := map[uint16]int{}
	var count func([]session.ItemState)
	count = func(is []session.ItemState) {
		for _, it := range is {
			held[it.ItemID] += it.Count
			count(it.Items)
		}
	}
	count(last.Inventory)
	if held[coinID] != 50 || held[salveID] != 3 || held[tunicID] != 1 {
		t.Fatalf("saved inventory %v", held)
	}

	back := &fakeClient{}
	h.sim.Command(h.joinCmd(withPack(id, pos(1, 0)), back))
	h.sim.Step()
	q := h.w.PlayerByCharacter(id)
	if q == nil {
		t.Fatal("did not come back")
	}
	back.take()
	h.input(back, useChest)
	h.sim.Step()
	if evs := back.take(); !hasKey(evs, "chest.empty") {
		t.Fatalf("after coming back: %v", systemKeys(evs))
	}
	checkRewards(t, h, q, 1)
}

// No room for all of it (backpack slots or capacity): nothing is given, nothing is spent,
// and the same character opens it once it makes room.
func TestChestWithNoRoomGivesNothingAndCanBeRetried(t *testing.T) {
	h := chestHarness(t)
	// Three bags in the 4-slot backpack, full pockets: the coins, the salves and the tunic
	// need three.
	cl, p := opener(h, pos(1, 0), full(stack(bagID, 1, 0), stack(bagID, 1, 1), stack(bagID, 1, 2))...)
	h.input(cl, useChest)
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "chest.no_room") {
		t.Fatalf("full backpack: %v", systemKeys(evs))
	}
	checkRewards(t, h, p, 0)
	if len(h.w.GroundAt(pos(1, 0))) != 0 {
		t.Fatal("something fell at the player's feet")
	}

	// Two bags out: room in the backpack, but too heavy now.
	pack := openPack(t, h, cl)
	for range 2 {
		h.input(cl, moveItem(inContainer(pack, 0), bagID, 0, onTile(pos(2, 0)), 1))
		h.sim.Step()
	}
	cl.take()
	h.sim.Command(gameFunc(func() { h.w.SetCapacityForTest(p, p.Carried()+6000) })) // the tunic weighs 6000
	h.input(cl, useChest)
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "chest.no_room") {
		t.Fatalf("too heavy: %v", systemKeys(evs))
	}
	checkRewards(t, h, p, 0)

	h.sim.Command(gameFunc(func() { h.w.SetCapacityForTest(p, 1_000_000) }))
	h.input(cl, useChest)
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "chest.found") {
		t.Fatalf("with room: %v", systemKeys(evs))
	}
	checkRewards(t, h, p, 1)
}

// Rewards merge into the stacks the backpack holds: a full backpack whose salves and
// coins have room left only needs a slot for the tunic (and full pockets give none).
func TestChestRewardsMergeIntoStacks(t *testing.T) {
	h := chestHarness(t)
	cl, p := opener(h, pos(1, 0), full(stack(coinID, 50, 0), stack(salveID, 97, 1), stack(bagID, 1, 2))...)
	h.input(cl, useChest)
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "chest.found") {
		t.Fatalf("messages %v", systemKeys(evs))
	}
	if h.w.CountItem(p, "copper_coin") != 100 || h.w.CountItem(p, "test_salve") != 100 || h.w.CountItem(p, "test_tunic") != 1 {
		t.Fatal("not merged")
	}
	// One more salve would need a fifth slot: a second chest of the same kind cannot fit.
	h2 := newHarness(t, worldtest.Map(t, 0, 0, 7, chestMap...), func(c *session.Config) {
		c.Items = chestItems(t, strings.Replace(testChest, "count: 3}", "count: 4}", 1))
	})
	cl2, p2 := opener(h2, pos(1, 0), full(stack(coinID, 50, 0), stack(salveID, 97, 1), stack(bagID, 1, 2))...)
	h2.input(cl2, useChest)
	h2.sim.Step()
	if evs := cl2.take(); !hasKey(evs, "chest.no_room") {
		t.Fatalf("a salve over the stack: %v", systemKeys(evs))
	}
	if p2.Storage(chestKey) != 0 || h2.w.CountItem(p2, "test_salve") != 97 {
		t.Fatal("something was given")
	}
}

// Out of reach: too far, nothing given. A chest of another floor or out of view is no
// chest use at all (the static use answers, as for any map item).
func TestChestOutOfReach(t *testing.T) {
	h := chestHarness(t)
	cl, p := opener(h, pos(2, 2))
	h.input(cl, useChest)
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "inventory.too_far") {
		t.Fatalf("messages %v", systemKeys(evs))
	}
	checkRewards(t, h, p, 0)
	// A stale view (another item there): not possible.
	h.input(cl, useItem(onTile(chestPos), chestID+1, 1))
	h.sim.Step()
	if evs := cl.take(); hasKey(evs, "chest.found") || p.Storage(chestKey) != 0 {
		t.Fatalf("stale view opened it: %v", systemKeys(evs))
	}

	// Another floor: right above the chest (same x and y), a floor up, which sees floor 7.
	chestOn := func(m *world.Map) *harness {
		return newHarness(t, m, func(c *session.Config) { c.Items = chestItems(t, testChest) }, withAttributes(t))
	}
	up := chestOn(worldtest.Floors(t, 0, 0,
		worldtest.Layer{Z: 6, Rows: []string{"....", "....", "...."}}, worldtest.Layer{Z: 7, Rows: chestMap}))
	clUp, pUp := opener(up, world.Pos{X: chestPos.X, Y: chestPos.Y, Z: 6})
	up.input(clUp, useChest)
	up.sim.Step()
	if evs := clUp.take(); hasChestKey(evs) || pUp.Storage(chestKey) != 0 {
		t.Fatalf("a chest of another floor answered: %v", systemKeys(evs))
	}
	checkRewards(t, up, pUp, 0)

	// Out of view: one tile past the view's half width, on the same row.
	far := chestOn(worldtest.Map(t, 0, 0, 7, "v"+strings.Repeat(".", session.ViewHalfW+1)))
	clFar, pFar := opener(far, pos(session.ViewHalfW+1, 0))
	if session.Sees(pFar.Pos(), chestPos) {
		t.Fatal("the chest is in view")
	}
	far.input(clFar, useChest)
	far.sim.Step()
	if evs := clFar.take(); hasChestKey(evs) || pFar.Storage(chestKey) != 0 {
		t.Fatalf("a chest out of view answered: %v", systemKeys(evs))
	}
	checkRewards(t, far, pFar, 0)
}

// hasChestKey reports whether evs carry any chest.* system message.
func hasChestKey(evs []*pb.ServerMessage) bool {
	for k := range systemKeys(evs) {
		if strings.HasPrefix(k, "chest.") {
			return true
		}
	}
	return false
}

// The world does not start with a chest that gives the forge's protection, or a bad one.
func TestChestsCheckedAtStart(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7, chestMap...)
	cfg := func(chest string, forge bool) session.Config {
		items := chestItems(t, chest)
		for n, src := range refineItemDefs {
			if n == stationID {
				continue // the chest's id
			}
			var it content.Item
			if err := yaml.Unmarshal([]byte(src), &it); err != nil {
				t.Fatal(err)
			}
			it.Numeric = n
			items[it.ID] = &it
		}
		var anvil content.Item
		_ = yaml.Unmarshal([]byte("{id: test_forge, kind: decoration, pickupable: false}"), &anvil)
		anvil.Numeric = 150
		items["test_forge"] = &anvil
		c := session.Config{Map: m, Balance: testBalance(), Vocations: testVocations, Items: items,
			Save: func(session.Snapshot) bool { return true }}
		if forge {
			withForge(&c)
		}
		return c
	}
	amber := strings.Replace(testChest, "{item: test_tunic, count: 1}", "{item: test_amber, count: 1}", 1)
	if _, err := session.New(cfg(amber, true)); err == nil || !strings.Contains(err.Error(), "protection") {
		t.Fatalf("a chest of ambers: %v", err)
	}
	if _, err := session.New(cfg(amber, false)); err != nil {
		t.Fatalf("no forge, the amber is a material like any: %v", err)
	}
	if _, err := session.New(cfg(strings.Replace(testChest, "test_tunic", "nothing", 1), false)); err == nil {
		t.Fatal("a chest of an unknown item started")
	}
}
