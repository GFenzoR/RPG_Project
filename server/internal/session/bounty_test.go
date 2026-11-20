package session_test

import (
	"fmt"
	"slices"
	"testing"
	"time"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// The hunting tasks of Ivernel and Cinderstead (lote 12, docs/02 "Tareas"): repeatable kill
// quests of data/quests/bounty_*.yaml that the two hunters give from their boards, every
// 20 hours, played with the content of data/.

// bountyHarness is dataHarness with the two hunters placed on y = 10 and hollow crawlers
// to hunt.
func bountyHarness(t *testing.T) *harness {
	t.Helper()
	return dataHarnessWith(t, func(cfg *session.Config) {
		is := cfg.Map.Islands()[0]
		is.NPCs = append(is.NPCs,
			world.NPCPlacement{NPC: "bosque_hunter", Pos: pos(20, 10)},
			world.NPCPlacement{NPC: "volcan_hunter", Pos: pos(26, 10)},
		)
	}, world.Spawn{ID: "crawlers", Center: pos(12, 44), Radius: 3, RespawnSeconds: 60,
		Monsters: []world.SpawnMonster{{Monster: "hollow_crawler", Count: 3}}})
}

// board opens the board of hunter (bosque_hunter or volcan_hunter).
func (s *sideQuester) board(hunter string) *pb.DialogOpen {
	s.h.t.Helper()
	d, _ := s.say(s.talk(hunter), "npc."+hunter+".opt_board")
	return d
}

// The crawler task of Ivernel with real kills and the real clock: offered from level 22;
// the 30th crawler moves it to the report; the hunter pays what data/ says; then the
// board only shows the wait (and the quest log when it comes back) until 20 hours after
// the hand-in, when it is offered again and starts over from the hunt with no kill counted.
func TestBountyTaskCooldown(t *testing.T) {
	h := bountyHarness(t)
	s := newSideQuester(t, h, 951, 21)
	if hasOption(s.board("bosque_hunter"), "npc.bosque_hunter.opt_crawlers") {
		t.Fatal("the crawler task offered at level 21")
	}
	s.setLevel(22)
	d, _ := s.say(s.board("bosque_hunter"), "npc.bosque_hunter.opt_crawlers")
	if d.Text.Key != "npc.bosque_hunter.crawlers_offer" {
		t.Fatalf("offer: %s", d.Text.Key)
	}
	if d, evs := s.say(d, "dialog.accept"); d.Text.Key != "npc.bosque_hunter.accepted" || !messageKeys(evs)["dialog.quest_started"] {
		t.Fatalf("accept: %s %v", d.Text.Key, messageKeys(evs))
	}
	// In progress the board shows nothing of it (the quest log has the count).
	if hasOption(s.board("bosque_hunter"), "npc.bosque_hunter.opt_crawlers") {
		t.Fatal("the task in progress is on the board")
	}
	h.sim.Command(gameFunc(func() { s.p.SetStorageForTest("quest.bounty_crawlers.kills", 29) }))
	s.hunt("hollow_crawler", 1, "boarding_saber", "elmwood_shield", pos(12, 40))
	if st, step := s.step("bounty_crawlers"); st != quest.InProgress || step != "report" {
		t.Fatalf("after the 30th crawler: %v at %q", st, step)
	}
	xp, money := s.p.Experience(), h.w.Money(s.p)
	d = s.talk("bosque_hunter")
	doneAt := h.sim.Now()
	d, evs := s.say(d, "npc.bosque_hunter.opt_report_crawlers")
	if d.Text.Key != "npc.bosque_hunter.crawlers_paid" || !messageKeys(evs)["dialog.quest_completed"] {
		t.Fatalf("report: %s %v", d.Text.Key, messageKeys(evs))
	}
	s.rewarded("bounty_crawlers", xp, money, 6200, 1450)
	if e := logEntry(t, evs, "bounty_crawlers"); e.GetState() != pb.QuestLogState_QUEST_LOG_STATE_COOLING || !e.GetRepeatable() ||
		e.GetAvailableAt() != uint64(doneAt.Unix()+20*3600)*1000 {
		t.Fatalf("quest log after the hand-in: %v (done at %v)", e, doneAt)
	}
	waits := func() bool {
		d, _ := s.say(s.board("bosque_hunter"), "npc.bosque_hunter.opt_crawlers")
		return d.Text.Key == "npc.bosque_hunter.wait"
	}
	if !waits() {
		t.Fatal("the board offers the task right after its hand-in")
	}
	h.sim.Clock().Advance(19*time.Hour + 59*time.Minute)
	h.sim.Step()
	if !waits() {
		t.Fatal("the board offers the task before 20 hours")
	}
	h.sim.Clock().Advance(time.Minute)
	h.sim.Step()
	if waits() {
		t.Fatal("the task is not back 20 hours after its hand-in")
	}
	d, _ = s.say(s.board("bosque_hunter"), "npc.bosque_hunter.opt_crawlers")
	if _, evs = s.say(d, "dialog.accept"); !messageKeys(evs)["dialog.quest_started"] {
		t.Fatalf("second turn: %v", messageKeys(evs))
	}
	if e := logEntry(t, evs, "bounty_crawlers"); e.GetState() != pb.QuestLogState_QUEST_LOG_STATE_ACTIVE || e.GetStepId() != "hunt" ||
		e.GetKills() != 0 || e.GetKillsNeeded() != 30 || e.GetAvailableAt() != 0 {
		t.Fatalf("quest log of the second turn: %v", e)
	}
}

// Every task of both boards, against data/: hidden below its level and offered from it by
// its hunter, paid exactly its rewards (xp and gold, never an item), every 20 hours. That
// no other NPC gives it (the other hunter's board included) is TestTaskRewards' (sim):
// one NPC alone starts each task.
func TestBountyBoards(t *testing.T) {
	h := bountyHarness(t)
	quests := realQuests(t)
	type task struct{ hunter, prey string }
	tasks := []task{{"bosque_hunter", "smugglers"}, {"bosque_hunter", "thornlings"}, {"bosque_hunter", "crawlers"},
		{"volcan_hunter", "hounds"}, {"volcan_hunter", "golems"}, {"volcan_hunter", "wyrmlings"}}
	slices.SortFunc(tasks, func(a, b task) int {
		return quests["bounty_"+a.prey].MinLevel - quests["bounty_"+b.prey].MinLevel
	})
	s := newSideQuester(t, h, 952, quests["bounty_"+tasks[0].prey].MinLevel-1)
	for _, tk := range tasks {
		id, opt := "bounty_"+tk.prey, fmt.Sprintf("npc.%s.opt_%s", tk.hunter, tk.prey)
		q := quests[id]
		if q == nil || q.Repeatable == nil || q.Repeatable.CooldownHours != 20 {
			t.Fatalf("%s: not a 20-hour task", id)
		}
		var xp, gold int64
		for _, r := range q.Rewards {
			if r.Item != "" || r.SetFlag != nil {
				t.Fatalf("%s rewards %+v: tasks pay experience and gold only", id, r)
			}
			xp, gold = xp+r.XP, gold+r.Gold
		}
		if hasOption(s.board(tk.hunter), opt) {
			t.Fatalf("%s offered below level %d", id, q.MinLevel)
		}
		s.setLevel(q.MinLevel)
		d, _ := s.say(s.board(tk.hunter), opt)
		if d.Text.Key != fmt.Sprintf("npc.%s.%s_offer", tk.hunter, tk.prey) {
			t.Fatalf("%s offer: %s", id, d.Text.Key)
		}
		s.say(d, "dialog.accept")
		if st, step := s.step(id); st != quest.InProgress || step != "hunt" {
			t.Fatalf("%s accepted: %v at %q", id, st, step)
		}
		// The hunt itself is TestBountyTaskCooldown's (and the kill steps', quest_test.go).
		h.sim.Command(gameFunc(func() { s.p.SetStorageForTest("quest."+id+".step", int64(q.StepIndex("report"))) }))
		h.sim.Step()
		before, money := s.p.Experience(), h.w.Money(s.p)
		d, _ = s.say(s.talk(tk.hunter), fmt.Sprintf("npc.%s.opt_report_%s", tk.hunter, tk.prey))
		if d.Text.Key != fmt.Sprintf("npc.%s.%s_paid", tk.hunter, tk.prey) {
			t.Fatalf("%s report: %s", id, d.Text.Key)
		}
		s.rewarded(id, before, money, xp, gold)
		if d, _ := s.say(s.board(tk.hunter), opt); d.Text.Key != fmt.Sprintf("npc.%s.wait", tk.hunter) {
			t.Fatalf("%s right after its hand-in: %s", id, d.Text.Key)
		}
	}
	h.sim.Clock().Advance(20 * time.Hour)
	h.sim.Step()
	for _, tk := range tasks {
		if d, _ := s.say(s.board(tk.hunter), fmt.Sprintf("npc.%s.opt_%s", tk.hunter, tk.prey)); d.Text.Key != fmt.Sprintf("npc.%s.%s_offer", tk.hunter, tk.prey) {
			t.Fatalf("bounty_%s 20 hours later: %s", tk.prey, d.Text.Key)
		}
	}
}
