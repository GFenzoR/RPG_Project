package sim_test

import (
	"math"
	"math/rand/v2"
	"slices"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/combat"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

// foe is the monster side of the Monte Carlo duels (balance_test.go and the careers of
// balance_vocations_test.go), with the server's rules (session/monster.go, abilities.go):
//   - each attack on its own timer, the first round one interval into the fight, then its
//     chance, as before the abilities;
//   - an attack with an area hits the hunter as one aimed at it would: in a duel the
//     hunter stands next to the monster, so on the line of any beam and inside any circle;
//   - below_hp_pct, heal_self (not at full health) and summon (not with max_alive alive)
//     wait for their reason without spending their round, as on the server;
//   - its phases: their attacks_add and attack_interval_mult (a duel stands still, so
//     speed_mult does not count);
//   - the monsters it summons hit the hunter too, and the hunter kills them first (they
//     give nothing): the hunter's hits land on the oldest summon alive (cur, target).
type foe struct {
	m       *content.Monster
	all     content.Monsters
	c       content.Combat
	r       *rand.Rand
	hp      int
	attacks []foeAttack
	summons []*foe
	// from is the index of the summoner's attack that called it (-1 for none).
	from int
	// protect is the hunter's mean protection % by element (its kit's attributes,
	// gear_test.go): an elemental hit loses that share, as the server rounds it.
	protect map[string]float64
}

type foeAttack struct {
	a     *content.MonsterAttack
	phase int // 0: its own; n: of phase n's attacks_add
	next  int // time of its next round; math.MaxInt while dormant
}

func newFoe(m *content.Monster, all content.Monsters, c content.Combat, r *rand.Rand) *foe {
	f := &foe{m: m, all: all, c: c, r: r, from: -1}
	for i := range m.Attacks {
		f.attacks = append(f.attacks, foeAttack{a: &m.Attacks[i]})
	}
	for p := range m.Phases {
		for i := range m.Phases[p].AttacksAdd {
			f.attacks = append(f.attacks, foeAttack{a: &m.Phases[p].AttacksAdd[i], phase: p + 1})
		}
	}
	return f
}

// start begins a fight at time now: full health, no summons, the first round of each
// attack it may use one interval in; the others (a phase's, one below a health it has not
// reached, a heal at full health) wait for their reason, and then go at once, as on the
// server.
func (f *foe) start(now int) {
	f.hp = f.m.Health
	f.summons = f.summons[:0]
	for i := range f.attacks {
		a := &f.attacks[i]
		a.next = math.MaxInt
		if f.usable(i) {
			a.next = now + a.a.IntervalMs
		}
	}
}

func (f *foe) alive() bool { return f.hp > 0 }

// phase is how many of its phases are on (they are sorted from the highest below_hp_pct).
func (f *foe) phase() int {
	n := 0
	for n < len(f.m.Phases) && f.below(f.m.Phases[n].BelowHealthPct) {
		n++
	}
	return n
}

func (f *foe) below(pct int) bool { return pct == 0 || f.hp*100 < pct*f.m.Health }

// usable reports whether attack i may be used now.
func (f *foe) usable(i int) bool {
	a := f.attacks[i]
	if a.phase > f.phase() || !f.below(a.a.BelowHealthPct) {
		return false
	}
	switch a.a.Type {
	case content.AttackHealSelf:
		return f.hp < f.m.Health
	case content.AttackSummon:
		return f.called(i) < a.a.Summon.MaxAlive
	}
	return true
}

func (f *foe) called(i int) int {
	n := 0
	for _, s := range f.summons {
		if s.from == i {
			n++
		}
	}
	return n
}

// interval is attack i's interval with the phases on now.
func (f *foe) interval(i int) int {
	mult := 1.0
	for p := range f.phase() {
		mult *= f.m.Phases[p].AttackIntervalMult
	}
	return max(int(math.Round(float64(f.attacks[i].a.IntervalMs)*mult)), 50)
}

// wake gives a round at now to every dormant attack that has its reason back.
func (f *foe) wake(now int) {
	for i := range f.attacks {
		if f.attacks[i].next == math.MaxInt && f.usable(i) {
			f.attacks[i].next = now
		}
	}
}

// nextAt is the time of the next round of the foe or one of its summons.
func (f *foe) nextAt() int {
	t := math.MaxInt
	for _, a := range f.attacks {
		t = min(t, a.next)
	}
	for _, s := range f.summons {
		t = min(t, s.nextAt())
	}
	return t
}

// act runs every round due at now (its own, then its summons') and returns the damage
// the hunter (player) takes.
func (f *foe) act(now int, player combat.PlayerTarget) int {
	dmg := 0
	for i := range f.attacks {
		a := &f.attacks[i]
		if a.next > now {
			continue
		}
		if !f.usable(i) {
			a.next = math.MaxInt // dormant until wake
			continue
		}
		a.next += f.interval(i)
		if f.r.Float64() >= a.a.Chance {
			continue
		}
		switch a.a.Type {
		case content.AttackHealSelf:
			f.hp = min(f.m.Health, f.hp+combat.Roll(f.r, a.a.Min, a.a.Max))
		case content.AttackSummon:
			s := a.a.Summon
			for range min(s.Count, s.MaxAlive-f.called(i)) {
				c := newFoe(f.all[s.Monster], f.all, f.c, f.r)
				c.from = i
				c.start(now)
				f.summons = append(f.summons, c)
			}
		default:
			d := combat.HitPlayer(f.r, f.c, a.a.Min, a.a.Max, a.a.Element == "physical", player)
			if pct := round(f.protect[a.a.Element]); pct > 0 {
				d -= d * min(pct, 100) / 100
			}
			dmg += d
		}
	}
	for _, s := range f.summons {
		s.protect = f.protect
		dmg += s.act(now, player)
	}
	return dmg
}

// cur is what the hunter hits: the oldest summon alive, else the monster.
func (f *foe) cur() *content.Monster {
	if len(f.summons) > 0 {
		return f.summons[0].m
	}
	return f.m
}

// target is cur's armor, defense and physical resistance.
func (f *foe) target() combat.MonsterTarget {
	m := f.cur()
	return combat.MonsterTarget{Armor: m.Armor, Defense: m.Defense, PhysicalResistance: m.Resistances["physical"]}
}

// hit lands dmg of the hunter's on cur at time now.
func (f *foe) hit(now, dmg int) {
	if len(f.summons) > 0 {
		s := f.summons[0]
		if s.hp -= dmg; s.hp <= 0 {
			f.summons = slices.Delete(f.summons, 0, 1)
			f.wake(now)
		}
		return
	}
	f.hp -= dmg
	f.wake(now)
}

// The duel's foe follows the server's rules for the abilities: a summon waits for its
// below_hp_pct (then goes at once) and for room under max_alive, the hunter's hits land on
// the summons first, a heal waits for a wound, and a phase scales the intervals and adds
// its attacks.
func TestFoeAbilities(t *testing.T) {
	parse := func(src string) *content.Monster {
		m, err := content.ParseMonster([]byte(src))
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	boss := parse(`id: boss
health: 1000
speed: 100
attacks:
  - { type: melee, min: 0, max: 0, interval_ms: 2000 }
  - { type: summon, interval_ms: 60000, below_hp_pct: 60, summon: { monster: imp, count: 2 } }
  - { type: heal_self, min: 10, max: 10, interval_ms: 1000 }
phases:
  - { below_hp_pct: 30, attack_interval_mult: 0.5, attacks_add: [ { type: spell, element: fire, min: 5, max: 5, interval_ms: 1000 } ] }
`)
	imp := parse("id: imp\nhealth: 30\nspeed: 100\nattacks: [{type: melee, min: 1, max: 1, interval_ms: 2000}]\n")
	all := content.Monsters{"boss": boss, "imp": imp}
	f := newFoe(boss, all, content.Combat{}, rand.New(rand.NewPCG(1, 2)))
	f.start(0)
	if f.attacks[0].next != 2000 || f.attacks[1].next != math.MaxInt || f.attacks[2].next != math.MaxInt || f.attacks[3].next != math.MaxInt {
		t.Fatalf("at the start: %+v", f.attacks)
	}
	f.hit(500, 500) // 50 %: the summon and the heal have their reason
	if f.nextAt() != 500 {
		t.Fatalf("next round at %d, want 500 (at once)", f.nextAt())
	}
	f.act(500, combat.PlayerTarget{})
	if len(f.summons) != 2 || f.cur() != imp || f.hp != 510 || f.attacks[1].next != 60500 {
		t.Fatalf("after the round: %d summons, hitting %s, hp %d, next summon %d", len(f.summons), f.cur().ID, f.hp, f.attacks[1].next)
	}
	f.hit(600, 30)
	f.hit(700, 30)
	if len(f.summons) != 0 || f.cur() != boss {
		t.Fatalf("%d summons left after two killing hits", len(f.summons))
	}
	f.hit(800, 300) // 21 %: enraged
	if f.phase() != 1 || f.interval(0) != 1000 || f.attacks[3].next != 800 {
		t.Errorf("phase %d, melee every %d ms, the phase's spell at %d", f.phase(), f.interval(0), f.attacks[3].next)
	}
	if dmg := f.act(800, combat.PlayerTarget{}); dmg != 5 {
		t.Errorf("the phase's spell hit for %d, want 5", dmg)
	}
}
