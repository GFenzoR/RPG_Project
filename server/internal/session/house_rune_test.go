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
// uses it on an ember wyrmling (worn down to its last hit point), the last kill of
// flame_crater, the side quest that ends on its kill step (lote 12): its first reward, a
// cinder amulet, does not fit (the experience after it raises the level, and with it the
// capacity, so the gold does), so it falls at her feet on the street. One command spends a
// charge of the rune (it changes the house) and gives the amulet away: it writes the
// house with Ana's snapshot after both, no snapshot apart, logs nothing, and keeps the
// amulet from Caio until that house write is confirmed.
func TestHouseRuneKillsAQuestMonsterFromTheStreet(t *testing.T) {
	const ana = 9801
	porch, street, nest := pos(31, 31), pos(31, 32), pos(34, 34)
	now := clock.Epoch
	log := &jobLog{}
	var logged bytes.Buffer
	spells, err := content.LoadSpells(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	var items content.Items
	var crater *content.Quest
	h := dataHarnessWith(t, func(c *session.Config) {
		items, crater = c.Items, c.Quests["flame_crater"]
		c.Spells = spells // the rune's arc_bolt
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
	}, spawnAt("ember_wyrmling", int(nest.X), int(nest.Y), 0, 3600))
	backpack, rune, amulet := items["backpack"].Numeric, items["arc_rune"].Numeric, items["cinder_amulet"].Numeric
	join := func(id int64, name string, at world.Pos, voc string, skills ...session.SkillState) (*fakeClient, *session.Player) {
		cl, p := h.joinChar(session.Character{ID: id, AccountID: id, Name: name, Vocation: voc, Level: 12,
			Health: 200, Mana: 100, HasPos: true, Pos: at, Skills: skills,
			Inventory: []session.ItemState{{ItemID: backpack, Count: 1, Slot: int(slotBackpack)}}})
		cl.take()
		return cl, p
	}
	cl, a := join(ana, "Ana", street, "arcanist", session.SkillState{ID: "magic", Level: 10})
	cc, c := join(9802, "Caio", pos(32, 33), "guardian")
	h.sim.Step() // the wyrmling spawns
	ms := h.w.Monsters()
	if len(ms) != 1 || ms[0].Kind() != "ember_wyrmling" || h.w.HouseOwnerOf(ana) != "porch" || len(h.w.GroundAt(porch)) != 1 {
		t.Fatalf("%d monsters, house %q, %d items on the porch", len(ms), h.w.HouseOwnerOf(ana), len(h.w.GroundAt(porch)))
	}
	h.sim.Command(gameFunc(func() {
		// The sixth wyrmling of the nest is the last of flame_crater (its reach step is
		// done): it ends the quest where Ana stands.
		thin := crater.Steps[crater.StepIndex("thin_nest")].CompleteWhen.Kill
		a.SetStorageForTest("quest.flame_crater", int64(quest.InProgress))
		a.SetStorageForTest("quest.flame_crater.step", int64(crater.StepIndex("thin_nest")))
		a.SetStorageForTest("quest.flame_crater.kills", int64(thin.Count-1))
		ms[0].SetHealth(1)
		h.w.SetCapacityForTest(a, 0) // the amulet does not fit
	}))
	h.sim.Step()
	cl.take()

	n := len(log.jobs)
	h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_UseItemOn{UseItemOn: &pb.UseItemOn{
		From: onTile(porch), ItemId: uint32(rune), StackIndex: 1,
		To: &pb.ActionTarget{Target: &pb.ActionTarget_CreatureId{CreatureId: ms[0].ID()}}}}})
	h.sim.Step()
	if evs := cl.take(); len(h.w.Monsters()) != 0 {
		t.Fatalf("the rune did not kill the wyrmling: %v", systemKeys(evs))
	}
	if st, _ := h.w.QuestState(a, "flame_crater"); st != quest.Completed || h.w.CountItem(a, "cinder_amulet") != 0 {
		t.Fatalf("quest %v, %d amulets carried", st, h.w.CountItem(a, "cinder_amulet"))
	}
	if g := h.w.GroundAt(street); len(g) != 1 || g[0].Def().Numeric != amulet {
		t.Fatalf("the amulet did not fall at Ana's feet: %d items on %v", len(g), street)
	}
	if g := h.w.GroundAt(porch); len(g) != 1 || g[0].Count() != 3 {
		t.Fatalf("the rune on the porch did not spend a charge: %d items", len(g))
	}
	jobs := log.since(n)
	if len(jobs) != 1 || jobs[0].Transfer == nil || len(jobs[0].Transfer.Houses) != 1 {
		t.Fatalf("the command wrote %d jobs, want the house write alone (no snapshot of the gift apart)", len(jobs))
	}
	house := jobs0Snapshot(t, jobs[0], ana)
	if house.Storage["quest.flame_crater"] != int64(quest.Completed) {
		t.Fatalf("Ana's snapshot in the house write has the quest at %d", house.Storage["quest.rat_cull"])
	}
	if strings.Contains(logged.String(), giftAndHouse) {
		t.Fatalf("a gift reserved with the house write was logged: %q", logged.String())
	}

	// The amulet stays Ana's until the house write's ack, whatever older ack comes first.
	cp := openBackpack(t, h, cc, backpack, uint32(items["backpack"].Container.Slots))
	take := moveItem(onTile(street), uint32(amulet), 1, inContainer(cp, 0), 1)
	h.sim.Command(h.w.Saved(ana, house.Seq-1))
	h.sim.Step()
	if !hasKey(h.send(cc, take), "inventory.not_yours") {
		t.Fatal("the amulet was not reserved to Ana until the house write's ack")
	}
	h.sim.Command(h.w.Saved(ana, house.Seq))
	h.sim.Step()
	if evs := h.send(cc, take); len(systemKeys(evs)) != 0 || h.w.CountItem(c, "cinder_amulet") != 1 {
		t.Fatalf("pick the amulet up after the house write's ack: %v", systemKeys(evs))
	}
}
