package session_test

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// The case that made a command reserve what it gives away with the house write (hold.go
// reserveGiven, docs/01 "Guardado antes del transfer"), played for real with the content
// of data/: Ana's arc rune (arc_bolt) lies on the floor of her porch; from the street she
// uses it on a bilge rat, the last kill of a kill quest whose reward (a pickaxe) does not
// fit, so it falls at her feet on the street. One command spends a charge of the rune (it
// changes the house) and gives the pickaxe away: it writes the house with Ana's snapshot
// after both, no snapshot apart, logs nothing, and keeps the pickaxe from Caio until that
// house write is confirmed. No quest of data/ ends on a kill (they all end talking to an
// NPC), so the quest is the test's, with a real monster and reward.
func TestHouseRuneKillsAQuestMonsterFromTheStreet(t *testing.T) {
	const ana = 9801
	porch, street, rat := pos(31, 31), pos(31, 32), pos(34, 34)
	now := clock.Epoch
	log := &jobLog{}
	var logged bytes.Buffer
	q, err := content.ParseQuest([]byte(`{id: rat_cull, name: quest.rat_cull.name,
		steps: [{id: cull, complete_when: {kill: {monster: bilge_rat, count: 1}}}],
		rewards: [{item: pickaxe}]}`))
	if err != nil {
		t.Fatal(err)
	}
	spells, err := content.LoadSpells(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	var items content.Items
	h := dataHarnessWith(t, func(c *session.Config) {
		items = c.Items
		c.Spells = spells // the rune's arc_bolt
		c.Quests[q.ID] = q
		c.Map = worldtest.WithHouses(t, c.Map, world.House{ID: "porch", Name: "house.porch.name", Rent: 10,
			Rects: []world.HouseRect{{X: 30, Y: 30, Z: 7, W: 3, H: 2}}, Doors: []world.Pos{porch}, Exit: street})
		c.Houses = &session.HouseData{
			Owners: []session.HouseOwner{{HouseID: "porch", CharacterID: ana, AccountID: ana, Name: "Ana",
				PaidUntil: now.Add(100 * 24 * time.Hour), Since: now}},
			Items: []session.HouseItem{{HouseID: "porch", Pos: porch,
				Item: session.ItemState{ItemID: c.Items["arc_rune"].Numeric, Count: 4}}},
		}
		log.wire(c)
		logTo(&logged)(c)
	}, spawnAt("bilge_rat", int(rat.X), int(rat.Y), 0, 3600))
	backpack, rune, pickaxe := items["backpack"].Numeric, items["arc_rune"].Numeric, items["pickaxe"].Numeric
	join := func(id int64, name string, at world.Pos, voc string, skills ...session.SkillState) (*fakeClient, *session.Player) {
		cl, p := h.joinChar(session.Character{ID: id, AccountID: id, Name: name, Vocation: voc, Level: 12,
			Health: 200, Mana: 100, HasPos: true, Pos: at, Skills: skills,
			Inventory: []session.ItemState{{ItemID: backpack, Count: 1, Slot: int(slotBackpack)}}})
		cl.take()
		return cl, p
	}
	cl, a := join(ana, "Ana", street, "arcanist", session.SkillState{ID: "magic", Level: 10})
	cc, c := join(9802, "Caio", pos(32, 33), "guardian")
	h.sim.Step() // the rat spawns
	ms := h.w.Monsters()
	if len(ms) != 1 || ms[0].Kind() != "bilge_rat" || h.w.HouseOwnerOf(ana) != "porch" || len(h.w.GroundAt(porch)) != 1 {
		t.Fatalf("%d monsters, house %q, %d items on the porch", len(ms), h.w.HouseOwnerOf(ana), len(h.w.GroundAt(porch)))
	}
	h.sim.Command(gameFunc(func() {
		a.SetStorageForTest("quest.rat_cull", int64(quest.InProgress))
		h.w.SetCapacityForTest(a, 0) // the reward does not fit
	}))
	h.sim.Step()
	cl.take()

	n := len(log.jobs)
	h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_UseItemOn{UseItemOn: &pb.UseItemOn{
		From: onTile(porch), ItemId: uint32(rune), StackIndex: 1,
		To: &pb.ActionTarget{Target: &pb.ActionTarget_CreatureId{CreatureId: ms[0].ID()}}}}})
	h.sim.Step()
	if evs := cl.take(); len(h.w.Monsters()) != 0 {
		t.Fatalf("the rune did not kill the rat: %v", systemKeys(evs))
	}
	if st, _ := h.w.QuestState(a, "rat_cull"); st != quest.Completed || h.w.CountItem(a, "pickaxe") != 0 {
		t.Fatalf("quest %v, %d pickaxes carried", st, h.w.CountItem(a, "pickaxe"))
	}
	if g := h.w.GroundAt(street); len(g) != 1 || g[0].Def().Numeric != pickaxe {
		t.Fatalf("the pickaxe did not fall at Ana's feet: %d items on %v", len(g), street)
	}
	if g := h.w.GroundAt(porch); len(g) != 1 || g[0].Count() != 3 {
		t.Fatalf("the rune on the porch did not spend a charge: %d items", len(g))
	}
	jobs := log.since(n)
	if len(jobs) != 1 || jobs[0].Transfer == nil || len(jobs[0].Transfer.Houses) != 1 {
		t.Fatalf("the command wrote %d jobs, want the house write alone (no snapshot of the gift apart)", len(jobs))
	}
	house := jobs0Snapshot(t, jobs[0], ana)
	if house.Storage["quest.rat_cull"] != int64(quest.Completed) {
		t.Fatalf("Ana's snapshot in the house write has the quest at %d", house.Storage["quest.rat_cull"])
	}
	if strings.Contains(logged.String(), giftAndHouse) {
		t.Fatalf("a gift reserved with the house write was logged: %q", logged.String())
	}

	// The pickaxe stays Ana's until the house write's ack, whatever older ack comes first.
	cp := openBackpack(t, h, cc, backpack)
	take := moveItem(onTile(street), uint32(pickaxe), 1, inContainer(cp, 0), 1)
	h.sim.Command(h.w.Saved(ana, house.Seq-1))
	h.sim.Step()
	if !hasKey(h.send(cc, take), "inventory.not_yours") {
		t.Fatal("the pickaxe was not reserved to Ana until the house write's ack")
	}
	h.sim.Command(h.w.Saved(ana, house.Seq))
	h.sim.Step()
	if evs := h.send(cc, take); len(systemKeys(evs)) != 0 || h.w.CountItem(c, "pickaxe") != 1 {
		t.Fatalf("pick the pickaxe up after the house write's ack: %v", systemKeys(evs))
	}
}

// openBackpack opens cl's backpack (item id pack) and returns its window id.
func openBackpack(t *testing.T, h *harness, cl *fakeClient, pack uint16) uint32 {
	t.Helper()
	h.input(cl, useItem(inSlot(slotBackpack), uint32(pack), 0))
	h.sim.Step()
	opens := find(cl.take(), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 {
		t.Fatalf("ContainerOpen = %v", opens)
	}
	return opens[0].GetContainerId()
}
