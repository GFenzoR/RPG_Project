// Package dialog interprets the NPC dialogs of data/npcs (docs/06-content-data.md): which
// options a player sees and what picking one does. There is no scripting: conditions
// and actions are the fixed list of the content schema.
//
// Picking an option is all or nothing: the conditions are evaluated again (the client
// may have an old window) and the costs (gold, items) are checked before any action
// runs.
package dialog

import (
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
)

// Refusal keys (i18n) of an option whose actions cannot run.
const (
	MsgNoMoney        = "dialog.no_money"
	MsgNoChangeRoom   = "dialog.no_change_room"
	MsgNoItem         = "dialog.no_item"
	MsgAlreadyBlessed = "dialog.already_blessed"
	MsgCannotTravel   = "dialog.cannot_travel"
)

// Facts is what conditions and costs read from the player.
type Facts interface {
	Level() int
	Vocation() string
	// ItemCount counts the item in the whole inventory (equipment and nested
	// containers).
	ItemCount(item string) int
	QuestState(quest string) (quest.State, string)
	Flag(key string) int64
	SkillLevel(skill string) int
	// Money is the carried money in the smallest coin.
	Money() int64
	// CanPay reports whether the change of paying amount (when a coin is broken) fits.
	// Only asked when Money covers amount.
	CanPay(amount int64) bool
	HasBlessing(id string) bool
	// CanTeleport reports whether the destination exists and is free.
	CanTeleport(p content.Position) bool
}

// Effects applies actions. Costs were checked before any of them is called.
type Effects interface {
	Facts
	GiveItem(item string)
	TakeItem(item string, count int)
	GiveXP(xp int64)
	GiveGold(amount int64)
	TakeGold(amount int64)
	StartQuest(id string)
	SetQuestStep(quest, step string)
	SetFlag(key string, value int64)
	OpenShop(id string)
	Heal()
	Teleport(p content.Position)
	Bless(b content.Bless)
}

// Holds reports whether every condition holds for f.
func Holds(cs content.Conditions, f Facts) bool {
	for _, c := range cs {
		if !holds(c, f) {
			return false
		}
	}
	return true
}

func holds(c content.Condition, f Facts) bool {
	switch {
	case c.LevelAtLeast > 0:
		return f.Level() >= c.LevelAtLeast
	case len(c.VocationIn) > 0:
		v := f.Vocation()
		for _, x := range c.VocationIn {
			if x == v {
				return true
			}
		}
		return false
	case c.HasItem != nil:
		return f.ItemCount(c.HasItem.Item) >= c.HasItem.N()
	case c.LacksItem != nil:
		return f.ItemCount(c.LacksItem.Item) < c.LacksItem.N()
	case c.QuestState != nil:
		s, step := f.QuestState(c.QuestState.Quest)
		if s.String() != c.QuestState.State {
			return false
		}
		return c.QuestState.Step == "" || c.QuestState.Step == step
	case c.QuestNotStarted != "":
		s, _ := f.QuestState(c.QuestNotStarted)
		return s == quest.NotStarted
	case c.FlagEquals != nil:
		return f.Flag(c.FlagEquals.Key) == c.FlagEquals.Value
	case c.SkillAtLeast != nil:
		return f.SkillLevel(c.SkillAtLeast.Skill) >= c.SkillAtLeast.Level
	}
	return false // an empty condition never holds: the content is broken
}

// Visible returns the indices of node's options that f sees, in order.
func Visible(node *content.DialogNode, f Facts) []int {
	var out []int
	for i, o := range node.Options {
		if Holds(o.If, f) {
			out = append(out, i)
		}
	}
	return out
}

// Check returns the refusal key if the actions cannot all run for f, or "".
func Check(as content.Actions, f Facts) string {
	var gold int64
	items := map[string]int{}
	for _, a := range as {
		switch {
		case a.TakeGold > 0:
			gold += a.TakeGold
		case a.TakeItem != nil:
			items[a.TakeItem.Item] += a.TakeItem.N()
		case a.Teleport != nil:
			if !f.CanTeleport(*a.Teleport) {
				return MsgCannotTravel
			}
		case a.Bless != nil:
			if f.HasBlessing(a.Bless.Blessing) {
				return MsgAlreadyBlessed
			}
			gold += a.Bless.Price
		}
	}
	if gold > f.Money() {
		return MsgNoMoney
	}
	if gold > 0 && !f.CanPay(gold) {
		return MsgNoChangeRoom
	}
	for it, n := range items {
		if f.ItemCount(it) < n {
			return MsgNoItem
		}
	}
	return ""
}

// Result is what picking an option did.
type Result struct {
	// Node is the node the dialog is on now ("" when it closed).
	Node string
	// Refused is the refusal key when nothing ran (conditions or costs).
	Refused string
	// Entered is true when the option's goto was followed (dialog_action steps).
	Entered bool
}

// Choose picks option index (0-based, of node's full list) of npc's node for e: it
// checks the option is visible and affordable, runs its actions in order and returns
// the node the dialog moves to. A hidden or unknown option refuses with an empty key
// (a stale window: the caller just resends the node).
func Choose(npc *content.NPC, node string, index int, e Effects) Result {
	n := npc.Dialog.Nodes[node]
	if n == nil || index < 0 || index >= len(n.Options) {
		return Result{Node: node, Refused: ""}
	}
	o := n.Options[index]
	if !Holds(o.If, e) {
		return Result{Node: node, Refused: ""}
	}
	if key := Check(o.Action, e); key != "" {
		return Result{Node: node, Refused: key}
	}
	for _, a := range o.Action {
		apply(a, e)
	}
	switch {
	case o.Action.Closes():
		return Result{}
	case o.Goto != "":
		return Result{Node: o.Goto, Entered: true}
	}
	return Result{Node: node}
}

func apply(a content.Action, e Effects) {
	switch {
	case a.GiveItem != "":
		e.GiveItem(a.GiveItem)
	case a.TakeItem != nil:
		e.TakeItem(a.TakeItem.Item, a.TakeItem.N())
	case a.GiveXP > 0:
		e.GiveXP(a.GiveXP)
	case a.GiveGold > 0:
		e.GiveGold(a.GiveGold)
	case a.TakeGold > 0:
		e.TakeGold(a.TakeGold)
	case a.StartQuest != "":
		e.StartQuest(a.StartQuest)
	case a.SetQuestStep != nil:
		e.SetQuestStep(a.SetQuestStep.Quest, a.SetQuestStep.Step)
	case a.SetFlag != nil:
		e.SetFlag(a.SetFlag.Key, a.SetFlag.Value)
	case a.OpenShop != "":
		e.OpenShop(a.OpenShop)
	case a.Heal:
		e.Heal()
	case a.Teleport != nil:
		e.Teleport(*a.Teleport)
	case a.Bless != nil:
		e.Bless(*a.Bless)
	}
}
