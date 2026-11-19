package content

import (
	"fmt"
	"maps"
	"slices"
)

// Givers returns the NPCs whose dialog starts quest id (a start_quest action), sorted.
func Givers(npcs NPCs, id string) []string {
	var out []string
	for _, nid := range npcs.IDs() {
		if startsQuest(npcs[nid], id) {
			out = append(out, nid)
		}
	}
	return out
}

func startsQuest(n *NPC, id string) bool {
	for _, node := range n.Dialog.Nodes {
		for _, o := range node.Options {
			if slices.ContainsFunc(o.Action, func(a Action) bool { return a.StartQuest == id }) {
				return true
			}
		}
	}
	return false
}

// DeliveryTakes reports whether node of npc's dialog is a delivery of n units of item: not
// where the dialog starts, and every option that leads there (goto, one at least) takes at
// least n of the item (take_item).
func DeliveryTakes(npc *NPC, node, item string, n int) bool {
	if npc == nil || node == npc.Dialog.Start {
		return false
	}
	leads := false
	for _, dn := range npc.Dialog.Nodes {
		for _, o := range dn.Options {
			if o.Goto != node {
				continue
			}
			leads = true
			if !slices.ContainsFunc(o.Action, func(a Action) bool {
				return a.TakeItem != nil && a.TakeItem.Item == item && a.TakeItem.N() >= n
			}) {
				return false
			}
		}
	}
	return leads
}

// CheckRepeatable refuses the steps of a repeatable quest that would let a turn be done,
// and paid, with no effort (docs/06 "Quests repetibles"):
//   - a has_item step not followed by its delivery: a dialog_action step whose node every
//     option leading there reaches taking at least that many of the item (DeliveryTakes).
//     Otherwise the same item would complete the step turn after turn;
//   - a flag_equals step on a key and value its own rewards set (set_flag): from the
//     second turn on it holds the moment it becomes current;
//   - among the steps that can hold the moment the quest starts (its first ones, while they
//     are flag_equals: a flag may already hold), a dialog_action with an NPC that starts
//     the quest (talking on, right there, completes it), or a reach whose place comes
//     within talk range of where such an NPC stands (taking it there completes it).
//
// near reports whether the place of a reach step comes within talk range of where NPC npc
// stands: the session passes it once the map and the NPCs are placed (initReach); nil
// (CheckRefs, which has no map) takes no place as near. make validate checks the same
// (packages/content-schema, checkRepeatable).
func CheckRepeatable(quests Quests, npcs NPCs, near func(r *Reach, npc string) bool) error {
	for _, id := range slices.Sorted(maps.Keys(quests)) {
		q := quests[id]
		if q.Repeatable == nil {
			continue
		}
		for i, s := range q.Steps {
			c := s.CompleteWhen
			if h := c.HasItem; h != nil {
				var d *DialogAction
				if i+1 < len(q.Steps) {
					d = q.Steps[i+1].CompleteWhen.DialogAction
				}
				if d == nil || !DeliveryTakes(npcs[d.NPC], d.Node, h.Item, h.N()) {
					return fmt.Errorf("quest %q step %q: a repeatable quest's has_item must be followed by its delivery, a dialog_action step whose node every option leading there reaches with take_item of %d %q, or the same items would do it every turn", id, s.ID, h.N(), h.Item)
				}
			}
			if f := c.FlagEquals; f != nil && slices.ContainsFunc(q.Rewards, func(r QuestReward) bool {
				return r.SetFlag != nil && *r.SetFlag == *f
			}) {
				return fmt.Errorf("quest %q step %q: flag_equals %s = %d, which the quest's own rewards set: from its second turn on the step would hold at once", id, s.ID, f.Key, f.Value)
			}
		}
		givers := Givers(npcs, id)
		for _, s := range q.Steps {
			c := s.CompleteWhen
			if c.FlagEquals != nil {
				continue // it may hold already: the next step may be done at the start too
			}
			if d := c.DialogAction; d != nil && slices.Contains(givers, d.NPC) {
				return fmt.Errorf("quest %q step %q: a repeatable quest cannot start with a dialog_action of npc %q, which gives it: talking on would complete the turn right where it is taken", id, s.ID, d.NPC)
			}
			if r := c.Reach; r != nil && near != nil {
				for _, g := range givers {
					if near(r, g) {
						return fmt.Errorf("quest %q step %q: a repeatable quest cannot start with a reach whose place comes within talk range of npc %q, which gives it: taking it there would complete the turn", id, s.ID, g)
					}
				}
			}
			break
		}
	}
	return nil
}

// RefWarnings lists what NPC dialogs ask of quests that loads but likely is a mistake: a
// quest_not_started (or quest_state not_started) of a repeatable quest holds only before
// its first turn; a task is offered with quest_state available (docs/06 "Quests
// repetibles"). make validate warns of the same.
func RefWarnings(npcs NPCs, quests Quests) []string {
	var out []string
	for _, id := range npcs.IDs() {
		n := npcs[id]
		for _, nodeID := range slices.Sorted(maps.Keys(n.Dialog.Nodes)) {
			for _, o := range n.Dialog.Nodes[nodeID].Options {
				for _, c := range o.If {
					q := c.QuestNotStarted
					if c.QuestState != nil && c.QuestState.State == QuestNotStarted {
						q = c.QuestState.Quest
					}
					if quests[q] != nil && quests[q].Repeatable != nil {
						out = append(out, fmt.Sprintf("npc %q node %q: not_started of repeatable quest %q holds only before its first turn; offer it with quest_state available", id, nodeID, q))
					}
				}
			}
		}
	}
	return out
}
