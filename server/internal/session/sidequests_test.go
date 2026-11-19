package session_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// The side quests of the Isla del Bosque and the Isla Volcánica (lote 12, docs/02
// "Quests secundarias"), each played from its offer to its rewards with the content of
// data/, in the style of chapter2_test.go.

// Where the side quests' reach steps are on the test map (on the real islands they are
// the smugglers' jetty and the shore of the crater's lava lake: TestRealWorldStarts and
// make validate check those).
var (
	jettyAt  = pos(50, 20)
	craterAt = pos(50, 40)
)

// sideQuestHarness is dataHarness with the side quests' NPCs of Raigal and Brasal placed in
// a row along y = 10 (sideTalk stands two tiles south of one to talk), their reach places
// moved onto the test map and spawns of the monsters they ask for, as many as a test kills
// (a watched spawn does not respawn). The attribute pool is on: the equipable rewards roll.
func sideQuestHarness(t *testing.T) *harness {
	t.Helper()
	return dataHarnessWith(t, func(cfg *session.Config) {
		withAttributes(t)(cfg)
		jetty := cfg.Quests["ferryman_jetty"]
		placeReach(jetty.Steps[jetty.StepIndex("see_jetty")].CompleteWhen.Reach, jettyAt, 2)
		crater := cfg.Quests["flame_crater"]
		placeReach(crater.Steps[crater.StepIndex("reach_heart")].CompleteWhen.Reach, craterAt, 2)
		is := cfg.Map.Islands()[0]
		is.NPCs = append(is.NPCs,
			world.NPCPlacement{NPC: "bosque_ferryman", Pos: pos(20, 10)},
			world.NPCPlacement{NPC: "bosque_merchant", Pos: pos(26, 10)},
			world.NPCPlacement{NPC: "volcan_ferryman", Pos: pos(32, 10)},
			world.NPCPlacement{NPC: "volcan_smith", Pos: pos(38, 10)},
			world.NPCPlacement{NPC: "volcan_priest", Pos: pos(44, 10)},
		)
	},
		world.Spawn{ID: "crawlers", Center: pos(12, 44), Radius: 4, RespawnSeconds: 60,
			Monsters: []world.SpawnMonster{{Monster: "hollow_crawler", Count: 13}}},
		world.Spawn{ID: "salamanders", Center: pos(28, 50), Radius: 4, RespawnSeconds: 60,
			Monsters: []world.SpawnMonster{{Monster: "cinder_salamander", Count: 10}}},
		world.Spawn{ID: "wyrmlings", Center: pos(50, 50), Radius: 3, RespawnSeconds: 60,
			Monsters: []world.SpawnMonster{{Monster: "ember_wyrmling", Count: 6}}},
	)
}

// sideQuester is a player of the side quest tests, with what it needs at hand.
type sideQuester struct {
	h     *harness
	cl    *fakeClient
	p     *session.Player
	items content.Items
}

func newSideQuester(t *testing.T, h *harness, id int64, level int) *sideQuester {
	t.Helper()
	c := session.Character{ID: id, AccountID: id, Name: "Errand", Vocation: "guardian", Level: level, Health: 1000, Mana: 100}
	cl, p := h.joinFresh(c, pos(30, 30))
	items, err := content.LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	return &sideQuester{h: h, cl: cl, p: p, items: items}
}

// talk walks up to npc (two tiles south of it) and opens its dialog.
func (s *sideQuester) talk(npc string) *pb.DialogOpen {
	s.h.t.Helper()
	n := s.h.npc(npc)
	s.h.sim.Command(gameFunc(func() { s.h.w.Teleport(s.p, pos(int(n.Pos().X), int(n.Pos().Y)+2)) }))
	s.h.sim.Step()
	s.cl.take()
	return s.h.lastDialog(s.h.send(s.cl, talkMsg(n.ID())))
}

// offers reports whether npc's greeting shows option key.
func (s *sideQuester) offers(npc, key string) bool {
	s.h.t.Helper()
	return hasOption(s.talk(npc), key)
}

func (s *sideQuester) say(d *pb.DialogOpen, key string) (*pb.DialogOpen, []*pb.ServerMessage) {
	s.h.t.Helper()
	evs := s.h.pick(s.cl, d, key)
	return s.h.lastDialog(evs), evs
}

func (s *sideQuester) setLevel(l int) {
	s.h.sim.Command(gameFunc(func() { s.h.w.SetLevelForTest(s.p, l) }))
	s.h.sim.Step()
	s.cl.take()
}

func (s *sideQuester) give(id string, n int) {
	s.h.sim.Command(gameFunc(func() { s.h.w.GiveForTest(s.p, id, n) }))
	s.h.sim.Step()
	s.cl.take()
}

// take takes n units of item id from the player (as selling them to a shop would).
func (s *sideQuester) take(id string, n int) {
	s.h.sim.Command(gameFunc(func() { s.h.w.TakeForTest(s.p, id, n) }))
	s.h.sim.Step()
	s.cl.take()
}

func (s *sideQuester) step(id string) (quest.State, string) { return s.h.w.QuestState(s.p, id) }

// handInWaits fails unless quest id stays at step and npc's greeting hides the hand-in
// option give and shows help instead: a step done does not go back when the player sells
// what it asked for (docs/06 "Quest"), so the hand-in repeats its has_item.
func (s *sideQuester) handInWaits(npc, id, step, give, help string) {
	s.h.t.Helper()
	d := s.talk(npc)
	if st, at := s.step(id); st != quest.InProgress || at != step || hasOption(d, give) || !hasOption(d, help) {
		s.h.t.Fatalf("%s without what it asks: %v at %q, hand-in shown %v, help shown %v", id, st, at, hasOption(d, give), hasOption(d, help))
	}
}

// accept takes quest id from npc's offer option at the player's level.
func (s *sideQuester) accept(npc, offer, id, first string) {
	s.h.t.Helper()
	d, _ := s.say(s.talk(npc), offer)
	if _, evs := s.say(d, "dialog.accept"); !messageKeys(evs)["dialog.quest_started"] {
		s.h.t.Fatalf("accept %s: %v", id, messageKeys(evs))
	}
	if st, step := s.step(id); st != quest.InProgress || step != first {
		s.h.t.Fatalf("%s accepted: %v at %q", id, st, step)
	}
}

// hunt kills n monsters of kind with the band's weapon, each brought down to a few hit
// points first: the tests are about the quests, and these fresh characters have base skills
// (TestBosqueBalance and TestVolcanBalance have the fights).
func (s *sideQuester) hunt(kind string, n int, weapon, shield string, from world.Pos) {
	h := s.h
	h.t.Helper()
	h.sim.Command(gameFunc(func() { s.p.EquipForTest(s.items[weapon], s.items[shield]); h.w.Teleport(s.p, from) }))
	h.input(s.cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	for range n {
		var target *session.Monster
		h.sim.RunUntil(func() bool {
			best := 1 << 30
			for _, m := range h.w.Monsters() {
				if d := max(abs(int(m.Pos().X)-int(s.p.Pos().X)), abs(int(m.Pos().Y)-int(s.p.Pos().Y))); m.Kind() == kind && d < best {
					target, best = m, d
				}
			}
			return target != nil
		}, sim.MaxSeconds(120))
		h.sim.Command(gameFunc(func() {
			if hp, _ := target.Health(); hp > 10 {
				target.SetHealth(10)
			}
		}))
		h.input(s.cl, setTarget(target.ID()))
		h.sim.RunUntil(func() bool {
			h.w.RestoreForTest(s.p)
			for _, m := range h.w.Monsters() {
				if m == target {
					return false
				}
			}
			return true
		}, sim.MaxSeconds(300))
	}
	h.sim.Step()
	s.cl.take()
}

// rewarded fails unless the quest completed and paid xp and gold since the marks.
func (s *sideQuester) rewarded(id string, xp, money, wantXP, wantGold int64) {
	s.h.t.Helper()
	if st, _ := s.step(id); st != quest.Completed || s.p.Experience()-xp != wantXP || s.h.w.Money(s.p)-money != wantGold {
		s.h.t.Fatalf("%s: %v, +%d xp (want %d), +%d coins (want %d)", id, st, s.p.Experience()-xp, wantXP,
			s.h.w.Money(s.p)-money, wantGold)
	}
}

// Tavin's jetty (ferryman_jetty, level 22, after Chapter 2's ch2_roots: it follows "that
// unflagged boat"): see the smugglers' jetty (a reach step: one tile short of it does not
// count), clear the crawlers of the cave, report to Tavin.
func TestFerrymanJettySideQuest(t *testing.T) {
	h := sideQuestHarness(t)
	s := newSideQuester(t, h, 941, 21)
	h.sim.Command(gameFunc(func() { s.p.SetStorageForTest("quest.ch2_roots", int64(quest.Completed)) }))
	h.sim.Step()
	if s.offers("bosque_ferryman", "npc.bosque_ferryman.opt_jetty") {
		t.Fatal("offered at level 21")
	}
	s.setLevel(22)
	h.sim.Command(gameFunc(func() { s.p.SetStorageForTest("quest.ch2_roots", int64(quest.InProgress)) }))
	h.sim.Step()
	if s.offers("bosque_ferryman", "npc.bosque_ferryman.opt_jetty") {
		t.Fatal("offered before ch2_roots is completed (who never saw the unflagged boat)")
	}
	h.sim.Command(gameFunc(func() { s.p.SetStorageForTest("quest.ch2_roots", int64(quest.Completed)) }))
	h.sim.Step()
	s.accept("bosque_ferryman", "npc.bosque_ferryman.opt_jetty", "ferryman_jetty", "see_jetty")
	if d, _ := s.say(s.talk("bosque_ferryman"), "npc.bosque_ferryman.opt_jetty_help"); d.Text.Key != "npc.bosque_ferryman.jetty_where" {
		t.Fatalf("where is the jetty: %s", d.Text.Key)
	}
	// Crawlers killed before seeing the jetty count for nothing.
	s.hunt("hollow_crawler", 1, "boarding_saber", "elmwood_shield", pos(12, 40))
	h.sim.Command(gameFunc(func() { h.w.Teleport(s.p, pos(int(jettyAt.X)-3, int(jettyAt.Y))) }))
	h.sim.Step()
	if _, step := s.step("ferryman_jetty"); step != "see_jetty" {
		t.Fatalf("three tiles from the jetty the step is %q", step)
	}
	h.input(s.cl, walk(E))
	h.sim.RunFor(time.Second)
	if _, step := s.step("ferryman_jetty"); step != "clear_crawlers" || p0(s.p) != pos(int(jettyAt.X)-2, int(jettyAt.Y)) {
		t.Fatalf("on the jetty (%v) the step is %q", s.p.Pos(), step)
	}
	if d, _ := s.say(s.talk("bosque_ferryman"), "npc.bosque_ferryman.opt_jetty_help"); d.Text.Key != "npc.bosque_ferryman.jetty_crawlers" {
		t.Fatalf("the crawlers' hint: %s", d.Text.Key)
	}
	if s.offers("bosque_ferryman", "npc.bosque_ferryman.opt_jetty_report") {
		t.Fatal("the report before the crawlers")
	}
	s.hunt("hollow_crawler", 11, "boarding_saber", "elmwood_shield", pos(12, 40))
	if _, step := s.step("ferryman_jetty"); step != "clear_crawlers" {
		t.Fatalf("after eleven crawlers (and one before the jetty) the step is %q", step)
	}
	s.hunt("hollow_crawler", 1, "boarding_saber", "elmwood_shield", s.p.Pos())
	if _, step := s.step("ferryman_jetty"); step != "report" {
		t.Fatalf("after twelve crawlers the step is %q", step)
	}
	xp, money := s.p.Experience(), h.w.Money(s.p)
	d, evs := s.say(s.talk("bosque_ferryman"), "npc.bosque_ferryman.opt_jetty_report")
	if d.Text.Key != "npc.bosque_ferryman.jetty_report" || !messageKeys(evs)["dialog.quest_completed"] {
		t.Fatalf("report: %s %v", d.Text.Key, messageKeys(evs))
	}
	s.rewarded("ferryman_jetty", xp, money, 7000, 700)
	if s.offers("bosque_ferryman", "npc.bosque_ferryman.opt_jetty") || !s.offers("bosque_ferryman", "npc.bosque_ferryman.opt_jetty_after") {
		t.Fatal("the quest is offered again, or its aftermath is not")
	}
}

// p0 is p's position (a helper to compare positions in one line).
func p0(p *session.Player) world.Pos { return p.Pos() }

// Gisla's chitin (tanner_chitin, level 25): eight crawler chitin, then four thorn
// heartwoods, handed in together for an antler amulet that rolls its attribute.
func TestTannerChitinSideQuest(t *testing.T) {
	h := sideQuestHarness(t)
	s := newSideQuester(t, h, 942, 24)
	if s.offers("bosque_merchant", "npc.bosque_merchant.opt_chitin") {
		t.Fatal("offered at level 24")
	}
	s.setLevel(25)
	s.accept("bosque_merchant", "npc.bosque_merchant.opt_chitin", "tanner_chitin", "gather_chitin")
	s.give("crawler_chitin", 7)
	if _, step := s.step("tanner_chitin"); step != "gather_chitin" {
		t.Fatalf("with seven chitin the step is %q", step)
	}
	s.give("crawler_chitin", 1)
	s.give("thorn_heartwood", 3)
	if _, step := s.step("tanner_chitin"); step != "gather_heartwood" {
		t.Fatalf("with eight chitin and three heartwoods the step is %q", step)
	}
	if s.offers("bosque_merchant", "npc.bosque_merchant.opt_chitin_give") {
		t.Fatal("the hand-in before the heartwood")
	}
	s.give("thorn_heartwood", 1)
	if _, step := s.step("tanner_chitin"); step != "deliver" {
		t.Fatalf("with everything the step is %q", step)
	}
	// Two chitin sold after the step, then one heartwood: no hand-in until all are back.
	s.take("crawler_chitin", 2)
	s.handInWaits("bosque_merchant", "tanner_chitin", "deliver", "npc.bosque_merchant.opt_chitin_give", "npc.bosque_merchant.opt_chitin_help")
	s.give("crawler_chitin", 2)
	s.take("thorn_heartwood", 1)
	s.handInWaits("bosque_merchant", "tanner_chitin", "deliver", "npc.bosque_merchant.opt_chitin_give", "npc.bosque_merchant.opt_chitin_help")
	s.give("thorn_heartwood", 1)
	xp, money := s.p.Experience(), h.w.Money(s.p)
	d, evs := s.say(s.talk("bosque_merchant"), "npc.bosque_merchant.opt_chitin_give")
	if d.Text.Key != "npc.bosque_merchant.chitin_delivered" || !messageKeys(evs)["dialog.quest_completed"] {
		t.Fatalf("hand-in: %s %v", d.Text.Key, messageKeys(evs))
	}
	if h.w.CountItem(s.p, "crawler_chitin") != 0 || h.w.CountItem(s.p, "thorn_heartwood") != 0 {
		t.Fatal("the hand-in left materials")
	}
	s.rewarded("tanner_chitin", xp, money, 9000, 750)
	amulets := h.w.ItemsForTest(s.p, "antler_amulet")
	if len(amulets) != 1 {
		t.Fatalf("%d antler amulets", len(amulets))
	}
	checkRolled(t, attrPool(t), s.items["antler_amulet"], amulets[0].Mods())
	if s.offers("bosque_merchant", "npc.bosque_merchant.opt_chitin") || s.offers("bosque_merchant", "npc.bosque_merchant.opt_chitin_help") {
		t.Fatal("finished quest still offered")
	}
}

// Nerea's fenders (captain_fenders, level 30): thin the salamanders, bring five ash
// hound pelts.
func TestCaptainFendersSideQuest(t *testing.T) {
	h := sideQuestHarness(t)
	s := newSideQuester(t, h, 943, 29)
	if s.offers("volcan_ferryman", "npc.volcan_ferryman.opt_fenders") {
		t.Fatal("offered at level 29")
	}
	s.setLevel(30)
	s.accept("volcan_ferryman", "npc.volcan_ferryman.opt_fenders", "captain_fenders", "thin_salamanders")
	// Pelts brought early wait for their step.
	s.give("ash_pelt", 5)
	if _, step := s.step("captain_fenders"); step != "thin_salamanders" {
		t.Fatalf("with the pelts first the step is %q", step)
	}
	s.hunt("cinder_salamander", 10, "embersteel_sabre", "embersteel_shield", pos(28, 46))
	if _, step := s.step("captain_fenders"); step != "deliver_pelts" {
		t.Fatalf("after ten salamanders, pelts in the pack, the step is %q", step)
	}
	// A pelt sold after the step: no hand-in until the five are back.
	s.take("ash_pelt", 1)
	s.handInWaits("volcan_ferryman", "captain_fenders", "deliver_pelts", "npc.volcan_ferryman.opt_fenders_give", "npc.volcan_ferryman.opt_fenders_help")
	s.give("ash_pelt", 1)
	xp, money := s.p.Experience(), h.w.Money(s.p)
	d, evs := s.say(s.talk("volcan_ferryman"), "npc.volcan_ferryman.opt_fenders_give")
	if d.Text.Key != "npc.volcan_ferryman.fenders_delivered" || !messageKeys(evs)["dialog.quest_completed"] || h.w.CountItem(s.p, "ash_pelt") != 0 {
		t.Fatalf("hand-in: %s %v, %d pelts", d.Text.Key, messageKeys(evs), h.w.CountItem(s.p, "ash_pelt"))
	}
	s.rewarded("captain_fenders", xp, money, 13000, 900)
}

// Bram's ring (smith_ring, level 42): five slag cores to the smith; an ember of the Still
// Flame from Madre Oriela (her option sets the flag of the flag_equals step); the ring,
// which rolls its attribute, from the smith.
func TestSmithRingSideQuest(t *testing.T) {
	h := sideQuestHarness(t)
	s := newSideQuester(t, h, 944, 41)
	if s.offers("volcan_smith", "npc.volcan_smith.opt_ring") || s.offers("volcan_priest", "npc.volcan_priest.opt_quench") {
		t.Fatal("offered at level 41, or the ember without the ring")
	}
	s.setLevel(42)
	s.accept("volcan_smith", "npc.volcan_smith.opt_ring", "smith_ring", "gather_cores")
	if s.offers("volcan_priest", "npc.volcan_priest.opt_quench") {
		t.Fatal("the ember before the cores")
	}
	s.give("slag_core", 5)
	d, _ := s.say(s.talk("volcan_smith"), "npc.volcan_smith.opt_ring_cores")
	if _, step := s.step("smith_ring"); d.Text.Key != "npc.volcan_smith.ring_cores" || step != "quench_ring" || h.w.CountItem(s.p, "slag_core") != 0 {
		t.Fatalf("cores: %s, step %q, %d cores left", d.Text.Key, step, h.w.CountItem(s.p, "slag_core"))
	}
	if s.offers("volcan_smith", "npc.volcan_smith.opt_ring_collect") {
		t.Fatal("the ring before the ember")
	}
	d, _ = s.say(s.talk("volcan_priest"), "npc.volcan_priest.opt_quench")
	if _, step := s.step("smith_ring"); d.Text.Key != "npc.volcan_priest.ring_quenched" || step != "collect_ring" ||
		s.p.Storage("flag.smith_ring_quenched") != 1 {
		t.Fatalf("ember: %s, step %q", d.Text.Key, step)
	}
	if s.offers("volcan_priest", "npc.volcan_priest.opt_quench") {
		t.Fatal("a second ember")
	}
	xp, money := s.p.Experience(), h.w.Money(s.p)
	d, evs := s.say(s.talk("volcan_smith"), "npc.volcan_smith.opt_ring_collect")
	if d.Text.Key != "npc.volcan_smith.ring_done" || !messageKeys(evs)["dialog.quest_completed"] {
		t.Fatalf("ring: %s %v", d.Text.Key, messageKeys(evs))
	}
	s.rewarded("smith_ring", xp, money, 25000, 1500)
	rings := h.w.ItemsForTest(s.p, "obsidian_ring")
	if len(rings) != 1 {
		t.Fatalf("%d obsidian rings", len(rings))
	}
	checkRolled(t, attrPool(t), s.items["obsidian_ring"], rings[0].Mods())
}

// Oriela's crater (flame_crater, level 45): reach the shore of the lava lake, then thin
// the wyrmlings' nest. The quest ends on the last kill, where the player stands: the
// rewards come there (the amulet rolls its attribute), and Oriela thanks you afterwards.
func TestFlameCraterSideQuest(t *testing.T) {
	h := sideQuestHarness(t)
	s := newSideQuester(t, h, 945, 44)
	if s.offers("volcan_priest", "npc.volcan_priest.opt_crater") {
		t.Fatal("offered at level 44")
	}
	s.setLevel(45)
	s.accept("volcan_priest", "npc.volcan_priest.opt_crater", "flame_crater", "reach_heart")
	if d, _ := s.say(s.talk("volcan_priest"), "npc.volcan_priest.opt_crater_help"); d.Text.Key != "npc.volcan_priest.crater_help" {
		t.Fatalf("crater hint: %s", d.Text.Key)
	}
	h.sim.Command(gameFunc(func() { h.w.Teleport(s.p, craterAt) }))
	h.sim.Step()
	if _, step := s.step("flame_crater"); step != "thin_nest" {
		t.Fatalf("at the lava lake the step is %q", step)
	}
	s.hunt("ember_wyrmling", 5, "embersteel_sabre", "embersteel_shield", pos(50, 46))
	if st, step := s.step("flame_crater"); st != quest.InProgress || step != "thin_nest" {
		t.Fatalf("after five wyrmlings: %v at %q", st, step)
	}
	// The rewards come in their written order, the experience first: a player a thousand
	// points short of level 46, with no capacity left, levels up with the quest's
	// experience (the wyrmling's own is not enough), and the amulet and the coins fit the
	// capacity of the new level instead of falling to the floor of the crater.
	bal, err := content.LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	h.sim.Command(gameFunc(func() {
		h.w.GainExperienceForTest(s.p, bal.Experience.TotalFor(46)-1000-s.p.Experience())
		h.w.SetCapacityForTest(s.p, 0)
	}))
	h.sim.Step()
	s.cl.take()
	xp, money := s.p.Experience(), h.w.Money(s.p)
	s.hunt("ember_wyrmling", 1, "embersteel_sabre", "embersteel_shield", s.p.Pos())
	// The last kill's own experience comes with the reward (420 for a wyrmling alone).
	if st, _ := s.step("flame_crater"); st != quest.Completed || h.w.Money(s.p)-money != 1800 ||
		s.p.Experience()-xp < 28000 || s.p.Experience()-xp > 28000+420 || h.w.Level(s.p) != 46 {
		t.Fatalf("the last kill: %v, +%d coins, +%d xp, level %d", st, h.w.Money(s.p)-money, s.p.Experience()-xp, h.w.Level(s.p))
	}
	amulets := h.w.ItemsForTest(s.p, "cinder_amulet")
	if len(amulets) != 1 || len(h.w.GroundAt(s.p.Pos())) != 0 {
		t.Fatalf("%d cinder amulets carried, %d items at the feet", len(amulets), len(h.w.GroundAt(s.p.Pos())))
	}
	checkRolled(t, attrPool(t), s.items["cinder_amulet"], amulets[0].Mods())
	d := s.talk("volcan_priest")
	if hasOption(d, "npc.volcan_priest.opt_crater") || hasOption(d, "npc.volcan_priest.opt_crater_help") {
		t.Fatal("finished quest still offered")
	}
	if d, _ = s.say(d, "npc.volcan_priest.opt_crater_done"); d.Text.Key != "npc.volcan_priest.crater_thanks" {
		t.Fatalf("thanks: %s", d.Text.Key)
	}
}
