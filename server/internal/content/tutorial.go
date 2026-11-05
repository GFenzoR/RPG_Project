package content

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"

	"go.yaml.in/yaml/v3"
)

// Tutorial triggers (T4.2): the fixed set of server events a tutorial step can wait for.
// Ref narrows some of them (monster, item, spell, npc or quest id); empty means any.
const (
	TriggerWalk          = "walk"           // steps walked
	TriggerTarget        = "target"         // a monster selected as target (ref: monster)
	TriggerKill          = "kill"           // a monster killed with p's damage (ref: monster)
	TriggerOpenContainer = "open_container" // a container opened (ref: item)
	TriggerPickUp        = "pick_up"        // an item moved from outside into p's equipment (ref: item)
	TriggerEquip         = "equip"          // an item put into an equipment slot (ref: item)
	TriggerUseItem       = "use_item"       // a consumable eaten or drunk (ref: item)
	TriggerCastSpell     = "cast_spell"     // a spell cast, by hotkey or words (ref: spell)
	TriggerTalkNPC       = "talk_npc"       // a conversation started with an NPC (ref: npc)
	TriggerGather        = "gather"         // a successful gathering (ref: the item gathered)
	TriggerCraft         = "craft"          // a successful craft (ref: the recipe)
	TriggerQuestStart    = "quest_start"    // a quest started (ref: quest)
)

// TutorialTriggers is every trigger, in documentation order.
var TutorialTriggers = []string{
	TriggerWalk, TriggerTarget, TriggerKill, TriggerOpenContainer, TriggerPickUp,
	TriggerEquip, TriggerUseItem, TriggerCastSpell, TriggerTalkNPC, TriggerGather,
	TriggerCraft, TriggerQuestStart,
}

// Tutorial is data/tutorial.yaml (T4.2): the guided steps new characters of Island see.
type Tutorial struct {
	// Island is where new characters must start for the tutorial to begin.
	Island string         `yaml:"island"`
	Steps  []TutorialStep `yaml:"steps"`
	// Rewards are given once, when the last step completes (never when skipped).
	Rewards []TutorialReward `yaml:"rewards"`
	Notes   string           `yaml:"notes"`
}

// TutorialStep is one hint of the tutorial.
type TutorialStep struct {
	ID string `yaml:"id"`
	// Text is the i18n key of the hint (it may use {count}).
	Text string          `yaml:"text"`
	When TutorialTrigger `yaml:"when"`
	// Highlight names the UI element the client highlights (data-tutorial), if any.
	Highlight string `yaml:"highlight"`
	// Vocations limits the step to these vocations (empty = all); others skip it.
	Vocations []string `yaml:"vocations"`
}

// TutorialTrigger is what completes a step: Count events of kind Event matching Ref.
type TutorialTrigger struct {
	Event string `yaml:"event"`
	Ref   string `yaml:"ref"`
	Count int    `yaml:"count"`
}

// N is the count, 1 when omitted.
func (t TutorialTrigger) N() int { return max(t.Count, 1) }

// TutorialReward is a small reward: gold or an item.
type TutorialReward struct {
	Gold  int64  `yaml:"gold"`
	Item  string `yaml:"item"`
	Count int    `yaml:"count"`
}

// N is the item count, 1 when omitted.
func (r TutorialReward) N() int { return max(r.Count, 1) }

// For reports whether step applies to vocation.
func (s *TutorialStep) For(vocation string) bool {
	return len(s.Vocations) == 0 || slices.Contains(s.Vocations, vocation)
}

var tutorialID = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// LoadTutorial reads <dataDir>/tutorial.yaml; no file means no tutorial (nil).
func LoadTutorial(dataDir string) (*Tutorial, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, "tutorial.yaml"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read tutorial: %w", err)
	}
	var t Tutorial
	if err := yaml.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("decode tutorial: %w", err)
	}
	return &t, nil
}

// Check verifies the tutorial's shape and what it references.
func (t *Tutorial) Check(vocations Vocations, monsters Monsters, items Items, spells Spells, npcs NPCs, quests Quests, recipes Recipes) error {
	if t == nil {
		return nil
	}
	if t.Island == "" || len(t.Steps) == 0 || len(t.Steps) > 64 {
		return errors.New("tutorial: needs an island and 1..64 steps")
	}
	seen := map[string]bool{}
	for i := range t.Steps {
		s := &t.Steps[i]
		where := fmt.Sprintf("tutorial step %q", s.ID)
		if !tutorialID.MatchString(s.ID) || seen[s.ID] {
			return fmt.Errorf("%s: missing, invalid or duplicate id", where)
		}
		seen[s.ID] = true
		if s.Text == "" {
			return fmt.Errorf("%s: needs text", where)
		}
		if s.When.Count < 0 || s.When.Count > 1000 {
			return fmt.Errorf("%s: count must be in 0..1000", where)
		}
		for _, v := range s.Vocations {
			if _, ok := vocations[v]; !ok {
				return fmt.Errorf("%s: unknown vocation %q", where, v)
			}
		}
		ref := s.When.Ref
		var known bool
		switch s.When.Event {
		case TriggerWalk:
			known = ref == ""
		case TriggerTarget, TriggerKill:
			known = ref == "" || monsters[ref] != nil
		case TriggerOpenContainer, TriggerPickUp, TriggerEquip, TriggerUseItem, TriggerGather:
			known = ref == "" || items[ref] != nil
		case TriggerCastSpell:
			known = ref == "" || spells[ref] != nil
		case TriggerTalkNPC:
			known = ref == "" || npcs[ref] != nil
		case TriggerCraft:
			known = ref == "" || recipes[ref] != nil
		case TriggerQuestStart:
			known = ref == "" || quests[ref] != nil
		default:
			return fmt.Errorf("%s: unknown event %q", where, s.When.Event)
		}
		if !known {
			return fmt.Errorf("%s: unknown ref %q for event %s", where, ref, s.When.Event)
		}
	}
	for _, r := range t.Rewards {
		switch {
		case r.Gold > 0 && r.Item == "":
			if r.Gold > 1000 {
				return errors.New("tutorial: a gold reward is at most 1000 (no balance-breaking rewards)")
			}
		case r.Gold == 0 && r.Item != "":
			if items[r.Item] == nil || r.Count < 0 || r.Count > 100 {
				return fmt.Errorf("tutorial: reward item %q must be known, with count 0..100", r.Item)
			}
		default:
			return errors.New("tutorial: a reward is either gold or item")
		}
	}
	return nil
}
