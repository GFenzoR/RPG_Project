package session_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// tutorialHarness runs the real data/tutorial.yaml on dataHarness's map (its island is
// "test", so the tutorial is moved there) with a bilge rat at (30, 30).
func tutorialHarness(t *testing.T) *harness {
	t.Helper()
	return tutorialHarnessWith(t, nil)
}

// tutorialHarnessWith is tutorialHarness with a last change to the config; it also has
// the spells of data/spells.yaml.
func tutorialHarnessWith(t *testing.T, edit func(*session.Config)) *harness {
	t.Helper()
	dir := filepath.Join("..", "..", "..", "data")
	tut, err := content.LoadTutorial(dir)
	if err != nil || tut == nil {
		t.Fatalf("tutorial: %v", err)
	}
	spells, err := content.LoadSpells(dir)
	if err != nil {
		t.Fatal(err)
	}
	moved := *tut
	moved.Island = "test"
	return dataHarnessWith(t, func(c *session.Config) {
		c.Tutorial, c.Spells = &moved, spells
		if edit != nil {
			edit(c)
		}
	},
		world.Spawn{ID: "rat", Center: pos(30, 30), Radius: 0, RespawnSeconds: 600,
			Monsters: []world.SpawnMonster{{Monster: "bilge_rat", Count: 1}}})
}

// newcomer is a character that never played: like a new row of characters, it has no
// town yet and wakes up on the start island (the map's only island, "test").
func newcomer(id int64, vocation string) session.Character {
	return session.Character{ID: id, AccountID: id, Name: "Newcomer", Vocation: vocation, Level: 1, Health: 145, Mana: 20}
}

func lastTutorial(evs []*pb.ServerMessage) *pb.TutorialStep {
	ts := find(evs, (*pb.ServerMessage).GetTutorialStep)
	if len(ts) == 0 {
		return nil
	}
	return ts[len(ts)-1]
}

func skipMsg() *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_TutorialSkip{TutorialSkip: &pb.TutorialSkip{}}}
}

// runFor runs d of game time and returns every message cl got.
func (h *harness) runFor(cl *fakeClient, d time.Duration) []*pb.ServerMessage {
	var evs []*pb.ServerMessage
	for range int(d / (50 * time.Millisecond)) {
		h.sim.Step()
		evs = append(evs, cl.take()...)
	}
	return evs
}

// expectStep fails unless ts is the active step id with progress.
func expectStep(t *testing.T, ts *pb.TutorialStep, id string, progress uint32) {
	t.Helper()
	if ts == nil || ts.State != pb.TutorialState_TUTORIAL_STATE_ACTIVE || ts.StepId != id || ts.Progress != progress {
		t.Fatalf("tutorial = %v, want %s at %d", ts, id, progress)
	}
}

// A new guardian plays the whole tutorial: every step advances with its server event
// (the spell step is only for arcanists and druids, so it is skipped), it ends when the
// harbor master's Chapter 1 quest starts, and the reward is given once.
func TestTutorialPlaythrough(t *testing.T) {
	h := tutorialHarness(t)
	cl, p := h.joinChar(newcomer(950, "guardian"))
	ts := lastTutorial(cl.take())
	expectStep(t, ts, "first_steps", 0)
	if ts.Text.GetKey() != "tutorial.step.first_steps" || ts.Count != 5 || ts.Index != 0 || ts.Total != 6 {
		t.Fatalf("first step %v", ts)
	}

	// Walk: each step counts, the fifth completes it.
	h.input(cl, walkPath(pb.Direction_DIRECTION_EAST, pb.Direction_DIRECTION_EAST, pb.Direction_DIRECTION_EAST,
		pb.Direction_DIRECTION_EAST))
	expectStep(t, lastTutorial(h.runFor(cl, 3*time.Second)), "first_steps", 4)
	h.input(cl, walk(pb.Direction_DIRECTION_SOUTH))
	expectStep(t, lastTutorial(h.runFor(cl, time.Second)), "meet_priestess", 0)

	// Talking to another NPC does not count; the priestess does. A teleport is no walk.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(9, 10)) }))
	h.sim.Step()
	cl.take()
	if ts := lastTutorial(h.send(cl, talkMsg(h.npc("harbor_master").ID()))); ts != nil {
		t.Fatalf("another NPC advanced the tutorial: %v", ts)
	}
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(12, 13)) }))
	h.sim.Step()
	cl.take()
	ts = lastTutorial(h.send(cl, talkMsg(h.npc("puerto_priest").ID())))
	expectStep(t, ts, "open_backpack", 0)
	if ts.Highlight != "inventory" {
		t.Fatalf("highlight %q", ts.Highlight)
	}

	pack := p.Equipped(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK)
	expectStep(t, lastTutorial(h.send(cl, useItem(inSlot(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK), uint32(pack.Def().Numeric), 0))), "pick_target", 0)

	// Target and kill the rat (the guardian skips first_spell).
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(28, 30)) }))
	h.sim.Step()
	cl.take()
	rat := onlyMonster(t, h)
	h.input(cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	expectStep(t, lastTutorial(h.send(cl, setTarget(rat.ID()))), "first_victory", 0)
	h.sim.Command(gameFunc(func() { rat.SetHealth(1) }))
	var evs []*pb.ServerMessage
	h.sim.RunUntil(func() bool {
		evs = append(evs, cl.take()...)
		return len(h.w.Monsters()) == 0
	}, sim.MaxSeconds(30))
	evs = append(evs, cl.take()...)
	expectStep(t, lastTutorial(evs), "harbor_master_task", 0)

	// Accepting the harbor master's quest ends it with the reward.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(9, 10)) }))
	h.sim.Step()
	cl.take()
	money := h.w.Money(p)
	d := h.lastDialog(h.send(cl, talkMsg(h.npc("harbor_master").ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.harbor_master.opt_shipwreck"))
	evs = h.pick(cl, d, "dialog.accept")
	ts = lastTutorial(evs)
	if ts == nil || ts.State != pb.TutorialState_TUTORIAL_STATE_DONE || !hasKey(evs, "tutorial.completed") {
		t.Fatalf("end: %v %v", ts, systemKeys(evs))
	}
	if got := h.w.Money(p) - money; got != 20 { // the guardian's quest reward is a weapon
		t.Fatalf("reward: +%d coins", got)
	}
	if p.TutorialStep(h.w) != "" || p.Storage("tutorial.done") != 1 || p.Storage("tutorial.step") != 0 {
		t.Fatalf("storage after the end: done %d step %d", p.Storage("tutorial.done"), p.Storage("tutorial.step"))
	}
	// Done for good: more events send nothing.
	h.input(cl, walk(pb.Direction_DIRECTION_EAST))
	if ts := lastTutorial(h.runFor(cl, time.Second)); ts != nil {
		t.Fatalf("tutorial after the end: %v", ts)
	}
}

// An arcanist gets the spell step (vocations), between the target and the kill.
func TestTutorialVocationStep(t *testing.T) {
	h := tutorialHarness(t)
	cl, p := h.joinChar(newcomer(951, "arcanist"))
	cl.take()
	// Resume at pick_target (stored step 4 = index 3), next to the rat.
	h.sim.Command(gameFunc(func() { p.SetStorageForTest("tutorial.step", 4) }))
	h.sim.Step()
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	c := newcomer(951, "arcanist")
	c.Storage = h.saves[len(h.saves)-1].Storage
	cl, p = h.joinChar(c)
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(28, 30)) }))
	h.sim.Step()
	rat := onlyMonster(t, h)
	expectStep(t, lastTutorial(cl.take()), "pick_target", 0)
	ts := lastTutorial(h.send(cl, setTarget(rat.ID())))
	expectStep(t, ts, "first_spell", 0)
	if ts.Highlight != "hotbar" || ts.Index != 4 || ts.Total != 7 {
		t.Fatalf("spell step %v", ts)
	}
}

// Skipping ends the tutorial at once, without reward, and it never comes back.
func TestTutorialSkip(t *testing.T) {
	h := tutorialHarness(t)
	cl, p := h.joinChar(newcomer(952, "guardian"))
	cl.take()
	money := h.w.Money(p)
	evs := h.send(cl, skipMsg())
	ts := lastTutorial(evs)
	if ts == nil || ts.State != pb.TutorialState_TUTORIAL_STATE_SKIPPED || !hasKey(evs, "tutorial.skipped") || hasKey(evs, "tutorial.completed") {
		t.Fatalf("skip: %v %v", ts, systemKeys(evs))
	}
	if h.w.Money(p) != money || p.Storage("tutorial.done") != 2 {
		t.Fatalf("skip gave %d coins, done = %d", h.w.Money(p)-money, p.Storage("tutorial.done"))
	}
	if ts := lastTutorial(h.send(cl, skipMsg())); ts != nil {
		t.Fatalf("second skip answered %v", ts)
	}
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	c := newcomer(952, "guardian")
	c.Storage = h.saves[len(h.saves)-1].Storage
	cl, _ = h.joinChar(c)
	if ts := lastTutorial(cl.take()); ts != nil {
		t.Fatalf("skipped tutorial came back: %v", ts)
	}
}

// Logging out and in again resumes the same step with its progress.
func TestTutorialPersists(t *testing.T) {
	h := tutorialHarness(t)
	cl, _ := h.joinChar(newcomer(953, "guardian"))
	cl.take()
	h.input(cl, walkPath(pb.Direction_DIRECTION_EAST, pb.Direction_DIRECTION_EAST))
	expectStep(t, lastTutorial(h.runFor(cl, 2*time.Second)), "first_steps", 2)
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	last := h.saves[len(h.saves)-1]
	if !last.Final || last.Storage["tutorial.step"] != 1 || last.Storage["tutorial.count"] != 2 {
		t.Fatalf("final snapshot storage %v", last.Storage)
	}
	c := newcomer(953, "guardian")
	c.Storage, c.Pos, c.HasPos = last.Storage, last.Pos, true
	cl, _ = h.joinChar(c)
	expectStep(t, lastTutorial(cl.take()), "first_steps", 2)
	h.input(cl, walkPath(pb.Direction_DIRECTION_SOUTH, pb.Direction_DIRECTION_SOUTH, pb.Direction_DIRECTION_SOUTH))
	expectStep(t, lastTutorial(h.runFor(cl, 2*time.Second)), "meet_priestess", 0)
}

// Characters that existed before the tutorial (experience or levels) never get it.
func TestTutorialOnlyNewCharacters(t *testing.T) {
	h := tutorialHarness(t)
	for i, c := range []session.Character{
		{Level: 1, Experience: 40},
		{Level: 3, Experience: 0},
	} {
		id := int64(960 + i)
		c.ID, c.AccountID, c.Name, c.Vocation, c.Health = id, id, "Veteran", "guardian", 145
		cl, p := h.joinChar(c)
		if ts := lastTutorial(cl.take()); ts != nil || p.TutorialStep(h.w) != "" {
			t.Fatalf("%+v got the tutorial: %v", c, ts)
		}
		h.input(cl, walkPath(pb.Direction_DIRECTION_EAST, pb.Direction_DIRECTION_EAST))
		if ts := lastTutorial(h.runFor(cl, time.Second)); ts != nil {
			t.Fatalf("%+v: walking sent %v", c, ts)
		}
	}
}

// Nothing the client sends completes a step: only the server's events do. Messages that
// fail validation (an NPC out of range, an unknown target, a bogus dialog choice) or that
// are not events at all leave the step where it was.
func TestTutorialClientCannotForce(t *testing.T) {
	h := tutorialHarness(t)
	cl, p := h.joinChar(newcomer(970, "guardian"))
	cl.take()
	h.sim.Command(gameFunc(func() {
		p.SetStorageForTest("tutorial.step", 2) // meet_priestess, as a resume
	}))
	h.sim.Step()
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	c := newcomer(970, "guardian")
	c.Storage = h.saves[len(h.saves)-1].Storage
	cl, p = h.joinChar(c)
	expectStep(t, lastTutorial(cl.take()), "meet_priestess", 0)
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(40, 40)) }))
	h.sim.Step()
	cl.take()
	for _, m := range []*pb.ClientMessage{
		talkMsg(h.npc("puerto_priest").ID()), // too far
		setTarget(99999),
		chooseMsg(1, 1),
		{Message: &pb.ClientMessage_Turn{Turn: &pb.Turn{Dir: pb.Direction_DIRECTION_NORTH}}},
		{Message: &pb.ClientMessage_Say{Say: &pb.Say{Text: "hola"}}},
	} {
		if ts := lastTutorial(h.send(cl, m)); ts != nil {
			t.Fatalf("%v advanced the tutorial: %v", m, ts)
		}
	}
	if p.TutorialStep(h.w) != "meet_priestess" || p.Storage("tutorial.count") != 0 {
		t.Fatalf("step %q count %d", p.TutorialStep(h.w), p.Storage("tutorial.count"))
	}
}

// Accepting the harbor master's quest before its step (out of order) does not lock the
// last step: entering it, or resuming at it after a relog, completes it at once.
func TestTutorialQuestStartedEarly(t *testing.T) {
	for _, relog := range []bool{false, true} {
		h := tutorialHarness(t)
		cl, p := h.joinChar(newcomer(980, "guardian"))
		cl.take()
		h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(9, 10)) }))
		h.sim.Step()
		cl.take()
		d := h.lastDialog(h.send(cl, talkMsg(h.npc("harbor_master").ID())))
		d = h.lastDialog(h.pick(cl, d, "npc.harbor_master.opt_shipwreck"))
		h.pick(cl, d, "dialog.accept")
		if p.TutorialStep(h.w) != "first_steps" {
			t.Fatalf("the quest moved the tutorial to %q", p.TutorialStep(h.w))
		}
		money := h.w.Money(p)
		var evs []*pb.ServerMessage
		if relog {
			// Stored at first_victory (index 5 + 1), then back in.
			h.sim.Command(gameFunc(func() { p.SetStorageForTest("tutorial.step", 6) }))
			h.sim.Step()
			h.sim.Command(h.w.Leave(cl))
			h.sim.Step()
			c := newcomer(980, "guardian")
			c.Storage = h.saves[len(h.saves)-1].Storage
			cl, p = h.joinChar(c)
			evs = cl.take()
			expectStep(t, lastTutorial(evs), "first_victory", 0)
			h.sim.Command(gameFunc(func() { p.SetStorageForTest("tutorial.step", 7) }))
			h.sim.Step()
			h.sim.Command(h.w.Leave(cl))
			h.sim.Step()
			c.Storage = h.saves[len(h.saves)-1].Storage
			cl, p = h.joinChar(c)
			evs = cl.take()
		} else {
			// Kill-free path to the last step: the kill step completes with a kill.
			h.sim.Command(gameFunc(func() { p.SetStorageForTest("tutorial.step", 6) }))
			h.sim.Step()
			h.sim.Command(h.w.Leave(cl))
			h.sim.Step()
			c := newcomer(980, "guardian")
			c.Storage = h.saves[len(h.saves)-1].Storage
			cl, p = h.joinChar(c)
			cl.take()
			h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(28, 30)) }))
			h.sim.Step()
			cl.take()
			rat := onlyMonster(t, h)
			h.input(cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
			h.input(cl, setTarget(rat.ID()))
			h.sim.Command(gameFunc(func() { rat.SetHealth(1) }))
			h.sim.RunUntil(func() bool {
				evs = append(evs, cl.take()...)
				return len(h.w.Monsters()) == 0
			}, sim.MaxSeconds(30))
			evs = append(evs, cl.take()...)
		}
		ts := lastTutorial(evs)
		if ts == nil || ts.State != pb.TutorialState_TUTORIAL_STATE_DONE || h.w.Money(p)-money != 20 {
			t.Fatalf("relog %v: %v, +%d coins", relog, ts, h.w.Money(p)-money)
		}
	}
}

// The tutorial island is the home island of a new character (no town) only when it is the
// start island: on a server that starts characters elsewhere, they never get it.
func TestTutorialHomeIsland(t *testing.T) {
	for _, c := range []struct {
		start string
		want  bool
	}{{"", false}, {"other", true}} {
		h := tutorialHarnessWith(t, func(cfg *session.Config) {
			cfg.Map = worldtest.Join(t, []string{"test", "other"}, cfg.Map, worldtest.Open(t, 128, 0, 32, 32))
			cfg.Tutorial.Island = "other"
			cfg.StartTown = c.start
		})
		cl, p := h.joinChar(newcomer(990, "guardian"))
		got := lastTutorial(cl.take()) != nil
		if got != c.want || (p.TutorialStep(h.w) != "") != c.want {
			t.Fatalf("start town %q: tutorial %v, want %v", c.start, got, c.want)
		}
	}
}

// Steps that already hold when they become current complete at once: the backpack the
// hint asks to open is open already (the hinted click would close it), the target is
// already chosen, or the spell that completed first_spell killed the target.
func TestTutorialStepsAlreadyMet(t *testing.T) {
	h := tutorialHarness(t)
	openPack := func(cl *fakeClient, p *session.Player) []*pb.ServerMessage {
		pack := p.Equipped(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK)
		return h.send(cl, useItem(inSlot(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK), uint32(pack.Def().Numeric), 0))
	}
	// resume logs id in at stored step (index + 1).
	resume := func(id int64, step int64) (*fakeClient, *session.Player) {
		cl, p := h.joinChar(newcomer(id, "arcanist"))
		h.sim.Command(gameFunc(func() { p.SetStorageForTest("tutorial.step", step) }))
		h.sim.Step()
		h.sim.Command(h.w.Leave(cl))
		h.sim.Step()
		c := newcomer(id, "arcanist")
		c.Storage = h.saves[len(h.saves)-1].Storage
		cl, p = h.joinChar(c)
		cl.take()
		return cl, p
	}

	// The backpack opened before its step: talking to the priestess skips open_backpack.
	cl, p := resume(991, 2) // meet_priestess
	openPack(cl, p)
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(12, 13)) }))
	h.sim.Step()
	cl.take()
	expectStep(t, lastTutorial(h.send(cl, talkMsg(h.npc("puerto_priest").ID()))), "pick_target", 0)

	// The target chosen before its step: opening the backpack skips pick_target.
	cl, p = resume(992, 3) // open_backpack
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(28, 30)) }))
	h.sim.Step()
	cl.take()
	rat := onlyMonster(t, h)
	h.send(cl, setTarget(rat.ID()))
	expectStep(t, lastTutorial(openPack(cl, p)), "first_spell", 0)

	// The first spell kills the target: first_victory is met in the same tick.
	h.sim.Command(gameFunc(func() { rat.SetHealth(1) }))
	h.sim.Step()
	evs := h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_CastSpell{CastSpell: &pb.CastSpell{Spell: &pb.CastSpell_SpellId{SpellId: "arc_bolt"}}}})
	if len(h.w.Monsters()) != 0 {
		t.Fatalf("the bolt did not kill the rat: %v", systemKeys(evs))
	}
	expectStep(t, lastTutorial(evs), "harbor_master_task", 0)
}
