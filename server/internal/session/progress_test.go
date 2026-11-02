package session_test

import (
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/skills"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Deterministic simulation scenarios of T1.7: skills rise with use, the shield respects
// its per-round cap, wolves bring levels, regeneration ticks, and skills feed damage.

func testItem(t *testing.T, src string) *content.Item {
	t.Helper()
	var it content.Item
	if err := yaml.Unmarshal([]byte(src), &it); err != nil {
		t.Fatal(err)
	}
	return &it
}

// dummyDef is a passive monster that never fights back and barely dies.
func dummyDef() *content.Monster {
	return &content.Monster{ID: "dummy", Health: 1_000_000, Experience: 0, Speed: 100}
}

// peckerDef attacks four times per attack round for no damage.
func peckerDef() *content.Monster {
	return &content.Monster{ID: "pecker", Health: 1000, Speed: 100,
		Behavior: content.MonsterBehavior{Aggressive: true, TargetDistance: 1},
		Attacks:  []content.MonsterAttack{{Type: "melee", Element: "physical", Min: 0, Max: 0, IntervalMs: 500, Chance: 1}},
	}
}

func skillMsgs(evs []*pb.ServerMessage) []*pb.PlayerSkills {
	return find(evs, (*pb.ServerMessage).GetPlayerSkills)
}

func systemKeys(evs []*pb.ServerMessage) map[string]int {
	out := map[string]int{}
	for _, m := range find(evs, (*pb.ServerMessage).GetChatMessage) {
		out[m.GetLocalized().GetKey()]++
	}
	return out
}

// A guardian swinging a sword at a dummy trains sword (not fists): every swing is a try,
// and at 45 tries (base_tries × 1.11^0) sword reaches level 11, which the client hears.
func TestSkillRisesWithUse(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{dummyDef()}, spawnAt("dummy", 20, 20, 0, 60))
	cl, p := h.join("Squire", at(21, 20))
	p.EquipForTest(testItem(t, "{id: test_sword, kind: weapon, weapon: {type: sword, attack: 13}}"), nil)
	h.sim.Step()
	h.input(cl, setTarget(onlyMonster(t, h).ID()))
	h.sim.RunUntil(func() bool { return h.w.Skill(p, "sword").Level == 11 }, sim.MaxSeconds(120))
	h.sim.Step()
	if s := h.w.Skill(p, "sword"); s.Tries != 0 {
		t.Errorf("sword after level up = %+v, want 0 tries", s)
	}
	if f := h.w.Skill(p, "fist"); f.Level != 10 || f.Tries != 0 {
		t.Errorf("fist trained with a sword: %+v", f)
	}
	evs := cl.take()
	if systemKeys(evs)["progress.skill_up"] != 1 {
		t.Errorf("skill_up messages: %v", systemKeys(evs))
	}
	sk := skillMsgs(evs)
	if len(sk) == 0 {
		t.Fatal("no PlayerSkills sent")
	}
	for _, s := range sk[len(sk)-1].GetSkills() {
		if s.GetSkillId() == "sword" && (s.GetLevel() != 11 || s.GetPercent() != 0) {
			t.Errorf("last sword progress %v", s)
		}
	}
	// Halfway through level 11 (50 tries) the percent is reported.
	h.sim.RunUntil(func() bool { return h.w.Skill(p, "sword").Tries == 25 }, sim.MaxSeconds(120))
	h.sim.Step()
	sk = skillMsgs(cl.take())
	for _, s := range sk[len(sk)-1].GetSkills() {
		if s.GetSkillId() == "sword" && s.GetPercent() != 50 {
			t.Errorf("sword at 25/50 tries reports %d %%", s.GetPercent())
		}
	}
}

// Training against a target that never fights back earns a quarter of the tries after
// skills.afk.after_ms (10 min), and the client cannot reset that by re-targeting it.
func TestTrainingAgainstPassiveTargetSlowsDown(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{dummyDef()}, spawnAt("dummy", 20, 20, 0, 60))
	cl, p := h.join("Idler", at(21, 20))
	h.sim.Step()
	h.input(cl, setTarget(onlyMonster(t, h).ID()))
	tries := func() int64 {
		s := h.w.Skill(p, "fist")
		total := s.Tries
		for l := 10; l < s.Level; l++ {
			total += skills.TriesFor(content.SkillBase{StartLevel: 10, BaseTries: 45}, 1.13, l)
		}
		return total
	}
	h.sim.RunFor(10 * time.Minute) // ten minutes: one try per 2 s round
	before := tries()
	if before < 295 || before > 301 {
		t.Fatalf("tries in the first 10 min = %d, want ~300", before)
	}
	// Four more minutes: 120 rounds at 0.25. Dropping and re-sending the same target
	// every minute must not restart the anti-AFK clock.
	id := onlyMonster(t, h).ID()
	for range 4 {
		h.input(cl, setTarget(0))
		h.input(cl, setTarget(id))
		h.sim.RunFor(time.Minute)
	}
	if got := tries() - before; got < 28 || got > 32 {
		t.Errorf("tries in 4 AFK minutes = %d, want ~30", got)
	}
}

// Four monsters peck a shielded player every 500 ms (16 attacks per 2 s round), but the
// shield earns at most skills.shield_max_tries_per_round (2) tries per round.
func TestShieldTriesCappedPerRound(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{peckerDef()},
		spawnAt("pecker", 19, 20, 0, 60), spawnAt("pecker", 21, 20, 0, 60),
		spawnAt("pecker", 20, 19, 0, 60), spawnAt("pecker", 20, 21, 0, 60))
	_, p := h.join("Wall", at(20, 20))
	p.EquipForTest(nil, testItem(t, "{id: test_shield, kind: shield, shield: {defense: 10}}"))
	const rounds = 20
	h.sim.RunTicks(rounds * 40) // attack_interval_ms 2000 = 40 ticks
	got := h.w.Skill(p, "shield").Tries
	if got > 2*(rounds+1) || got < 2*(rounds-3) {
		t.Errorf("shield tries in %d rounds = %d, want about %d", rounds, got, 2*rounds)
	}
	if f := h.w.Skill(p, "fist"); f.Tries != 0 {
		t.Errorf("fist trained without attacking: %+v", f)
	}
}

// Without a shield, being attacked trains nothing.
func TestNoShieldNoShieldTries(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{peckerDef()}, spawnAt("pecker", 19, 20, 0, 60))
	_, p := h.join("Bare", at(20, 20))
	h.sim.RunTicks(400)
	if s := h.w.Skill(p, "shield"); s.Tries != 0 {
		t.Errorf("shield tries without a shield = %d", s.Tries)
	}
}

// A guardian hunting wolves reaches level 3 (144 XP, ~6 wolves): every new level adds
// the vocation's per-level stats and tells the client.
func TestLevelUpKillingWolves(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{wolfDef()}, spawnAt("wolf", 20, 20, 1, 1))
	cl, p := h.join("Hunter", at(23, 20))
	p.EquipForTest(testItem(t, "{id: test_sword, kind: weapon, weapon: {type: sword, attack: 13}}"), nil)
	h.input(cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	var levels []uint32
	h.sim.RunUntil(func() bool {
		if p.Target() == 0 {
			for _, m := range h.w.Monsters() {
				if p.Knows(m.ID()) {
					h.input(cl, setTarget(m.ID()))
				}
			}
		}
		for _, st := range find(cl.take(), (*pb.ServerMessage).GetPlayerStats) {
			if len(levels) == 0 || levels[len(levels)-1] != st.GetLevel() {
				levels = append(levels, st.GetLevel())
			}
		}
		// Spawns do not respawn in sight of a player: step away after each kill and
		// come back when the wolf is back.
		near := chebyshev(p.Pos(), pos(20, 20)) < 20
		if wolves := len(h.w.Monsters()); wolves == 0 && near {
			h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(55, 55)) }))
		} else if wolves > 0 && !near {
			h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(23, 20)) }))
		}
		return h.w.Level(p) >= 3
	}, sim.MaxSeconds(30*60))
	h.sim.Step()
	for _, st := range find(cl.take(), (*pb.ServerMessage).GetPlayerStats) {
		if levels[len(levels)-1] != st.GetLevel() {
			levels = append(levels, st.GetLevel())
		}
	}
	if p.Experience() < 144 || h.w.Level(p) != 3 {
		t.Fatalf("level %d with %d XP", h.w.Level(p), p.Experience())
	}
	if len(levels) < 3 || levels[0] != 1 || levels[len(levels)-1] != 3 {
		t.Errorf("PlayerStats levels %v", levels)
	}
	want := testVocations["guardian"].AtLevel(3)
	_, maxHealth := p.Health()
	if maxHealth != want.Health || p.Speed() != want.Speed {
		t.Errorf("level 3: max health %d speed %d, want %+v", maxHealth, p.Speed(), want)
	}
	if s := h.w.Skill(p, "sword"); s.Level == 10 && s.Tries == 0 {
		t.Error("sword never trained while hunting")
	}
}

// Every regen.interval_ms (7 s) a guardian recovers regen.health and regen.mana, up to
// its maximum, and its client hears about it.
func TestRegeneration(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	cl, p := h.joinChar(session.Character{ID: 9001, AccountID: 9001, Name: "Weary", Vocation: "guardian",
		Level: 1, Health: 100, Mana: 18, HasPos: true, Pos: pos(10, 10)})
	cl.take()
	h.sim.RunTicks(7000/50 - 1)
	if hp, _ := p.Health(); hp != 100 {
		t.Fatalf("health %d before the first interval", hp)
	}
	h.sim.RunTicks(1)
	if hp, _ := p.Health(); hp != 103 || h.w.Mana(p) != 19 {
		t.Fatalf("after 7 s: health %d mana %d, want 103 and 19", hp, h.w.Mana(p))
	}
	h.sim.RunTicks(2 * 7000 / 50)
	if hp, _ := p.Health(); hp != 109 || h.w.Mana(p) != 20 {
		t.Errorf("after 21 s: health %d mana %d, want 109 and 20 (max)", hp, h.w.Mana(p))
	}
	h.sim.Step()
	if st := find(cl.take(), (*pb.ServerMessage).GetPlayerStats); len(st) != 3 || st[2].GetHealth() != 109 {
		t.Errorf("PlayerStats %v", st)
	}
	// Full: regeneration stays quiet.
	h.sim.RunTicks(20 * 7000 / 50)
	cl.take()
	h.sim.RunTicks(7000/50 + 1)
	if hp, mx := p.Health(); hp != mx {
		t.Fatalf("health %d/%d after long rest", hp, mx)
	}
	if st := find(cl.take(), (*pb.ServerMessage).GetPlayerStats); len(st) != 0 {
		t.Errorf("PlayerStats while full: %v", st)
	}
}

// Higher skill means harder hits: the same swings against the same dummy deal more
// damage at sword 60 than at sword 10.
func TestSkillRaisesDamage(t *testing.T) {
	dealt := func(skill int) int {
		h := monsterHarness(t, []*content.Monster{dummyDef()}, spawnAt("dummy", 20, 20, 0, 60))
		cl, p := h.joinChar(session.Character{ID: 9100 + int64(skill), AccountID: 1, Name: "Duelist", Vocation: "guardian",
			Level: 1, Health: 145, HasPos: true, Pos: pos(21, 20),
			Skills: []session.SkillState{{ID: "sword", Level: skill}}})
		p.EquipForTest(testItem(t, "{id: test_sword, kind: weapon, weapon: {type: sword, attack: 13}}"), nil)
		h.sim.Step()
		m := onlyMonster(t, h)
		h.input(cl, setTarget(m.ID()))
		h.sim.RunTicks(30 * 40)
		return 1_000_000 - h.w.MonsterHealth(m)
	}
	low, high := dealt(10), dealt(60)
	if high < 3*low {
		t.Errorf("30 rounds: sword 10 dealt %d, sword 60 dealt %d", low, high)
	}
}

// Skills travel in snapshots and come back on the next login, even before the
// database acknowledged the final save.
func TestSkillsSavedAndRestored(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{dummyDef()}, spawnAt("dummy", 20, 20, 0, 60))
	c := session.Character{ID: 9200, AccountID: 9200, Name: "Keeper", Vocation: "guardian", Level: 1, Health: 145,
		HasPos: true, Pos: pos(21, 20), Skills: []session.SkillState{{ID: "fist", Level: 12, Tries: 4}, {ID: "gone", Level: 99}}}
	cl, p := h.joinChar(c)
	h.sim.Step()
	h.input(cl, setTarget(onlyMonster(t, h).ID()))
	h.sim.RunTicks(3 * 40)
	want := h.w.Skill(p, "fist")
	if want.Level != 12 || want.Tries <= 4 {
		t.Fatalf("fist after training %+v", want)
	}
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	last := h.saves[len(h.saves)-1]
	if !last.Final || len(last.Skills) != 3 {
		t.Fatalf("final snapshot %+v", last)
	}
	for _, s := range last.Skills {
		if s.ID == "fist" && s != want {
			t.Errorf("snapshot fist %+v, want %+v", s, want)
		}
		if s.ID == "gone" {
			t.Error("unknown skill saved")
		}
	}
	c.Skills = nil // the database row is older: the unsaved snapshot wins
	_, p = h.joinChar(c)
	if got := h.w.Skill(p, "fist"); got != want {
		t.Errorf("after re-login fist %+v, want %+v", got, want)
	}
}
