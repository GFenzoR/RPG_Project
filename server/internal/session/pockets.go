package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Pockets (docs/02 "Bolsillos"; the owner on 2026-11-19: "al no tener contenedor el
// personaje debiese tener 4 slots (los bolsillos) pero si te compras una mochila ganas mas
// slots"). Every character has balance.yaml inventory.pocket_slots built-in cells. They are
// part of the character, never an item: nothing equips, moves, picks up, sells, trades or
// drops the pockets themselves, and a death never takes them (what they hold falls to the
// corpse with the backpack, death.go).
//
// They are modelled as a container *Item that p holds outside its equipment
// (Player.pockets): owner p and slot 0 (equipment index 0 is unused), with a definition no
// data/items entry has (World.pocketsDef: no numeric id, no weight). So an item in them is
// an item in a container p carries, and the container paths cover it as they are: moves
// (reach, capacity, depth, the economy ledger, the T5.3 fail-safes), uses, looks, runes,
// the forge, the trade, the market's picker, keys, payments and every count of what p
// carries (eachCarried). The pockets item itself is never reached by a client: itemAt only
// returns what lies in a cell (ItemLocation.pocket) and eachCarried walks only their
// content, so it is never detached. The client sees them in Inventory.pockets (never a
// container window: containerChanged sends the Inventory).
//
// What p receives (purchases, crafting results, quest, chest and dialog rewards, loot of
// a quest, gathering, the mailbox, a trade, conjured items, the change of a payment) goes
// to the top level of its equipped backpack first and then to its pockets (packs): the
// room checks (room, canPay, roomForAll, tradeFits, canReceiveMoney) count both. A
// MoveItem into the worn backpack that is full, or onto the backpack slot without a
// backpack (of anything that is not a backpack), lands in the pockets (intoBackpack): a
// pickup goes to the backpack first and then to the pockets.

// newPockets returns p's empty pockets.
func (w *World) newPockets(p *Player) *Item {
	return &Item{def: w.pocketsDef, count: 1, owner: p}
}

// Pockets returns p's pockets (tests and tools; never nil for a player in the world).
func (p *Player) Pockets() *Item { return p.pockets }

// isPockets reports whether c is the pockets of the player that holds it.
func isPockets(c *Item) bool { return c.owner != nil && c.owner.pockets == c }

// packs returns where what p receives goes, in order: the top level of the container in
// its backpack slot (nil without one), then its pockets.
func (p *Player) packs() [2]*Item {
	var out [2]*Item
	if bp := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK]; bp != nil && bp.def.Container != nil {
		out[0] = bp
	}
	out[1] = p.pockets
	return out
}

// freeCells is how many items more the top level of p's packs takes.
func (p *Player) freeCells() int {
	n := 0
	for _, c := range p.packs() {
		if c != nil {
			n += max(c.def.Slots()-len(c.items), 0)
		}
	}
	return n
}

// mergeRoom is how many units of the stackable def the stacks already at the top level
// of p's packs take before a new stack is needed (0 for anything else).
func (p *Player) mergeRoom(def *content.Item) int {
	if !def.Stackable {
		return 0
	}
	n := 0
	for _, c := range p.packs() {
		if c == nil {
			continue
		}
		for _, s := range c.items {
			if s.def == def && s.mods.Zero() {
				n += max(def.StackLimit()-s.count, 0)
			}
		}
	}
	return n
}

// packStack returns the first stack at the top level of p's packs (the backpack first) that
// takes one more unit of the stackable def, or nil.
func (p *Player) packStack(def *content.Item) *Item {
	if !def.Stackable {
		return nil
	}
	for _, c := range p.packs() {
		if c == nil {
			continue
		}
		for _, s := range c.items {
			if s.def == def && s.mods.Zero() && s.count < def.StackLimit() {
				return s
			}
		}
	}
	return nil
}

// packWithRoom returns the first of p's packs (the backpack first) whose top level takes
// one more item, or nil.
func (p *Player) packWithRoom() *Item {
	for _, c := range p.packs() {
		if c != nil && len(c.items) < c.def.Slots() {
			return c
		}
	}
	return nil
}

// intoBackpack reports whether a MoveItem of it to `to` means "carry it in the backpack":
// into the top level of the container in p's backpack slot (by its slot or its window),
// or onto the empty backpack slot for an item that is not worn there. When the backpack
// has no room, or there is none, such a move lands in the pockets (moveItem): a pickup
// goes to the backpack first and then to the pockets. Into a container lying in the
// backpack it never spills: that container was the player's choice.
func (p *Player) intoBackpack(it *Item, to place) bool {
	bp := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK]
	switch to.kind {
	case locContainer:
		return bp != nil && to.cont == bp
	case locSlot:
		return to.slot == pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK && bp == nil && slotFor(it.def) != to.slot
	}
	return false
}

// pocketRoom returns the stack of p's pockets that count units of it join (nil: a new
// one) and whether they fit there.
func (p *Player) pocketRoom(it *Item, count int) (*Item, bool) {
	pk := p.pockets
	if pk == nil {
		return nil, false
	}
	if merge := mergeTarget(pk.items, it, count); merge != nil {
		return merge, true
	}
	return nil, len(pk.items) < pk.def.Slots()
}

// pocketStates are the saved items of p's pockets (Pocket set, Slot = cell).
func (p *Player) pocketStates(out []ItemState) []ItemState {
	if p.pockets == nil {
		return out
	}
	for i, it := range p.pockets.items {
		s := it.state(i)
		s.Pocket = true
		out = append(out, s)
	}
	return out
}

// loadPockets gives p its pockets with their saved items (cell order). Every saved item
// is kept, also past inventory.pocket_slots (a balance that lowered it): it can be taken
// out, but nothing more goes in until there is room (never lower it, docs/06).
func (w *World) loadPockets(p *Player, saved []ItemState) {
	p.pockets = w.newPockets(p)
	for _, s := range saved {
		if !s.Pocket {
			continue
		}
		if it := w.loadItem(s); it != nil {
			it.parent = p.pockets
			p.pockets.items = append(p.pockets.items, it)
		}
	}
}

// initPockets builds the definition of the pockets from balance.yaml inventory.
func (w *World) initPockets() {
	no := false
	w.pocketsDef = &content.Item{ID: "pockets", Kind: "container", Pickupable: &no}
	w.pocketsDef.Container = &struct {
		Slots int `yaml:"slots"`
	}{Slots: max(w.cfg.Balance.Inventory.PocketSlots, 0)}
}
