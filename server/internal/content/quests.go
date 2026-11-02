package content

import (
	"errors"
	"fmt"
	"maps"
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
		for _, set := range []bool{c.HasItem != nil, c.DialogAction != nil, c.Kill != nil, c.FlagEquals != nil} {
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
		seen[s.ID] = true
	}
	return &q, nil
}

// CheckRefs checks that what NPCs and quests reference exists: items, quests and
// their steps, dialog_action nodes, monsters and skills (when given).
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
						err = questStep(where, c.QuestState.Quest, c.QuestState.Step)
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
		for _, r := range q.Rewards {
			if r.Item != "" {
				if err := item(where, r.Item); err != nil {
					return err
				}
			}
		}
	}
	return nil
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
