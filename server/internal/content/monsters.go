package content

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"go.yaml.in/yaml/v3"
)

// Monster is the part of a data/monsters/*.yaml file the server uses (T1.6: melee).
type Monster struct {
	ID          string          `yaml:"id"`
	Health      int             `yaml:"health"`
	Experience  int64           `yaml:"experience"`
	Speed       int             `yaml:"speed"`
	Armor       int             `yaml:"armor"`
	Defense     int             `yaml:"defense"`
	Behavior    MonsterBehavior `yaml:"behavior"`
	Attacks     []MonsterAttack `yaml:"attacks"`
	Resistances map[string]int  `yaml:"resistances"`
	Loot        []LootEntry     `yaml:"loot"`
	// Corpse is the container item (data/items) left where it dies, with its loot: the
	// fallen body of its family (remains_fur, remains_chitin...). Empty: the server's
	// default remains (session.CorpseItem).
	Corpse string `yaml:"corpse"`
	// Phases (a boss's) change the monster while its health is below their
	// below_hp_pct: every phase it has reached at once. ParseMonster sorts them from the
	// highest below_hp_pct, so the phases a monster is in are always the first ones.
	Phases []MonsterPhase `yaml:"phases"`
}

// MonsterBehavior drives the monster's state machine.
type MonsterBehavior struct {
	Aggressive      bool `yaml:"aggressive"`
	FleeAtHealthPct int  `yaml:"flee_at_health_pct"`
	TargetDistance  int  `yaml:"target_distance"`
	// SeesInvisible lets the monster see (and fight) invisible players (T3.2).
	SeesInvisible bool `yaml:"sees_invisible"`
}

// Monster attack types (data/monsters attacks[].type). melee, distance and spell hurt
// the target (or, with an area, every player in it); heal_self and summon need no target
// in reach, only a fight.
const (
	AttackMelee    = "melee"
	AttackDistance = "distance"
	AttackSpell    = "spell"
	AttackHealSelf = "heal_self"
	AttackSummon   = "summon"
)

// Area shapes and centres of a monster attack (attacks[].area).
const (
	AreaCircle = "circle"
	AreaBeam   = "beam"
	AreaSelf   = "self"
	AreaTarget = "target"
)

// MonsterAttack is one attack of a monster. Chance 0 means always (1).
type MonsterAttack struct {
	Type       string  `yaml:"type"`
	Element    string  `yaml:"element"`
	Min        int     `yaml:"min"`
	Max        int     `yaml:"max"`
	IntervalMs int     `yaml:"interval_ms"`
	Chance     float64 `yaml:"chance"`
	Range      int     `yaml:"range"`
	// Condition (T3.2) is applied to the target when the attack deals damage (with an
	// area, to every player it hurt).
	Condition *ConditionApply `yaml:"condition"`
	// Area (melee, distance and spell; optional) makes it hit every player of an area
	// instead of the target alone.
	Area *AttackArea `yaml:"area"`
	// BelowHealthPct (optional, 1-100) uses the attack only while the monster's health
	// is below that percent of its maximum.
	BelowHealthPct int `yaml:"below_hp_pct"`
	// Summon is what a summon attack calls.
	Summon *MonsterSummon `yaml:"summon"`
}

// AttackArea is the area of a monster attack: a circle of Radius tiles (dx² + dy² ≤ r² +
// r, as an area spell) around the monster or its target (Center), every tile in line of
// sight from the centre; or a beam of Length tiles in a straight line from the monster
// towards its target (the nearest of 8 directions), stopped by the first tile that blocks
// sight.
type AttackArea struct {
	Shape  string `yaml:"shape"`
	Radius int    `yaml:"radius"`
	Length int    `yaml:"length"`
	Center string `yaml:"center"`
}

// MonsterSummon is what a summon attack calls: Count monsters of Monster on free tiles
// next to the caster, never more than MaxAlive of them alive at once (0 = Count).
type MonsterSummon struct {
	Monster  string `yaml:"monster"`
	Count    int    `yaml:"count"`
	MaxAlive int    `yaml:"max_alive"`
}

// MonsterPhase is a phase of a boss, on while its health is below BelowHealthPct: its
// AttacksAdd join the monster's attacks, its speed is multiplied by SpeedMult and every
// attack interval by AttackIntervalMult (both 1 when unset).
type MonsterPhase struct {
	BelowHealthPct     int             `yaml:"below_hp_pct"`
	AttacksAdd         []MonsterAttack `yaml:"attacks_add"`
	SpeedMult          float64         `yaml:"speed_mult"`
	AttackIntervalMult float64         `yaml:"attack_interval_mult"`
}

// Targeted reports whether a needs a target in its reach (melee, distance and spell);
// heal_self and summon do not.
func (a *MonsterAttack) Targeted() bool {
	return a.Type != AttackHealSelf && a.Type != AttackSummon
}

// Reach is how far (Chebyshev) the target may stand for the monster to use the targeted
// attack a: 1 for melee, range for distance and spell (at least 1), the radius of a
// circle around the monster itself, the length of a beam (neither has a range:
// ParseMonster refuses one); a circle around the target reaches as the attack would
// without it. An area's shape narrows it (session covers: a beam only along 8 lines, a
// circle only its round area).
func (a *MonsterAttack) Reach() int {
	switch {
	case a.Area != nil && a.Area.Shape == AreaBeam:
		return a.Area.Length
	case a.Area != nil && a.Area.Center == AreaSelf:
		return a.Area.Radius
	case a.Type == AttackMelee:
		return 1
	}
	return max(a.Range, 1)
}

// AllAttacks returns every attack of m: its own, then each phase's attacks_add.
func (m *Monster) AllAttacks() []*MonsterAttack {
	out := make([]*MonsterAttack, 0, len(m.Attacks))
	for i := range m.Attacks {
		out = append(out, &m.Attacks[i])
	}
	for p := range m.Phases {
		for i := range m.Phases[p].AttacksAdd {
			out = append(out, &m.Phases[p].AttacksAdd[i])
		}
	}
	return out
}

// Summons reports whether one of m's attacks (or its phases') summons.
func (m *Monster) Summons() bool {
	for _, a := range m.AllAttacks() {
		if a.Type == AttackSummon {
			return true
		}
	}
	return false
}

// LootEntry is one possible drop. Count is [min, max]; empty means exactly one.
type LootEntry struct {
	Item   string  `yaml:"item"`
	Chance float64 `yaml:"chance"`
	Count  []int   `yaml:"count"`
	// EachPlayer (content audit m9) makes a quest drop: instead of one in the remains,
	// every player who damaged the monster and whose quest in progress asks for the item
	// (a has_item step of it that the player no longer meets: the current step, or the
	// one just met while the next, its delivery, is current; quest.Engine.Needs) gets its
	// own, rolled for each.
	EachPlayer bool `yaml:"each_player"`
}

// CountRange returns the drop's [min, max] amount.
func (l LootEntry) CountRange() (lo, hi int) {
	if len(l.Count) == 2 {
		return l.Count[0], l.Count[1]
	}
	return 1, 1
}

// Monsters maps monster id to its definition.
type Monsters map[string]*Monster

// IDs returns the monster ids, sorted.
func (ms Monsters) IDs() []string {
	ids := make([]string, 0, len(ms))
	for id := range ms {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// LoadMonsters reads every <dataDir>/monsters/*.yaml.
func LoadMonsters(dataDir string) (Monsters, error) {
	files, err := filepath.Glob(filepath.Join(dataDir, "monsters", "*.yaml"))
	if err != nil {
		return nil, fmt.Errorf("list monsters: %w", err)
	}
	ms := make(Monsters, len(files))
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("read monster: %w", err)
		}
		m, err := ParseMonster(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		if _, dup := ms[m.ID]; dup {
			return nil, fmt.Errorf("%s: duplicate monster %q", f, m.ID)
		}
		ms[m.ID] = m
	}
	return ms, nil
}

// ParseMonster decodes one monster file and checks what the server relies on.
func ParseMonster(raw []byte) (*Monster, error) {
	var m Monster
	if err := yaml.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("decode monster: %w", err)
	}
	if m.ID == "" {
		return nil, errors.New("monster: missing id")
	}
	if m.Health <= 0 || m.Speed <= 0 || m.Experience < 0 || m.Armor < 0 || m.Defense < 0 {
		return nil, fmt.Errorf("monster %q: health and speed must be > 0; experience, armor and defense >= 0", m.ID)
	}
	if m.Behavior.TargetDistance <= 0 {
		m.Behavior.TargetDistance = 1
	}
	if m.Behavior.TargetDistance > 1 {
		// Keeping distance only makes sense with ranged attacks, which arrive with T1.9.
		return nil, fmt.Errorf("monster %q: target_distance > 1 needs ranged attacks (T1.9)", m.ID)
	}
	for i := range m.Attacks {
		if err := checkAttack(&m.Attacks[i]); err != nil {
			return nil, fmt.Errorf("monster %q: attacks[%d]: %w", m.ID, i, err)
		}
	}
	if err := checkPhases(m.Phases); err != nil {
		return nil, fmt.Errorf("monster %q: %w", m.ID, err)
	}
	for i, l := range m.Loot {
		lo, hi := l.CountRange()
		if l.Item == "" || l.Chance < 0 || l.Chance > 1 || lo < 1 || hi < lo {
			return nil, fmt.Errorf("monster %q: loot[%d]: bad item, chance or count", m.ID, i)
		}
	}
	return &m, nil
}

// checkAttack checks one attack of a monster and fills its defaults (chance 1, element
// physical for a targeted attack, max_alive = count).
func checkAttack(a *MonsterAttack) error {
	switch a.Type {
	case AttackMelee, AttackDistance, AttackSpell, AttackHealSelf:
		if a.Min < 0 || a.Max < a.Min || a.Type == AttackHealSelf && a.Max <= 0 {
			return errors.New("need 0 <= min <= max (and max > 0 to heal)")
		}
	case AttackSummon:
		s := a.Summon
		if s == nil || s.Monster == "" || s.Count < 1 || s.Count > 8 || s.MaxAlive < 0 || s.MaxAlive > 8 {
			return errors.New("a summon needs summon: {monster, count 1-8, max_alive 0-8} (8 tiles around the caster)")
		}
		if s.MaxAlive == 0 {
			s.MaxAlive = s.Count
		}
		if a.Min != 0 || a.Max != 0 {
			return errors.New("a summon has no min or max")
		}
	default:
		return fmt.Errorf("unknown type %q", a.Type)
	}
	if a.IntervalMs <= 0 {
		return errors.New("need interval_ms > 0")
	}
	if a.BelowHealthPct < 0 || a.BelowHealthPct > 100 {
		return errors.New("below_hp_pct must be 1-100")
	}
	if a.Summon != nil && a.Type != AttackSummon {
		return errors.New("only a summon attack has summon")
	}
	if !a.Targeted() && (a.Area != nil || a.Condition != nil || a.Range != 0 || a.Element != "") {
		return fmt.Errorf("%s has no area, condition, range or element", a.Type)
	}
	if err := checkArea(a.Area); err != nil {
		return err
	}
	if ar := a.Area; ar != nil && ar.Center != AreaTarget && a.Range != 0 {
		// Its reach is its length or radius (Reach): a range would be ignored.
		return errors.New("a beam or a circle around the monster has no range: its length or radius is how far it reaches")
	}
	// How far it hits stops at MaxRange, what a monster notices: its reach and, for a
	// circle around its target, that reach plus the radius. Past it an area would hurt a
	// player who does not even know the monster.
	far := a.Reach()
	if ar := a.Area; ar != nil && ar.Center == AreaTarget {
		far += ar.Radius
	}
	if a.Targeted() && (a.Range < 0 || far > MaxRange) {
		return fmt.Errorf("range must be 0-%d, and range + radius of a circle around the target at most %d (what a monster notices)", MaxRange, MaxRange)
	}
	if a.Chance == 0 {
		a.Chance = 1
	}
	if a.Element == "" && a.Targeted() {
		a.Element = "physical"
	}
	return nil
}

// checkArea checks an attack's area: a circle of radius 1..MaxRange around self (the
// default) or the target, or a beam of length 1..MaxRange from the monster. The bound is
// what a monster notices (MaxRange); checkAttack bounds a circle around the target with
// the attack's range too.
func checkArea(ar *AttackArea) error {
	if ar == nil {
		return nil
	}
	switch ar.Shape {
	case AreaCircle:
		if ar.Center == "" {
			ar.Center = AreaSelf
		}
		if ar.Radius < 1 || ar.Radius > MaxRange || ar.Length != 0 || ar.Center != AreaSelf && ar.Center != AreaTarget {
			return fmt.Errorf("a circle needs radius 1-%d, no length and center self or target", MaxRange)
		}
	case AreaBeam:
		if ar.Length < 1 || ar.Length > MaxRange || ar.Radius != 0 || ar.Center != "" && ar.Center != AreaSelf {
			return fmt.Errorf("a beam needs length 1-%d and no radius: it starts at the monster", MaxRange)
		}
		ar.Center = AreaSelf
	default:
		return fmt.Errorf("unknown area shape %q", ar.Shape)
	}
	return nil
}

// checkPhases checks a monster's phases (below_hp_pct 1-99, a different one each, the
// multipliers above 0 and 1 when unset, and their attacks) and sorts them from the
// highest below_hp_pct.
func checkPhases(ps []MonsterPhase) error {
	for i := range ps {
		p := &ps[i]
		if p.BelowHealthPct < 1 || p.BelowHealthPct > 99 {
			return fmt.Errorf("phases[%d]: below_hp_pct must be 1-99", i)
		}
		if p.SpeedMult == 0 {
			p.SpeedMult = 1
		}
		if p.AttackIntervalMult == 0 {
			p.AttackIntervalMult = 1
		}
		if p.SpeedMult < 0 || p.SpeedMult > 4 || p.AttackIntervalMult < 0 || p.AttackIntervalMult > 4 {
			return fmt.Errorf("phases[%d]: speed_mult and attack_interval_mult must be above 0, at most 4", i)
		}
		for j := range p.AttacksAdd {
			if err := checkAttack(&p.AttacksAdd[j]); err != nil {
				return fmt.Errorf("phases[%d].attacks_add[%d]: %w", i, j, err)
			}
		}
	}
	sort.SliceStable(ps, func(i, j int) bool { return ps[i].BelowHealthPct > ps[j].BelowHealthPct })
	for i := 1; i < len(ps); i++ {
		if ps[i].BelowHealthPct == ps[i-1].BelowHealthPct {
			return fmt.Errorf("two phases below %d %%", ps[i].BelowHealthPct)
		}
	}
	return nil
}
