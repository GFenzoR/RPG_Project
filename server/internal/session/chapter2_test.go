package session_test

import (
	"path/filepath"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// chapterTwoHarness is dataHarness with the Raigal NPCs of the Isla del Bosque (T3.6)
// placed next to Puerto's, and spawns of the Chapter 2 monsters.
func chapterTwoHarness(t *testing.T) *harness {
	t.Helper()
	return dataHarnessWith(t, func(cfg *session.Config) {
		is := cfg.Map.Islands()[0]
		is.NPCs = append(is.NPCs,
			world.NPCPlacement{NPC: "bosque_druid", Pos: pos(20, 10)},
			world.NPCPlacement{NPC: "bosque_ferryman", Pos: pos(20, 14)},
			world.NPCPlacement{NPC: "bosque_priest", Pos: pos(24, 10)},
			world.NPCPlacement{NPC: "bosque_merchant", Pos: pos(24, 14)},
		)
	},
		world.Spawn{ID: "toads", Center: pos(40, 44), Radius: 3, RespawnSeconds: 60,
			Monsters: []world.SpawnMonster{{Monster: "mire_toad", Count: 8}}},
		world.Spawn{ID: "smugglers", Center: pos(44, 12), Radius: 3, RespawnSeconds: 60,
			Monsters: []world.SpawnMonster{{Monster: "coffer_smuggler", Count: 8}}},
	)
}

// Chapter 2 end to end: the druid only offers it after Chapter 1 and at level 15; cull the
// toads (kill), bring glowcaps (gather + deliver), ask the ferryman (talk); then, at level
// 20, break the smugglers' camp (kill), bring their tallies (gather + deliver) and the
// sealed coffer (gather + deliver) for the rewards.
func TestChapterTwoPlayable(t *testing.T) {
	h := chapterTwoHarness(t)
	c := session.Character{ID: 920, AccountID: 920, Name: "Tracker", Vocation: "guardian", Level: 14, Health: 1000, Mana: 100}
	cl, p := h.joinFresh(c, pos(20, 12))
	druid, ferryman := h.npc("bosque_druid"), h.npc("bosque_ferryman")
	items, err := content.LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	// The kit of the forest town (equipped directly: a level change recomputes equipment).
	arm := func() { p.EquipForTest(items["thornwood_blade"], items["elmwood_shield"]) }
	hasOption := func(key string) bool {
		d := h.lastDialog(h.send(cl, talkMsg(druid.ID())))
		for _, o := range d.Options {
			if o.Text.Key == key {
				return true
			}
		}
		return false
	}

	// Without Chapter 1 the druid has nothing to say about the boat.
	if hasOption("npc.bosque_druid.opt_boat") {
		t.Fatal("Chapter 2 offered before Chapter 1")
	}
	h.sim.Command(gameFunc(func() { p.SetStorageForTest("quest.ch1_shipwreck", int64(quest.Completed)) }))
	h.sim.Step()
	// Level 14: the offer shows but there is no accept.
	d := h.lastDialog(h.send(cl, talkMsg(druid.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.bosque_druid.opt_boat"))
	for _, o := range d.Options {
		if o.Text.Key == "dialog.accept" {
			t.Fatal("level 14 can accept Chapter 2")
		}
	}
	h.sim.Command(gameFunc(func() { h.w.SetLevelForTest(p, 15) }))
	h.sim.Step()
	d = h.lastDialog(h.send(cl, talkMsg(druid.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.bosque_druid.opt_boat"))
	if evs := h.pick(cl, d, "dialog.accept"); !messageKeys(evs)["dialog.quest_started"] {
		t.Fatalf("accept: %v", messageKeys(evs))
	}

	// Part 1: toads, glowcaps, ferryman.
	h.sim.Command(gameFunc(func() { arm(); h.w.Teleport(p, pos(37, 44)) }))
	h.huntRested(cl, p, "mire_toad", 8)
	if _, step := h.w.QuestState(p, "ch2_roots"); step != "gather_glowcaps" {
		t.Fatalf("after eight toads the step is %q", step)
	}
	// Five glowcaps are not enough, and the ferryman has nothing to say yet.
	h.sim.Command(gameFunc(func() {
		h.w.Teleport(p, pos(20, 12))
		h.w.GiveForTest(p, "glowcap", max(0, 5-h.w.CountItem(p, "glowcap")))
	}))
	h.sim.Step()
	cl.take()
	if _, step := h.w.QuestState(p, "ch2_roots"); step != "gather_glowcaps" {
		t.Fatalf("with five glowcaps the step is %q", step)
	}
	for _, o := range h.lastDialog(h.send(cl, talkMsg(ferryman.ID()))).Options {
		if o.Text.Key == "npc.bosque_ferryman.opt_ch2_boat" {
			t.Fatal("the ferryman answers before the lantern")
		}
	}
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "glowcap", 1) }))
	h.sim.Step()
	cl.take()
	if _, step := h.w.QuestState(p, "ch2_roots"); step != "deliver_glowcaps" {
		t.Fatalf("with six glowcaps the step is %q", step)
	}
	d = h.lastDialog(h.send(cl, talkMsg(druid.ID())))
	if d = h.lastDialog(h.pick(cl, d, "npc.bosque_druid.opt_give_glowcaps")); d.Text.Key != "npc.bosque_druid.ch2_lantern" || h.w.CountItem(p, "glowcap") != 0 {
		t.Fatalf("deliver: %s, %d glowcaps left", d.Text.Key, h.w.CountItem(p, "glowcap"))
	}
	money, xp := h.w.Money(p), p.Experience()
	d = h.lastDialog(h.send(cl, talkMsg(ferryman.ID())))
	if evs := h.pick(cl, d, "npc.bosque_ferryman.opt_ch2_boat"); !messageKeys(evs)["dialog.quest_completed"] {
		t.Fatalf("ferryman: %v", messageKeys(evs))
	}
	if s, _ := h.w.QuestState(p, "ch2_roots"); s != quest.Completed || h.w.Money(p)-money != 300 || p.Experience()-xp != 3500 {
		t.Fatalf("part 1: %v, +%d coins, +%d xp", s, h.w.Money(p)-money, p.Experience()-xp)
	}

	// Part 2 needs level 20.
	h.sim.Command(gameFunc(func() { h.w.SetLevelForTest(p, 19) }))
	h.sim.Step()
	d = h.lastDialog(h.send(cl, talkMsg(druid.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.bosque_druid.opt_camp"))
	for _, o := range d.Options {
		if o.Text.Key == "dialog.accept" {
			t.Fatal("level 19 can accept part 2")
		}
	}
	h.sim.Command(gameFunc(func() { h.w.SetLevelForTest(p, 20) }))
	h.sim.Step()
	d = h.lastDialog(h.send(cl, talkMsg(druid.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.bosque_druid.opt_camp"))
	h.pick(cl, d, "dialog.accept")
	if s, step := h.w.QuestState(p, "ch2_coffer"); s != quest.InProgress || step != "break_camp" {
		t.Fatalf("part 2: %v %q", s, step)
	}
	h.sim.Command(gameFunc(func() { arm(); h.w.Teleport(p, pos(40, 12)) }))
	h.huntRested(cl, p, "coffer_smuggler", 8)
	h.sim.Command(gameFunc(func() {
		h.w.Teleport(p, pos(20, 12))
		h.w.GiveForTest(p, "smuggler_tally", max(0, 4-h.w.CountItem(p, "smuggler_tally")))
	}))
	h.sim.Step()
	cl.take()
	if _, step := h.w.QuestState(p, "ch2_coffer"); step != "deliver_tallies" {
		t.Fatalf("with four tallies the step is %q", step)
	}
	d = h.lastDialog(h.send(cl, talkMsg(druid.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.bosque_druid.opt_progress"))
	h.pick(cl, d, "npc.bosque_druid.opt_give_tallies")
	if _, step := h.w.QuestState(p, "ch2_coffer"); step != "find_coffer" {
		t.Fatalf("after the tallies the step is %q", step)
	}
	// The coffer drops from hollow crawlers in the cave; the drop itself is loot.
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "sealed_coffer", 1) }))
	h.sim.Step()
	cl.take()
	money, xp = h.w.Money(p), p.Experience()
	d = h.lastDialog(h.send(cl, talkMsg(druid.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.bosque_druid.opt_progress"))
	evs := h.pick(cl, d, "npc.bosque_druid.opt_give_coffer")
	if !messageKeys(evs)["dialog.quest_completed"] || h.lastDialog(evs).Text.Key != "npc.bosque_druid.ch2_coffer_opened" {
		t.Fatalf("coffer: %v", messageKeys(evs))
	}
	if h.w.CountItem(p, "sealed_coffer") != 0 || h.w.Money(p)-money != 600 || p.Experience()-xp != 9000 || p.Storage("flag.ember_root_found") != 1 {
		t.Fatalf("rewards: coffer %d, +%d coins, +%d xp", h.w.CountItem(p, "sealed_coffer"), h.w.Money(p)-money, p.Experience()-xp)
	}
	if hasOption("npc.bosque_druid.opt_camp") || hasOption("npc.bosque_druid.opt_progress") {
		t.Fatal("finished chapter still offered")
	}
}

// huntRested is hunt keeping the player at full health the whole time: the test is about
// the quest, not about surviving a pack of eight (TestBosqueBalance covers the fights).
func (h *harness) huntRested(cl *fakeClient, p *session.Player, kind string, n int) {
	h.t.Helper()
	h.input(cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	for killed := 0; killed < n; killed++ {
		// The nearest one, so that it is in view (a pack wanders around its spawn).
		var target *session.Monster
		h.sim.RunUntil(func() bool {
			best := 1 << 30
			for _, m := range h.w.Monsters() {
				if d := max(abs(int(m.Pos().X)-int(p.Pos().X)), abs(int(m.Pos().Y)-int(p.Pos().Y))); m.Kind() == kind && d < best {
					target, best = m, d
				}
			}
			return target != nil
		}, sim.MaxSeconds(120))
		h.input(cl, setTarget(target.ID()))
		h.sim.RunUntil(func() bool {
			h.w.RestoreForTest(p)
			for _, m := range h.w.Monsters() {
				if m == target {
					return false
				}
			}
			return true
		}, sim.MaxSeconds(300))
	}
	h.sim.Step()
}
