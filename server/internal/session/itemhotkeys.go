package session

import (
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Item hotkeys (docs/02 "Teclas rapidas de items", docs/05 UseItemType / SetItemHotkeys /
// ItemCounts): the bottom bar holds item TYPES, and the client cannot see inside closed
// containers, so the server does two things for it:
//   - UseItemType uses one unit of a type from wherever p carries it, with the rules of a
//     normal use (the same code path: cooldown, stomach, rune requirements);
//   - ItemCounts tells how many units of the tracked types p carries in total, whenever the
//     total changes. Tracking costs nothing while p's inventory does not change: the totals
//     are recomputed only on a tick that changed it (questRecheck's questDirty), and sent
//     only when one differs from the last ones sent.

// MaxItemHotkeys bounds the types a SetItemHotkeys may list (the bar has six; room for more).
const MaxItemHotkeys = 12

// msgNoneCarried is the answer of a UseItemType for a type p does not carry.
const msgNoneCarried = "inventory.none_carried"

// hotkeyUsable reports whether an item type can sit on an item hotkey: a consumable or a rune
// (what a UseItem eats or casts), never equipment, a tool or a container.
func hotkeyUsable(def *content.Item) bool {
	return def != nil && def.Container == nil && (def.Consumable != nil || def.Rune != nil)
}

// findCarried returns the first stack of def (an offered stack of a trade counts: using it
// drops it from the offer, as a UseItem does) p carries, in a deterministic order: the cells
// of the pockets first, then the equipment slots in order (the item itself), then the
// containers breadth-first: the ones in the equipment slots (the backpack first, as the
// slots go), then the ones in the pockets; each container's cells from index 0. Nil if p
// carries none. Items on the ground are never p's.
func findCarried(p *Player, def *content.Item) *Item {
	match := func(it *Item) bool { return it.def == def && len(it.items) == 0 }
	var queue []*Item
	if pk := p.pockets; pk != nil {
		for _, it := range pk.items {
			if match(it) {
				return it
			}
		}
	}
	for _, it := range p.equip {
		if it == nil {
			continue
		}
		if match(it) {
			return it
		}
		if it.def.Container != nil {
			queue = append(queue, it)
		}
	}
	if pk := p.pockets; pk != nil {
		for _, it := range pk.items {
			if it.def.Container != nil {
				queue = append(queue, it)
			}
		}
	}
	for len(queue) > 0 {
		c := queue[0]
		queue = queue[1:]
		for _, it := range c.items {
			if match(it) {
				return it
			}
			if it.def.Container != nil {
				queue = append(queue, it)
			}
		}
	}
	return nil
}

// carriedTotals fills totals[i] with how many units of keys[i] p carries in total (a stack's
// size, a rune's charges, 1 for any other item), in one walk over p's inventory.
func carriedTotals(p *Player, keys []*content.Item, totals []uint32) {
	clear(totals)
	p.eachCarried(true, func(it *Item) {
		if len(it.items) != 0 {
			return
		}
		for i, def := range keys {
			if it.def != def {
				continue
			}
			if def.Stackable || def.Rune != nil {
				totals[i] += uint32(it.count)
			} else {
				totals[i]++
			}
			return
		}
	})
}

// useItemType runs a UseItemType: one unit of the type, from wherever p carries it.
func (w *World) useItemType(ctx *game.TickContext, p *Player, m *pb.UseItemType) {
	var def *content.Item
	if m.GetItemId() <= 0xFFFF {
		def = w.byNum[uint16(m.GetItemId())]
	}
	if !hotkeyUsable(def) {
		p.emit(systemMsg(msgCannotUse))
		return
	}
	it := findCarried(p, def)
	if it == nil {
		p.emit(systemMsg(msgNoneCarried, &pb.TextParam{Name: "item", Value: &pb.TextParam_Item{Item: &pb.ItemStack{ItemId: uint32(def.Numeric)}}}))
		return
	}
	switch {
	case def.Consumable != nil:
		w.useConsumable(ctx, p, it)
	case def.Rune != nil:
		w.useRune(ctx, p, it, m.GetTo())
	}
}

// setItemHotkeys runs a SetItemHotkeys: p's tracked types become the usable, known,
// distinct ones of the list (the first MaxItemHotkeys), and the totals go out at the flush.
func (w *World) setItemHotkeys(p *Player, ids []uint32) {
	var keep []*content.Item
	for _, id := range ids {
		if id > 0xFFFF {
			continue
		}
		def := w.byNum[uint16(id)]
		if !hotkeyUsable(def) || slices.Contains(keep, def) {
			continue
		}
		if keep = append(keep, def); len(keep) == MaxItemHotkeys {
			break
		}
	}
	p.itemKeys = keep
	p.countsSent = nil
	p.countsStale = true
}

// flushItemCounts sends p its ItemCounts when a total differs from the last sent. Called each
// tick after questRecheck, which marks countsStale for a tick that changed p's inventory.
func (w *World) flushItemCounts(p *Player) {
	if !p.countsStale {
		return
	}
	p.countsStale = false
	if len(p.itemKeys) == 0 { // an empty list means no totals (docs/05): nothing to tell
		p.countsSent = nil
		return
	}
	counts := make([]uint32, len(p.itemKeys))
	carriedTotals(p, p.itemKeys, counts)
	if p.countsSent != nil && slices.Equal(counts, p.countsSent) {
		return
	}
	p.countsSent = counts
	msg := &pb.ItemCounts{Counts: make([]*pb.ItemCount, len(counts))}
	for i, def := range p.itemKeys {
		msg.Counts[i] = &pb.ItemCount{ItemId: uint32(def.Numeric), Count: counts[i]}
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_ItemCounts{ItemCounts: msg}})
}
