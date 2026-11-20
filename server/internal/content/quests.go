package content

import (
	"errors"
	"fmt"
	"maps"
	"math"
	"os"
	"path/filepath"
	"slices"

	"go.yaml.in/yaml/v3"
)

// Quest is a data/quests/*.yaml file: ordered steps and the rewards of the last one.
type Quest struct {
	ID       string         `yaml:"id"`
	Name     string         `yaml:"name"`
	Chapter  int            `yaml:"chapter"`
	MinLevel int            `yaml:"min_level"`
	Steps    []QuestStepDef `yaml:"steps"`
	Rewards  []QuestReward  `yaml:"rewards"`
	// Repeatable makes it a task (docs/06 "Quest"): once completed it can be started again
	// after its cooldown, from its first step, and its rewards are given every time.
	Repeatable *Repeatable `yaml:"repeatable"`
	// Milestone makes it a milestone quest (docs/02 "Quests de hito"): Requires says what
	// every participant needs, the quest log shows it before it is started and with Title
	// once done, and its last step is a sigils step, the cooperative plates of the map.
	Milestone bool          `yaml:"milestone"`
	Title     string        `yaml:"title"`
	Requires  *MilestoneReq `yaml:"requires"`
}

// MilestoneReq is what a milestone quest asks of each participant: a level, a piece of
// gear and a group of Players present together on the plates of its sigils step,
// optionally one of each of Vocations (the plates say which: their sigil.vocation).
type MilestoneReq struct {
	Level     int      `yaml:"level"`
	Players   int      `yaml:"players"`
	Vocations []string `yaml:"vocations"`
	Gear      *Gear    `yaml:"gear"`
}

// Gear is the gear requirement of a milestone: Item carried (anywhere, or worn when
// Equipped), or a wielded weapon of type Weapon (sword, axe, wand...). Exactly one of
// Item and Weapon is set.
type Gear struct {
	Item     string `yaml:"item"`
	Equipped bool   `yaml:"equipped"`
	Weapon   string `yaml:"weapon"`
}

// MaxMilestonePlayers bounds a milestone's group, and MaxSigilRadius the square its
// plates are looked for in (around the sigils point).
const (
	MaxMilestonePlayers = 4
	MaxSigilRadius      = 8
)

// SigilsStep returns the index of the milestone's sigils step (its last), or -1.
func (q *Quest) SigilsStep() int {
	if n := len(q.Steps); n > 0 && q.Steps[n-1].CompleteWhen.Sigils != nil {
		return n - 1
	}
	return -1
}

// Repeatable is the cooldown of a repeatable quest: the time between completing it and
// being able to start it again.
type Repeatable struct {
	CooldownHours float64 `yaml:"cooldown_hours"`
}

// MaxCooldownHours bounds a repeatable quest's cooldown (a year).
const MaxCooldownHours = 24 * 366

// CooldownSeconds is the cooldown rounded to whole seconds (at least one): 1.1 h is 3960 s,
// whatever float64 makes of 1.1 × 3600 (3960.0000000000005).
func (r *Repeatable) CooldownSeconds() int64 {
	return max(int64(math.Round(r.CooldownHours*3600)), 1)
}

// QuestStepDef is one step and the event that completes it.
type QuestStepDef struct {
	ID           string     `yaml:"id"`
	Description  string     `yaml:"description"`
	CompleteWhen Completion `yaml:"complete_when"`
}

// Completion is what completes a step: exactly one field is set.
type Completion struct {
	HasItem      *ItemCount    `yaml:"has_item"`
	DialogAction *DialogAction `yaml:"dialog_action"`
	Kill         *Kill         `yaml:"kill"`
	FlagEquals   *Flag         `yaml:"flag_equals"`
	Reach        *Reach        `yaml:"reach"`
	// Sigils is the cooperative plates of a milestone quest (docs/02 "Quests de hito").
	Sigils *Sigils `yaml:"sigils"`
}

// Sigils completes a milestone's last step for everyone at once: the sigil plates within
// Radius (Chebyshev) of X, Y on floor Z, each with a player meeting the requirements on
// it in the same tick, move all of them to To (the reward room) together.
type Sigils struct {
	X      int      `yaml:"x"`
	Y      int      `yaml:"y"`
	Z      int      `yaml:"z"`
	Radius int      `yaml:"radius"`
	To     Position `yaml:"to"`
}

// Reach completes a step while the player stands in a place (docs/06 "Quest"): a zone of
// world/islands/*/zones.yaml (Zone), or the tiles within Radius (Chebyshev) of X, Y on
// floor Z. The session resolves it against the map when it starts (unknown zone, a point
// outside every island, or a place with no walkable tile to stand on refuse to start) and
// checks it after every move and relocation while the step is current.
type Reach struct {
	Zone string `yaml:"zone"`
	X    *int   `yaml:"x"`
	Y    *int   `yaml:"y"`
	Z    *int   `yaml:"z"`
	// Radius is nil when not written: a point is then its tile alone, and a zone takes
	// none (the schema's oneOf refuses even radius: 0 with a zone).
	Radius *int `yaml:"radius"`
}

// R is the radius of a reach point: 0 when not written.
func (r *Reach) R() int {
	if r.Radius == nil {
		return 0
	}
	return *r.Radius
}

// MaxReachRadius bounds the radius of a reach point: half the width of the player's view
// with its margin (session.ViewHalfW of the 31-tile view), 33 tiles across at most.
const MaxReachRadius = 16

// check reports what is wrong with a reach completion, or "".
func (r *Reach) check() string {
	point := r.X != nil || r.Y != nil || r.Z != nil
	switch {
	case r.Zone != "" && (point || r.Radius != nil):
		return "reach takes a zone or x, y, z and radius, not both"
	case r.Zone != "":
		return ""
	case r.X == nil || r.Y == nil || r.Z == nil:
		return "reach needs a zone or x, y and z"
	case *r.X < 0 || *r.X > 0xFFFF || *r.Y < 0 || *r.Y > 0xFFFF || *r.Z < 0 || *r.Z > 15:
		return "reach point outside the world"
	case r.R() < 0 || r.R() > MaxReachRadius:
		return fmt.Sprintf("reach radius outside 0..%d", MaxReachRadius)
	}
	return ""
}

// DialogAction completes a step when the player reaches node of npc.
type DialogAction struct {
	NPC  string `yaml:"npc"`
	Node string `yaml:"node"`
}

// Kill completes a step after Count kills of Monster.
type Kill struct {
	Monster string `yaml:"monster"`
	Count   int    `yaml:"count"`
}

// QuestReward is one reward: exactly one field is set.
type QuestReward struct {
	XP      int64  `yaml:"xp"`
	Gold    int64  `yaml:"gold"`
	Item    string `yaml:"item"`
	SetFlag *Flag  `yaml:"set_flag"`
}

// StepIndex returns the index of step id, or -1.
func (q *Quest) StepIndex(id string) int {
	for i, s := range q.Steps {
		if s.ID == id {
			return i
		}
	}
	return -1
}

// Quests maps quest id to its definition.
type Quests map[string]*Quest

// LoadQuests reads every <dataDir>/quests/*.yaml.
func LoadQuests(dataDir string) (Quests, error) {
	files, err := filepath.Glob(filepath.Join(dataDir, "quests", "*.yaml"))
	if err != nil {
		return nil, fmt.Errorf("list quests: %w", err)
	}
	qs := make(Quests, len(files))
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("read quest: %w", err)
		}
		q, err := ParseQuest(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		if _, dup := qs[q.ID]; dup {
			return nil, fmt.Errorf("%s: duplicate quest %q", f, q.ID)
		}
		qs[q.ID] = q
	}
	return qs, nil
}

// ParseQuest decodes one quest file and checks its steps.
func ParseQuest(raw []byte) (*Quest, error) {
	var q Quest
	if err := yaml.Unmarshal(raw, &q); err != nil {
		return nil, fmt.Errorf("decode quest: %w", err)
	}
	if q.ID == "" {
		return nil, errors.New("quest: missing id")
	}
	if len(q.Steps) == 0 {
		return nil, fmt.Errorf("quest %q: no steps", q.ID)
	}
	seen := map[string]bool{}
	for i, s := range q.Steps {
		c := s.CompleteWhen
		n := 0
		for _, set := range []bool{c.HasItem != nil, c.DialogAction != nil, c.Kill != nil, c.FlagEquals != nil, c.Reach != nil, c.Sigils != nil} {
			if set {
				n++
			}
		}
		if s.ID == "" || seen[s.ID] || n != 1 {
			return nil, fmt.Errorf("quest %q: steps[%d] needs a unique id and exactly one complete_when", q.ID, i)
		}
		if c.Kill != nil && (c.Kill.Monster == "" || c.Kill.Count <= 0) {
			return nil, fmt.Errorf("quest %q: steps[%d]: kill needs a monster and count > 0", q.ID, i)
		}
		if c.Reach != nil {
			if msg := c.Reach.check(); msg != "" {
				return nil, fmt.Errorf("quest %q: steps[%d]: %s", q.ID, i, msg)
			}
		}
		seen[s.ID] = true
	}
	if r := q.Repeatable; r != nil && !(r.CooldownHours > 0 && r.CooldownHours <= MaxCooldownHours) {
		return nil, fmt.Errorf("quest %q: repeatable cooldown_hours must be in (0, %d]", q.ID, MaxCooldownHours)
	}
	if msg := q.checkMilestone(); msg != "" {
		return nil, fmt.Errorf("quest %q: %s", q.ID, msg)
	}
	return &q, nil
}

// checkMilestone reports what is wrong with a milestone quest, or with the milestone
// fields of another one, or "".
func (q *Quest) checkMilestone() string {
	sigils := 0
	for _, s := range q.Steps {
		if s.CompleteWhen.Sigils != nil {
			sigils++
		}
	}
	if !q.Milestone {
		switch {
		case q.Requires != nil || q.Title != "":
			return "requires and title belong to a milestone quest (milestone: true)"
		case sigils > 0:
			return "a sigils step belongs to a milestone quest (milestone: true)"
		}
		return ""
	}
	r := q.Requires
	switch {
	case r == nil:
		return "a milestone needs requires"
	case q.Title == "":
		return "a milestone needs a title"
	case q.Repeatable != nil:
		return "a milestone is done once: it cannot be repeatable"
	case sigils != 1 || q.SigilsStep() < 0:
		return "a milestone needs exactly one sigils step, its last"
	case r.Level < 1:
		return "requires.level must be at least 1"
	case r.Players < 1 || r.Players > MaxMilestonePlayers:
		return fmt.Sprintf("requires.players must be 1 to %d", MaxMilestonePlayers)
	case len(r.Vocations) != 0 && len(r.Vocations) != r.Players:
		return "requires.vocations lists one vocation per player, or none"
	case r.Gear != nil && (r.Gear.Item == "") == (r.Gear.Weapon == ""):
		return "requires.gear takes an item or a weapon type, not both"
	case r.Gear != nil && r.Gear.Equipped && r.Gear.Item == "":
		return "requires.gear.equipped goes with an item"
	}
	s := q.Steps[q.SigilsStep()].CompleteWhen.Sigils
	switch {
	case s.Radius < 0 || s.Radius > MaxSigilRadius:
		return fmt.Sprintf("sigils radius outside 0..%d", MaxSigilRadius)
	case s.X < 0 || s.X > 0xFFFF || s.Y < 0 || s.Y > 0xFFFF || s.Z < 0 || s.Z > 15,
		s.To.X < 0 || s.To.X > 0xFFFF || s.To.Y < 0 || s.To.Y > 0xFFFF || s.To.Z < 0 || s.To.Z > 15:
		return "sigils point or destination outside the world"
	}
	return ""
}

// CheckRefs checks that what NPCs and quests reference exists: items, quests and
// their steps, dialog_action nodes, monsters and skills (when given); and that no step of a
// repeatable quest lets a turn be done with no effort (CheckRepeatable, without the map).
func CheckRefs(npcs NPCs, quests Quests, items Items, monsters Monsters, skills []string) error {
	item := func(where, id string) error {
		if items[id] == nil {
			return fmt.Errorf("%s: unknown item %q", where, id)
		}
		return nil
	}
	questStep := func(where, quest, step string) error {
		q := quests[quest]
		if q == nil {
			return fmt.Errorf("%s: unknown quest %q", where, quest)
		}
		if step != "" && q.StepIndex(step) < 0 {
			return fmt.Errorf("%s: quest %q has no step %q", where, quest, step)
		}
		return nil
	}
	// questState also refuses what never means anything: a step with a state other than
	// in_progress (ignored by available and cooling_down, never holding with the others),
	// and cooling_down of a quest that is not repeatable (it never cools down).
	questState := func(where string, c *QuestStateCond) error {
		if err := questStep(where, c.Quest, c.Step); err != nil {
			return err
		}
		switch {
		case !slices.Contains([]string{QuestNotStarted, QuestInProgress, QuestCompleted, QuestAvailable, QuestCoolingDown}, c.State):
			return fmt.Errorf("%s: quest_state of %q: unknown state %q", where, c.Quest, c.State)
		case c.Step != "" && c.State != QuestInProgress:
			return fmt.Errorf("%s: quest_state of %q: a step only goes with state %s, not %s", where, c.Quest, QuestInProgress, c.State)
		case c.State == QuestCoolingDown && quests[c.Quest].Repeatable == nil:
			return fmt.Errorf("%s: quest_state of %q: %s, but the quest is not repeatable", where, c.Quest, QuestCoolingDown)
		}
		return nil
	}
	hasSkill := func(id string) bool {
		for _, s := range skills {
			if s == id {
				return true
			}
		}
		return skills == nil
	}
	for _, id := range npcs.IDs() {
		n := npcs[id]
		for nodeID, node := range n.Dialog.Nodes {
			where := fmt.Sprintf("npc %q node %q", id, nodeID)
			for _, o := range node.Options {
				for _, c := range o.If {
					var err error
					switch {
					case c.HasItem != nil:
						err = item(where, c.HasItem.Item)
					case c.LacksItem != nil:
						err = item(where, c.LacksItem.Item)
					case c.QuestState != nil:
						err = questState(where, c.QuestState)
					case c.QuestNotStarted != "":
						err = questStep(where, c.QuestNotStarted, "")
					case c.SkillAtLeast != nil && !hasSkill(c.SkillAtLeast.Skill):
						err = fmt.Errorf("%s: unknown skill %q", where, c.SkillAtLeast.Skill)
					}
					if err != nil {
						return err
					}
				}
				for _, a := range o.Action {
					var err error
					switch {
					case a.GiveItem != "":
						err = item(where, a.GiveItem)
					case a.TakeItem != nil:
						err = item(where, a.TakeItem.Item)
					case a.StartQuest != "":
						err = questStep(where, a.StartQuest, "")
					case a.SetQuestStep != nil:
						err = questStep(where, a.SetQuestStep.Quest, a.SetQuestStep.Step)
					case a.TrainSkill != nil && !hasSkill(a.TrainSkill.Skill):
						err = fmt.Errorf("%s: train_skill: unknown skill %q", where, a.TrainSkill.Skill)
					}
					if err != nil {
						return err
					}
				}
			}
		}
		if s := n.Shop; s != nil {
			for _, o := range append(append([]ShopOffer(nil), s.Sells...), s.Buys...) {
				if err := item(fmt.Sprintf("npc %q shop", id), o.Item); err != nil {
					return err
				}
			}
		}
	}
	if err := checkShopPrices(npcs); err != nil {
		return err
	}
	for id, q := range quests {
		where := fmt.Sprintf("quest %q", id)
		for _, s := range q.Steps {
			c := s.CompleteWhen
			switch {
			case c.HasItem != nil:
				if err := item(where, c.HasItem.Item); err != nil {
					return err
				}
			case c.Kill != nil:
				if monsters != nil && monsters[c.Kill.Monster] == nil {
					return fmt.Errorf("%s: unknown monster %q", where, c.Kill.Monster)
				}
			case c.DialogAction != nil:
				n := npcs[c.DialogAction.NPC]
				if n == nil || n.Dialog.Nodes[c.DialogAction.Node] == nil {
					return fmt.Errorf("%s: unknown dialog node %s/%s", where, c.DialogAction.NPC, c.DialogAction.Node)
				}
			}
		}
		if r := q.Requires; r != nil && r.Gear != nil && r.Gear.Item != "" {
			if err := item(where+" requires.gear", r.Gear.Item); err != nil {
				return err
			}
		}
		for _, r := range q.Rewards {
			if r.Item != "" {
				if err := item(where, r.Item); err != nil {
					return err
				}
			}
		}
	}
	// Without the map: the session checks the reach steps again with it (initReach).
	return CheckRepeatable(quests, npcs, nil)
}

// checkShopPrices rejects an item some NPC buys for more than any NPC sells it: buying
// and selling it back would make money out of nothing.
func checkShopPrices(npcs NPCs) error {
	type best struct {
		buy, sell     int64
		buyer, seller string
	}
	prices := map[string]*best{}
	at := func(item string) *best {
		if prices[item] == nil {
			prices[item] = &best{sell: -1}
		}
		return prices[item]
	}
	for _, id := range npcs.IDs() {
		s := npcs[id].Shop
		if s == nil {
			continue
		}
		for _, o := range s.Sells {
			if b := at(o.Item); b.sell < 0 || o.Price < b.sell {
				b.sell, b.seller = o.Price, id
			}
		}
		for _, o := range s.Buys {
			if b := at(o.Item); o.Price > b.buy {
				b.buy, b.buyer = o.Price, id
			}
		}
	}
	for _, item := range slices.Sorted(maps.Keys(prices)) {
		if b := prices[item]; b.sell >= 0 && b.buy > b.sell {
			return fmt.Errorf("shop prices: %s buys %q for %d but %s sells it for %d", b.buyer, item, b.buy, b.seller, b.sell)
		}
	}
	return nil
}
