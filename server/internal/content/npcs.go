package content

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"go.yaml.in/yaml/v3"
)

// NPC is a data/npcs/*.yaml file (docs/06-content-data.md): a dialog tree and an
// optional shop.
type NPC struct {
	ID     string `yaml:"id"`
	Name   string `yaml:"name"`
	Sprite string `yaml:"sprite"`
	Dialog Dialog `yaml:"dialog"`
	Shop   *Shop  `yaml:"shop"`
}

// Dialog is an NPC's dialog tree: nodes by id, starting at Start.
type Dialog struct {
	Start string                 `yaml:"start"`
	Nodes map[string]*DialogNode `yaml:"nodes"`
}

// DialogNode is one window of the dialog: the NPC's text and up to nine options.
type DialogNode struct {
	Text string `yaml:"text"`
	// BoatRoutes offers the routes of data/boat_routes.yaml this NPC sells, before
	// Options (T3.5).
	BoatRoutes bool           `yaml:"boat_routes"`
	Options    []DialogOption `yaml:"options"`
}

// DialogOption is one answer. It is shown only when every condition of If holds; picking
// it runs Action (in order) and then moves to Goto. Without Goto (and without close) the
// dialog stays on the same node.
type DialogOption struct {
	Text   string     `yaml:"text"`
	If     Conditions `yaml:"if"`
	Action Actions    `yaml:"action"`
	Goto   string     `yaml:"goto"`
}

// ItemCount is an item id and an amount (default 1).
type ItemCount struct {
	Item  string `yaml:"item"`
	Count int    `yaml:"count"`
}

// N returns the amount, 1 when unset.
func (c ItemCount) N() int { return max(c.Count, 1) }

// Flag is a per-character storage value.
type Flag struct {
	Key   string `yaml:"key"`
	Value int64  `yaml:"value"`
}

// Quest states as written in quest_state conditions.
const (
	QuestNotStarted = "not_started"
	QuestInProgress = "in_progress"
	QuestCompleted  = "completed"
)

// QuestStateCond holds when the quest is in State (and, with Step, on that step).
type QuestStateCond struct {
	Quest string `yaml:"quest"`
	State string `yaml:"state"`
	Step  string `yaml:"step"`
}

// SkillLevel is a skill id and a level.
type SkillLevel struct {
	Skill string `yaml:"skill"`
	Level int    `yaml:"level"`
}

// Condition is one dialog condition: exactly one field is set.
type Condition struct {
	LevelAtLeast    int             `yaml:"level_at_least"`
	VocationIn      []string        `yaml:"vocation_in"`
	HasItem         *ItemCount      `yaml:"has_item"`
	LacksItem       *ItemCount      `yaml:"lacks_item"`
	QuestState      *QuestStateCond `yaml:"quest_state"`
	QuestNotStarted string          `yaml:"quest_not_started"`
	FlagEquals      *Flag           `yaml:"flag_equals"`
	SkillAtLeast    *SkillLevel     `yaml:"skill_at_least"`
}

// Conditions is one condition or a list of them (all must hold).
type Conditions []Condition

// UnmarshalYAML accepts a single condition or a list.
func (c *Conditions) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.SequenceNode {
		var list []Condition
		if err := n.Decode(&list); err != nil {
			return err
		}
		*c = list
		return nil
	}
	var one Condition
	if err := n.Decode(&one); err != nil {
		return err
	}
	*c = Conditions{one}
	return nil
}

// Bless sells a blessing (death rules, T1.11).
type Bless struct {
	Blessing string `yaml:"blessing"`
	Price    int64  `yaml:"price"`
}

// QuestStep names a step of a quest.
type QuestStep struct {
	Quest string `yaml:"quest"`
	Step  string `yaml:"step"`
}

// Position is a world position in content files.
type Position struct {
	X int `yaml:"x"`
	Y int `yaml:"y"`
	Z int `yaml:"z"`
}

// Action is one dialog action: Close, or exactly one of the other fields.
type Action struct {
	Close        bool       `yaml:"-"`
	GiveItem     string     `yaml:"give_item"`
	TakeItem     *ItemCount `yaml:"take_item"`
	GiveXP       int64      `yaml:"give_xp"`
	GiveGold     int64      `yaml:"give_gold"`
	TakeGold     int64      `yaml:"take_gold"`
	StartQuest   string     `yaml:"start_quest"`
	SetQuestStep *QuestStep `yaml:"set_quest_step"`
	SetFlag      *Flag      `yaml:"set_flag"`
	OpenShop     string     `yaml:"open_shop"`
	Heal         bool       `yaml:"heal"`
	Teleport     *Position  `yaml:"teleport"`
	Bless        *Bless     `yaml:"bless"`
}

// UnmarshalYAML accepts the bare string "close" or a one-key mapping.
func (a *Action) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.ScalarNode {
		if n.Value != "close" {
			return fmt.Errorf("line %d: unknown action %q", n.Line, n.Value)
		}
		*a = Action{Close: true}
		return nil
	}
	type plain Action
	var p plain
	if err := n.Decode(&p); err != nil {
		return err
	}
	*a = Action(p)
	return nil
}

// Actions is one action or a list of them, run in order.
type Actions []Action

// UnmarshalYAML accepts a single action or a list.
func (as *Actions) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.SequenceNode {
		var list []Action
		if err := n.Decode(&list); err != nil {
			return err
		}
		*as = list
		return nil
	}
	var one Action
	if err := n.Decode(&one); err != nil {
		return err
	}
	*as = Actions{one}
	return nil
}

// Closes reports whether the actions end the dialog (close or teleport).
func (as Actions) Closes() bool {
	for _, a := range as {
		if a.Close || a.Teleport != nil {
			return true
		}
	}
	return false
}

// Shop is an NPC's trade list. Sells are what the player can buy; Buys what the NPC
// buys from the player.
type Shop struct {
	ID    string      `yaml:"id"`
	Sells []ShopOffer `yaml:"sells"`
	Buys  []ShopOffer `yaml:"buys"`
}

// ShopOffer is an item and its price in the smallest coin.
type ShopOffer struct {
	Item  string `yaml:"item"`
	Price int64  `yaml:"price"`
}

// MaxPrice bounds a shop price, so price × count (at most 100) never overflows.
const MaxPrice = 1_000_000_000

// NPCs maps NPC id to its definition.
type NPCs map[string]*NPC

// IDs returns the NPC ids, sorted.
func (ns NPCs) IDs() []string {
	ids := make([]string, 0, len(ns))
	for id := range ns {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// LoadNPCs reads every <dataDir>/npcs/*.yaml.
func LoadNPCs(dataDir string) (NPCs, error) {
	files, err := filepath.Glob(filepath.Join(dataDir, "npcs", "*.yaml"))
	if err != nil {
		return nil, fmt.Errorf("list npcs: %w", err)
	}
	ns := make(NPCs, len(files))
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("read npc: %w", err)
		}
		n, err := ParseNPC(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		if _, dup := ns[n.ID]; dup {
			return nil, fmt.Errorf("%s: duplicate npc %q", f, n.ID)
		}
		ns[n.ID] = n
	}
	return ns, nil
}

// ParseNPC decodes one NPC file and checks its dialog tree is closed: the start node
// and every goto exist, options are 1..9 per node, and each option goes somewhere or
// does something. References to items, quests and skills are checked by CheckRefs.
func ParseNPC(raw []byte) (*NPC, error) {
	var n NPC
	if err := yaml.Unmarshal(raw, &n); err != nil {
		return nil, fmt.Errorf("decode npc: %w", err)
	}
	if n.ID == "" {
		return nil, errors.New("npc: missing id")
	}
	d := n.Dialog
	if len(d.Nodes) > 0 || d.Start != "" {
		if d.Nodes[d.Start] == nil {
			return nil, fmt.Errorf("npc %q: start node %q does not exist", n.ID, d.Start)
		}
	}
	for id, node := range d.Nodes {
		if node == nil || len(node.Options) == 0 || len(node.Options) > 9 {
			return nil, fmt.Errorf("npc %q: node %q needs 1..9 options", n.ID, id)
		}
		for i, o := range node.Options {
			if o.Goto != "" && d.Nodes[o.Goto] == nil {
				return nil, fmt.Errorf("npc %q: node %q option %d: goto %q does not exist", n.ID, id, i+1, o.Goto)
			}
			if o.Goto == "" && len(o.Action) == 0 {
				return nil, fmt.Errorf("npc %q: node %q option %d: needs goto or action", n.ID, id, i+1)
			}
			for _, a := range o.Action {
				if a.OpenShop != "" && (n.Shop == nil || n.Shop.ID != a.OpenShop) {
					return nil, fmt.Errorf("npc %q: node %q option %d: opens shop %q, not its own", n.ID, id, i+1, a.OpenShop)
				}
			}
		}
	}
	if s := n.Shop; s != nil {
		for _, o := range append(append([]ShopOffer(nil), s.Sells...), s.Buys...) {
			if o.Item == "" || o.Price < 0 || o.Price > MaxPrice {
				return nil, fmt.Errorf("npc %q: shop offer %q needs a price in 0..%d", n.ID, o.Item, MaxPrice)
			}
		}
	}
	return &n, nil
}
