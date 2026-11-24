package content

import (
	"path/filepath"
	"testing"
)

// A monster's pursuit and regen blocks override balance.yaml field by field; a field it
// leaves out keeps the default (docs/06-content-data.md "Monstruo").
func TestMonsterPursuitResolve(t *testing.T) {
	m, err := ParseMonster([]byte("id: x\nhealth: 5\nspeed: 100\n" +
		"pursuit: { persistence: 0.9, give_up_below_hp_pct: 40 }\nregen: { pct: 0.5 }"))
	if err != nil {
		t.Fatal(err)
	}
	def := Pursuit{Persistence: 0.5, MaxChaseTiles: 16, LoseSightMs: 4000, RollMs: 3000, InsistTargetHpPct: 25, MemoryMs: 1}
	want := def
	want.Persistence, want.GiveUpBelowHpPct = 0.9, 40
	if got := m.Pursuit.Resolve(def); got != want {
		t.Errorf("pursuit = %+v, want %+v", got, want)
	}
	if got := m.Regen.Resolve(MonsterRegenRate{DelayMs: 10000, IntervalMs: 5000, Pct: 1}); got != (MonsterRegenRate{DelayMs: 10000, IntervalMs: 5000, Pct: 0.5}) {
		t.Errorf("regen = %+v", got)
	}
	none := &Monster{}
	if got := none.Pursuit.Resolve(def); got != def {
		t.Errorf("no pursuit block: %+v, want the defaults", got)
	}
}

func TestMonsterPursuitErrors(t *testing.T) {
	for name, src := range map[string]string{
		"persistence above 1": "pursuit: { persistence: 1.5 }",
		"negative cap":        "pursuit: { max_chase_tiles: -1 }",
		"cap across the map":  "pursuit: { max_chase_tiles: 41 }",
		"negative sight":      "pursuit: { lose_sight_ms: -5 }",
		"give up above 100":   "pursuit: { give_up_below_hp_pct: 101 }",
		"regen above 100":     "regen: { pct: 101 }",
		"regen every 0":       "regen: { pct: 1, interval_ms: 0 }",
	} {
		if _, err := ParseMonster([]byte("id: x\nhealth: 5\nspeed: 100\n" + src)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	for name, c := range map[string]Combat{
		"persistence without roll_ms": {MonsterPursuit: Pursuit{Persistence: 0.5}},
		"negative memory":             {MonsterPursuit: Pursuit{MemoryMs: -1}},
		"negative stray":              {MonsterStrayMs: -1},
	} {
		if c.MonsterPursuit.check() == nil && c.MonsterRegen.check() == nil && c.MonsterStrayMs >= 0 {
			t.Errorf("%s: accepted", name)
		}
	}
}

// The repo's defaults (data/balance.yaml): a full heal takes several minutes, a chase has a
// cap and the wolves of data/monsters chase harder than the slow beasts and the boss.
func TestPursuitRepoData(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "data")
	b, err := LoadBalance(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := b.Combat
	if r := c.MonsterRegen; r.Pct <= 0 || float64(r.IntervalMs)*100/r.Pct < 5*60*1000 || r.DelayMs < 5000 {
		t.Errorf("monster_regen %+v: want a full heal of 5 minutes or more, after 5 s or more without a fight", r)
	}
	if p := c.MonsterPursuit; p.MaxChaseTiles <= 0 || p.Persistence <= 0 || p.LoseSightMs <= 0 || p.MemoryMs <= 0 {
		t.Errorf("monster_pursuit %+v", p)
	}
	ms, err := LoadMonsters(dir)
	if err != nil {
		t.Fatal(err)
	}
	wolf := ms["wolf"].Pursuit.Resolve(c.MonsterPursuit)
	golem := ms["slag_golem"].Pursuit.Resolve(c.MonsterPursuit)
	boss := ms["slagbound_warden"].Pursuit.Resolve(c.MonsterPursuit)
	if wolf.Persistence <= c.MonsterPursuit.Persistence || golem.Persistence >= c.MonsterPursuit.Persistence || boss.Persistence != 0 {
		t.Errorf("persistence: wolf %v, slag golem %v, warden %v (default %v)", wolf.Persistence, golem.Persistence, boss.Persistence, c.MonsterPursuit.Persistence)
	}
}
