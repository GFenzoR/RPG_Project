package session

import (
	"fmt"
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Items, equipment and containers (T1.8, docs/02-game-design.md, items section).
//
// Every item is an *Item instance that lives in exactly one place: on a tile (World.ground,
// above the static items of world.bin), in an equipment slot of a player, or inside a
// container. Moving an item moves the instance; nothing is copied, so an item can never
// be duplicated by a move (the inventory is "transactional", ready for trades and the
// future market).

// i18n keys of the system messages about items (i18n/*/client.yaml).
const (
	msgNotPossible    = "inventory.not_possible"
	msgTooFar         = "inventory.too_far"
	msgCannotMove     = "inventory.cannot_move"
	msgCannotUse      = "inventory.cannot_use"
	msgWrongSlot      = "inventory.wrong_slot"
	msgSlotOccupied   = "inventory.slot_occupied"
	msgHandsFull      = "inventory.hands_full"
	msgContainerFull  = "inventory.container_full"
	msgTooHeavy       = "inventory.too_heavy"
	msgLevelRequired  = "inventory.level_required"
	msgVocationCannot = "inventory.vocation_cannot"
	msgIntoItself     = "inventory.into_itself"
	msgTooDeep        = "inventory.too_deep"
	msgTileFull       = "inventory.tile_full"
	msgSaving         = "inventory.saving"
	msgNotYours       = "inventory.not_yours"
	msgFloorFirst     = "inventory.floor_first"
	msgNotReady       = "inventory.not_ready"
	msgAte            = "inventory.ate"
	msgFull           = "inventory.full_stomach"
	msgLookItem       = "look.item"
	msgLookWeapon     = "look.weapon"
	msgLookArmor      = "look.armor"
	msgLookShield     = "look.shield"
	msgLookContainer  = "look.container"
	msgLookGround     = "look.ground"
)

// maxGroundItems bounds the runtime items of one tile (each TileUpdate carries the
// whole stack). Equal stacks merge, so this only limits different items.
const maxGroundItems = 20

// maxDepth bounds container nesting (an item at depth 1 is directly in an equipment
// slot or on the ground), so recursion over items and saved rows stays shallow.
const maxDepth = 8

// equipSlots is the number of entries of Player.equip: index = pb.EquipmentSlot value
// (HEAD 1 … AMMO 10); index 0 is unused.
const equipSlots = int(pb.EquipmentSlot_EQUIPMENT_SLOT_AMMO) + 1

// Item is one item instance. Loop goroutine only.
type Item struct {
	def   *content.Item
	count int // stack size; 1 for items that do not stack
	// mods is the instance's own data: its attribute and refine level (attributes.go).
	mods Mods
	// items is the content of a container, index 0 first.
	items []*Item

	// Where the item is: inside parent, equipped by owner in slot, or on the ground at
	// pos (onGround). Exactly one of the three.
	parent   *Item
	owner    *Player
	slot     int
	onGround bool
	pos      world.Pos

	// viewers are the players that have this container open (with their window id).
	viewers []viewer
}

type viewer struct {
	p  *Player
	id uint32
}

// Def returns the item's definition.
func (it *Item) Def() *content.Item { return it.def }

// Count returns the stack size (1 for items that do not stack).
func (it *Item) Count() int { return it.count }

// Items returns the content of a container.
func (it *Item) Items() []*Item { return it.items }

func newItem(def *content.Item, count int) *Item {
	return &Item{def: def, count: max(count, 1)}
}

// weight is the item's weight in grams, with its content.
func (it *Item) weight() int {
	w := it.def.Weight
	if it.def.Stackable {
		w *= it.count
	}
	for _, c := range it.items {
		w += c.weight()
	}
	return w
}

// root returns the outermost container holding it (it itself when it is not inside one).
func (it *Item) root() *Item {
	for it.parent != nil {
		it = it.parent
	}
	return it
}

// depth is 1 for an item that is not inside a container, plus one per container above it.
func depth(it *Item) int {
	n := 1
	for ; it.parent != nil; it = it.parent {
		n++
	}
	return n
}

// nestRefusal is the key that refuses putting it into the container c (it would hold
// itself, or nest deeper than maxDepth), or "".
func nestRefusal(it, c *Item) string {
	if it.contains(c) {
		return msgIntoItself
	}
	if depth(c)+1+it.height() > maxDepth {
		return msgTooDeep
	}
	return ""
}

// height is 0 for an item with no content, plus one per level of nested content.
func (it *Item) height() int {
	h := 0
	for _, c := range it.items {
		h = max(h, 1+c.height())
	}
	return h
}

// contains reports whether c is it or lies (at any depth) inside it.
func (it *Item) contains(c *Item) bool {
	for ; c != nil; c = c.parent {
		if c == it {
			return true
		}
	}
	return false
}

func (it *Item) stack() *pb.ItemStack {
	return &pb.ItemStack{ItemId: uint32(it.def.Numeric), Count: it.wireCount(), Mods: it.mods.msg()}
}

// wireCount is the count an ItemStack of it carries: a stack's size, a rune's charges, 0
// for anything else.
func (it *Item) wireCount() uint32 {
	if it.def.Stackable || it.def.Rune != nil {
		return uint32(it.count) // a rune's count is its charges
	}
	return 0
}

func (it *Item) stacks() []*pb.ItemStack {
	out := make([]*pb.ItemStack, len(it.items))
	for i, c := range it.items {
		out[i] = c.stack()
	}
	return out
}

// openContainer is a container window of a player.
type openContainer struct {
	id   uint32
	item *Item
}

// ---- saved state ---------------------------------------------------------------

// ItemState is a saved item: its numeric id (data/ids.lock.yaml), stack size, slot
// (pb.EquipmentSlot for an equipped item, the cell for an item in the pockets, index for
// an item inside a container), its mods (attribute and refine, attributes.go) and the
// content of a container. Pocket marks a top-level item that lies in the pockets
// (pockets.go), not in an equipment slot.
type ItemState struct {
	ItemID uint16
	Count  int
	Slot   int
	Mods   Mods
	Items  []ItemState
	Pocket bool
}

func (it *Item) state(slot int) ItemState {
	s := ItemState{ItemID: it.def.Numeric, Count: it.count, Slot: slot, Mods: it.mods}
	for i, c := range it.items {
		s.Items = append(s.Items, c.state(i))
	}
	return s
}

// inventoryStates is everything p carries as saved: the equipment, then the pockets.
func (p *Player) inventoryStates() []ItemState {
	var out []ItemState
	for slot, it := range p.equip {
		if it != nil {
			out = append(out, it.state(slot))
		}
	}
	return p.pocketStates(out)
}

// loadItem builds an item from its saved state, with its mods; unknown (retired) items
// are dropped. An equipable saved without an attribute rolls it now (instance): the next
// save of its place keeps it.
func (w *World) loadItem(s ItemState) *Item {
	def := w.byNum[s.ItemID]
	if def == nil {
		w.log.Warn("session: unknown item in saved inventory dropped", "item", s.ItemID)
		return nil
	}
	it := w.instance(def, min(s.Count, def.StackLimit()), s.Mods)
	for _, cs := range s.Items {
		if len(it.items) >= def.Slots() {
			break
		}
		if c := w.loadItem(cs); c != nil {
			c.parent = it
			it.items = append(it.items, c)
		}
	}
	return it
}

// loadInventory equips the saved items of a joining player and fills its pockets. A
// character that never played starts with balance.yaml inventory.start_container.
func (w *World) loadInventory(p *Player, saved []ItemState, fresh bool) {
	w.loadPockets(p, saved)
	for _, s := range saved {
		if s.Pocket || s.Slot <= 0 || s.Slot >= equipSlots || p.equip[s.Slot] != nil {
			continue
		}
		if it := w.loadItem(s); it != nil {
			it.owner, it.slot = p, s.Slot
			p.equip[s.Slot] = it
		}
	}
	slot := int(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK)
	if fresh && len(saved) == 0 && w.startContainer != nil && p.equip[slot] == nil {
		it := newItem(w.startContainer, 1)
		it.owner, it.slot = p, slot
		p.equip[slot] = it
	}
	w.equipmentChanged(p)
}

// ---- weight and equipment effects ----------------------------------------------

// carried is the weight p carries, in grams: its equipment and what its pockets hold.
func (p *Player) carried() int {
	n := 0
	for _, it := range p.equip {
		if it != nil {
			n += it.weight()
		}
	}
	if p.pockets != nil {
		n += p.pockets.weight() // the pockets themselves weigh nothing
	}
	return n
}

// Carried returns the weight p carries, in grams (tests and tools).
func (p *Player) Carried() int { return p.carried() }

// Equipped returns the item in an equipment slot, or nil.
func (p *Player) Equipped(slot pb.EquipmentSlot) *Item {
	if int(slot) <= 0 || int(slot) >= equipSlots {
		return nil
	}
	return p.equip[slot]
}

// equipmentChanged recomputes what the equipment gives in combat: the weapon in the
// right hand, the shield in the left and the armor of every slot; and what the others see
// p wear. Every path that changes p's equipment slots calls it.
func (w *World) equipmentChanged(p *Player) {
	p.weapon, p.shield, p.armor = nil, nil, 0
	if it := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_RIGHT_HAND]; it != nil && it.def.Weapon != nil {
		p.weapon = it.def
	}
	if it := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_LEFT_HAND]; it != nil && it.def.Shield != nil {
		p.shield = it.def
	}
	for _, it := range p.equip {
		if it != nil && it.def.Armor != nil {
			p.armor += it.def.Armor.Armor
		}
	}
	w.applyGear(p)     // the attributes of what p wears (attributes.go)
	w.showEquipment(p) // what the others see it wear (look.go)
}

var armorSlots = map[string]pb.EquipmentSlot{
	"head": pb.EquipmentSlot_EQUIPMENT_SLOT_HEAD,
	"body": pb.EquipmentSlot_EQUIPMENT_SLOT_ARMOR,
	"legs": pb.EquipmentSlot_EQUIPMENT_SLOT_LEGS,
	"feet": pb.EquipmentSlot_EQUIPMENT_SLOT_FEET,
	"neck": pb.EquipmentSlot_EQUIPMENT_SLOT_NECK,
	"ring": pb.EquipmentSlot_EQUIPMENT_SLOT_RING,
}

// slotFor returns the only equipment slot def can go in (UNSPECIFIED: none).
func slotFor(def *content.Item) pb.EquipmentSlot {
	switch {
	case def.Weapon != nil:
		return pb.EquipmentSlot_EQUIPMENT_SLOT_RIGHT_HAND
	case def.Shield != nil:
		return pb.EquipmentSlot_EQUIPMENT_SLOT_LEFT_HAND
	case def.Armor != nil:
		return armorSlots[def.Armor.Slot]
	case def.Container != nil:
		return pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK
	case def.Ammo != nil:
		return pb.EquipmentSlot_EQUIPMENT_SLOT_AMMO
	}
	return pb.EquipmentSlot_EQUIPMENT_SLOT_UNSPECIFIED
}

// canEquip checks that p may wear def in slot: the slot of its kind, the level and
// vocation it requires, the weapon types of the vocation and free hands. It returns the
// message key and parameters of the refusal, or "".
func (w *World) canEquip(p *Player, def *content.Item, slot pb.EquipmentSlot) (string, []*pb.TextParam) {
	if slotFor(def) != slot {
		return msgWrongSlot, nil
	}
	if def.Requires.Level > p.level {
		return msgLevelRequired, []*pb.TextParam{{Name: "level", Value: &pb.TextParam_Number{Number: int64(def.Requires.Level)}}}
	}
	if len(def.Requires.Vocations) > 0 && !slices.Contains(def.Requires.Vocations, p.vocation.ID) {
		return msgVocationCannot, nil
	}
	if def.Weapon != nil && len(p.vocation.Weapons) > 0 && !slices.Contains(p.vocation.Weapons, def.Weapon.Type) {
		return msgVocationCannot, nil
	}
	right, left := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_RIGHT_HAND], p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_LEFT_HAND]
	if def.Weapon != nil && def.Weapon.Hands == 2 && left != nil {
		return msgHandsFull, nil
	}
	if slot == pb.EquipmentSlot_EQUIPMENT_SLOT_LEFT_HAND && right != nil && right.def.Weapon != nil && right.def.Weapon.Hands == 2 {
		return msgHandsFull, nil
	}
	return "", nil
}

// ---- locations ----------------------------------------------------------------

type locKind uint8

const (
	locGround locKind = iota + 1
	locSlot
	locContainer
)

// place is a resolved ItemLocation: a tile, an equipment slot of the player, or an
// open container (the player's pockets too: a container that is never a window).
type place struct {
	kind locKind
	pos  world.Pos
	slot pb.EquipmentSlot
	cont *Item
}

// near reports whether a ground position is within reach of p (same floor).
func (w *World) near(p *Player, pos world.Pos) bool {
	return pos.Z == p.pos.Z && chebyshev(p.pos, pos) <= w.reach
}

// reaches reports whether p can still use container c: it is in p's equipment, or lies
// on a tile within reach.
func (w *World) reaches(p *Player, c *Item) bool {
	r := c.root()
	switch {
	case r.owner != nil:
		return r.owner == p
	case r.onGround:
		return w.near(p, r.pos)
	}
	return false
}

// carriedBy returns the player whose equipment holds it (at any depth), or nil.
func (it *Item) carriedBy() *Player { return it.root().owner }

func (p *Player) openByID(id uint32) *Item {
	for _, o := range p.open {
		if o.id == id {
			return o.item
		}
	}
	return nil
}

// staticCount is how many entries the client sees below the dynamic items of pos: the
// ground and the items of world.bin.
func (w *World) staticCount(pos world.Pos) int { return 1 + len(w.m.Stack(pos)) }

// itemAt resolves the item a client action points at. stale views (another item, an
// index out of range, a closed container) give nil. A tile p does not see gives nil too,
// before looking at it: otherwise the answer (too far or not possible) would tell what
// lies on any tile of any floor (T4.1).
func (w *World) itemAt(p *Player, loc *pb.ItemLocation, itemID, index uint32) (*Item, place) {
	switch l := loc.GetLocation().(type) {
	case *pb.ItemLocation_Pos:
		pos, ok := posFromMsg(l.Pos)
		if !ok || pos.Z != p.pos.Z || !Sees(p.pos, pos) {
			return nil, place{}
		}
		i := int(index) - w.staticCount(pos)
		g := w.ground[pos]
		if i < 0 || i >= len(g) || uint32(g[i].def.Numeric) != itemID {
			return nil, place{}
		}
		return g[i], place{kind: locGround, pos: pos}
	case *pb.ItemLocation_Slot:
		if int(l.Slot) <= 0 || int(l.Slot) >= equipSlots {
			return nil, place{}
		}
		it := p.equip[l.Slot]
		if it == nil || uint32(it.def.Numeric) != itemID {
			return nil, place{}
		}
		return it, place{kind: locSlot, slot: l.Slot}
	case *pb.ItemLocation_Container:
		c := p.openByID(l.Container.GetContainerId())
		i := int(l.Container.GetIndex())
		if c == nil || i >= len(c.items) || uint32(c.items[i].def.Numeric) != itemID {
			return nil, place{}
		}
		return c.items[i], place{kind: locContainer, cont: c}
	case *pb.ItemLocation_Pocket:
		c := p.pockets
		if c == nil || l.Pocket >= uint32(len(c.items)) || uint32(c.items[l.Pocket].def.Numeric) != itemID {
			return nil, place{}
		}
		return c.items[l.Pocket], place{kind: locContainer, cont: c}
	}
	return nil, place{}
}

// destination resolves where a MoveItem puts an item. A container slot or an equipment
// slot holding a container means "into that container".
func (w *World) destination(p *Player, loc *pb.ItemLocation) (place, bool) {
	switch l := loc.GetLocation().(type) {
	case *pb.ItemLocation_Pos:
		pos, ok := posFromMsg(l.Pos)
		return place{kind: locGround, pos: pos}, ok
	case *pb.ItemLocation_Slot:
		if int(l.Slot) <= 0 || int(l.Slot) >= equipSlots {
			return place{}, false
		}
		if it := p.equip[l.Slot]; it != nil && it.def.Container != nil {
			return place{kind: locContainer, cont: it}, true
		}
		return place{kind: locSlot, slot: l.Slot}, true
	case *pb.ItemLocation_Container:
		c := p.openByID(l.Container.GetContainerId())
		if c == nil {
			return place{}, false
		}
		if i := int(l.Container.GetIndex()); i < len(c.items) && c.items[i].def.Container != nil {
			return place{kind: locContainer, cont: c.items[i]}, true
		}
		return place{kind: locContainer, cont: c}, true
	case *pb.ItemLocation_Pocket:
		c := p.pockets
		if c == nil {
			return place{}, false
		}
		if l.Pocket < uint32(len(c.items)) && c.items[l.Pocket].def.Container != nil {
			return place{kind: locContainer, cont: c.items[l.Pocket]}, true
		}
		return place{kind: locContainer, cont: c}, true
	}
	return place{}, false
}

func posFromMsg(m *pb.Position) (world.Pos, bool) {
	if m == nil || m.X > 0xFFFF || m.Y > 0xFFFF || m.Z > 0xFF {
		return world.Pos{}, false
	}
	return world.Pos{X: uint16(m.X), Y: uint16(m.Y), Z: uint8(m.Z)}, true
}

// ---- MoveItem ------------------------------------------------------------------

// moveItem validates and runs a MoveItem intent. The server checks reach, the slot,
// the level and vocation for equipment, stacking, container room and capacity.
func (w *World) moveItem(ctx *game.TickContext, p *Player, m *pb.MoveItem) {
	it, from := w.itemAt(p, m.GetFrom(), m.GetItemId(), m.GetStackIndex())
	if it == nil {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	if from.kind == locGround && !w.near(p, from.pos) || from.kind == locContainer && !w.reaches(p, from.cont) {
		p.emit(systemMsg(msgTooFar))
		return
	}
	if from.kind == locContainer && w.reserved(ctx.Tick, p, it) {
		p.emit(systemMsg(msgNotOwner))
		return
	}
	if w.groundHeld(p, it) { // T5.3 fail-safe: fell at the feet of a held player
		p.emit(systemMsg(msgNotYours))
		return
	}
	if !it.def.CanPickUp() {
		p.emit(systemMsg(msgCannotMove))
		return
	}
	count := it.count
	if it.def.Stackable {
		count = int(m.GetCount())
		if count < 1 || count > it.count {
			p.emit(systemMsg(msgNotPossible))
			return
		}
	}
	to, ok := w.destination(p, m.GetTo())
	if !ok {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	// T5.3 fail-safe: what leaves a house floor for the public ground is reserved to p
	// until the database has the house write that took it out (leftHouse). So it lands as
	// a pile of its own, or in a pile or container already reserved to p: never in
	// someone else's (a reservation must not take over a stranger's pile, bag or corpse).
	leaving := w.itemHouse(it) != nil && w.publicGround(to)

	// Where the units go: an existing stack they merge into, or a new place.
	var merge *Item
	switch to.kind {
	case locGround:
		if !w.near(p, to.pos) {
			p.emit(systemMsg(msgTooFar))
			return
		}
		if _, _, exists := w.m.Tile(to.pos); !exists || !w.m.Walkable(to.pos) {
			p.emit(systemMsg(msgNotPossible))
			return
		}
		if from.kind == locGround && from.pos == to.pos {
			return // dropped where it already is
		}
		// Dropped onto stairs, a hole or a teleport: it falls through to the other end
		// (portal.go fallTo), and from here on it is a drop there. Neither end is a house
		// tile (world.NewMap), nor is where it lands: leaving stays right.
		if pt := w.stepPortal(to.pos); pt != nil {
			at, ok := w.fallTo(p, it, count, pt, leaving)
			if !ok {
				p.emit(systemMsg(msgPortalNoRoom))
				return
			}
			if to.pos = at; from.kind == locGround && from.pos == to.pos {
				return // a teleport of one floor back to where it lies
			}
		}
		merge = w.groundMerge(p, it, count, to.pos, leaving)
		if merge == nil && len(w.ground[to.pos]) >= maxGroundItems {
			p.emit(systemMsg(msgTileFull))
			return
		}
	case locSlot:
		if from.kind == locSlot && from.slot == to.slot {
			return
		}
		if p.intoBackpack(it, to) { // no backpack: it goes to the pockets (pockets.go)
			if from.kind == locContainer && from.cont == p.pockets {
				return // already there
			}
			if key := nestRefusal(it, p.pockets); key != "" { // a container worn elsewhere
				p.emit(systemMsg(key))
				return
			}
			into, ok := p.pocketRoom(it, count)
			if !ok {
				p.emit(systemMsg(msgContainerFull))
				return
			}
			to, merge = place{kind: locContainer, cont: p.pockets}, into
			break
		}
		if key, params := w.canEquip(p, it.def, to.slot); key != "" {
			p.emit(systemMsg(key, params...))
			return
		}
		if cur := p.equip[to.slot]; cur != nil {
			if merge = mergeTarget([]*Item{cur}, it, count); merge == nil {
				p.emit(systemMsg(msgSlotOccupied))
				return
			}
		}
	case locContainer:
		if !w.reaches(p, to.cont) {
			p.emit(systemMsg(msgTooFar))
			return
		}
		if w.reserved(ctx.Tick, p, to.cont) { // another player's corpse, still its owner's
			p.emit(systemMsg(msgNotOwner))
			return
		}
		if w.groundHeld(p, to.cont) { // T5.3: a container reserved to another player (hold.go)
			p.emit(systemMsg(msgNotYours))
			return
		}
		if leaving && !w.heldFor(p, to.cont) { // T5.3: see leaving
			p.emit(systemMsg(msgFloorFirst))
			return
		}
		if key := nestRefusal(it, to.cont); key != "" {
			p.emit(systemMsg(key))
			return
		}
		if from.kind == locContainer && from.cont == to.cont {
			return // no reordering inside a container yet
		}
		merge = mergeTarget(to.cont.items, it, count)
		if merge == nil && len(to.cont.items) >= to.cont.def.Slots() {
			// A full backpack: a pickup goes on to the pockets (pockets.go).
			ok := false
			if p.intoBackpack(it, to) && (from.kind != locContainer || from.cont != p.pockets) {
				merge, ok = p.pocketRoom(it, count)
			}
			if !ok {
				p.emit(systemMsg(msgContainerFull))
				return
			}
			to.cont = p.pockets
		}
	}

	// T5.4: houses (access, only the owner takes items out, item limit, anti-flood).
	if !w.checkHouseMove(ctx, p, it, to, merge, count < it.count) {
		return
	}
	// T5.3 fail-safe: nothing p carries goes to the floor while a transfer of p is not
	// in the database yet (normally a tick or two).
	if w.heldDrop(p, it, to) {
		p.emit(systemMsg(msgSaving))
		return
	}
	// Capacity: only what enters p's equipment from outside it weighs on p.
	var toOwner *Player
	switch to.kind {
	case locSlot:
		toOwner = p
	case locContainer:
		toOwner = to.cont.carriedBy()
	}
	if toOwner == p && it.carriedBy() != p {
		moved := it.weight()
		if count < it.count {
			moved = it.def.Weight * count
		}
		if moved > p.capacity-p.carried() {
			p.emit(systemMsg(msgTooHeavy))
			return
		}
	}

	// Economy ledger (T4.1): what crosses between a character and the ground.
	if from := it.carriedBy(); from != toOwner {
		h := measure(it, count)
		if from != nil {
			from.ground(h, -1)
		}
		if toOwner != nil {
			toOwner.ground(h, 1)
		}
	}

	pickedUp := toOwner == p && it.carriedBy() != p
	// T5.3 fail-safe: something p carries goes where no save has it (hold.go gaveAway).
	gave := it.carriedBy() == p && w.publicGround(to)

	// Run it: take the units out of their place and put them in the new one (one
	// Inventory for both ends: the pockets or a slot on each side).
	before := p.carried()
	release := w.holdInventory(p)
	moving := it
	if count < it.count {
		it.count -= count
		moving = newItem(it.def, count)
		moving.mods = it.mods // a split keeps the instance's data (stackables have none)
		w.changed(it)
	} else {
		w.detach(it)
		w.changedPlace(p, from)
	}
	landed := moving
	if merge != nil {
		merge.count += moving.count
		w.changed(merge)
		landed = merge
	} else {
		w.attach(p, moving, to)
		w.changedPlace(p, to)
	}
	release()
	if leaving {
		w.leftHouse(p, landed.root())
	}
	if moving.def.Container != nil {
		w.closeUnreachable(moving)
	}
	if from.kind == locSlot || to.kind == locSlot {
		w.equipmentChanged(p)
	}
	if gave {
		// Reservable only as a pile of its own or into what is reserved to p already
		// (hold.go reserveGiven): never a stranger's pile or bag.
		var root *Item
		if r := landed.root(); r.onGround && (merge == nil && to.kind == locGround || w.heldFor(p, r)) {
			root = r
		}
		w.gaveAway(p, root)
	}
	// KindOther, not KindItem: a move has no cooldown, and must not clear a refused use,
	// gathering or crafting try (earlyTry).
	p.active(ctx.Tick, antibot.KindOther)
	if p.carried() != before {
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	}
	// One tutorial event per move: equipping from the ground is an equip.
	if to.kind == locSlot {
		w.tutorialEvent(p, content.TriggerEquip, moving.def.ID)
	} else if pickedUp {
		w.tutorialEvent(p, content.TriggerPickUp, moving.def.ID)
	}
}

// groundMerge returns the pile of pos that count units of it, dropped there by p, join, or
// nil (they land as a new pile). T5.3: never a pile reserved to another player, and for
// what leaves a house (leaving) only one already reserved to p (hold.go).
func (w *World) groundMerge(p *Player, it *Item, count int, pos world.Pos, leaving bool) *Item {
	return mergeTargetIf(w.ground[pos], it, count, func(c *Item) bool {
		return !w.groundHeld(p, c) && (!leaving || w.heldFor(p, c))
	})
}

// mergeTarget returns the stack among list that count units of it can join, or nil.
func mergeTarget(list []*Item, it *Item, count int) *Item {
	return mergeTargetIf(list, it, count, nil)
}

// mergeTargetIf is mergeTarget among the stacks ok accepts (nil: any).
func mergeTargetIf(list []*Item, it *Item, count int, ok func(*Item) bool) *Item {
	if !it.def.Stackable || !it.mods.Zero() {
		return nil // an instance with mods never stacks (attributes.go)
	}
	for _, c := range list {
		if c != it && c.def.Numeric == it.def.Numeric && c.mods.Zero() && c.count+count <= it.def.StackLimit() &&
			(ok == nil || ok(c)) {
			return c
		}
	}
	return nil
}

// detach takes it out of its place.
func (w *World) detach(it *Item) {
	switch {
	case it.parent != nil:
		c := it.parent
		for i, x := range c.items {
			if x == it {
				c.items = append(c.items[:i], c.items[i+1:]...)
				break
			}
		}
		it.parent = nil
	case it.owner != nil:
		it.owner.equip[it.slot] = nil
		it.owner, it.slot = nil, 0
	case it.onGround:
		g := w.ground[it.pos]
		for i, x := range g {
			if x == it {
				g = append(g[:i], g[i+1:]...)
				break
			}
		}
		if len(g) == 0 {
			delete(w.ground, it.pos)
		} else {
			w.ground[it.pos] = g
		}
		it.onGround = false
		delete(w.heldGround, it) // T5.3: a reservation ends when the item leaves the ground
	}
}

// attach puts a detached item in place to of p (the slot must be free).
func (w *World) attach(p *Player, it *Item, to place) {
	switch to.kind {
	case locGround:
		w.drop(it, to.pos)
	case locSlot:
		it.owner, it.slot = p, int(to.slot)
		p.equip[to.slot] = it
	case locContainer:
		it.parent = to.cont
		to.cont.items = append(to.cont.items, it)
	}
}

// drop puts a detached item on top of the dynamic items of pos.
func (w *World) drop(it *Item, pos world.Pos) {
	it.onGround, it.pos = true, pos
	w.ground[pos] = append(w.ground[pos], it)
}

// changed sends the new state of the place that holds it.
func (w *World) changed(it *Item) {
	switch {
	case it.parent != nil:
		w.containerChanged(it.parent)
	case it.owner != nil:
		w.sendInventory(it.owner)
	case it.onGround:
		w.tileChanged(it.pos)
	}
}

func (w *World) changedPlace(p *Player, pl place) {
	switch pl.kind {
	case locGround:
		w.tileChanged(pl.pos)
	case locSlot:
		w.sendInventory(p)
	case locContainer:
		w.containerChanged(pl.cont)
	}
}

// sendInventory sends p its equipment and what its pockets hold, or marks it due while a
// holdInventory is open.
func (w *World) sendInventory(p *Player) {
	p.questDirty = true
	if p.invHold > 0 {
		p.invDue = true
		return
	}
	inv := &pb.Inventory{}
	for slot, it := range p.equip {
		if it != nil {
			inv.Slots = append(inv.Slots, &pb.EquippedItem{Slot: pb.EquipmentSlot(slot), Item: it.stack()})
		}
	}
	if pk := p.pockets; pk != nil {
		inv.Pockets, inv.PocketSlots = pk.stacks(), uint32(pk.def.Slots())
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_Inventory{Inventory: inv}})
}

// holdInventory holds p's Inventory back until the returned release runs: one change that
// touches the equipment or the pockets more than once (a move from the pockets to a slot,
// a give of several stacks) sends one Inventory, with the state at the release, instead
// of one per place. Holds nest; only the outermost release sends.
func (w *World) holdInventory(p *Player) (release func()) {
	p.invHold++
	return func() {
		if p.invHold--; p.invHold == 0 && p.invDue {
			p.invDue = false
			w.sendInventory(p)
		}
	}
}

// containerChanged sends the content of c to everyone who has it open; what the pockets
// hold goes to their player in its Inventory.
func (w *World) containerChanged(c *Item) {
	if isPockets(c) {
		w.sendInventory(c.owner)
		return
	}
	if r := c.root(); r.owner != nil {
		r.owner.questDirty = true
	} else if r.onGround {
		w.houseTouched(r.pos) // T5.4: a container lying in a house
	}
	for _, v := range c.viewers {
		v.p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_ContainerUpdate{ContainerUpdate: &pb.ContainerUpdate{
			ContainerId: v.id, Items: c.stacks(),
		}}})
	}
}

// ---- containers ---------------------------------------------------------------

// toggleContainer opens c for p in a new window, or closes it if it is already open.
// When p has inventory.max_open_containers windows the oldest one closes.
func (w *World) toggleContainer(p *Player, c *Item) {
	for _, o := range p.open {
		if o.item == c {
			w.closeContainer(p, o.id)
			return
		}
	}
	if len(p.open) >= w.maxOpen {
		w.closeContainer(p, p.open[0].id)
	}
	p.nextContainer++
	id := p.nextContainer
	p.open = append(p.open, openContainer{id: id, item: c})
	c.viewers = append(c.viewers, viewer{p: p, id: id})
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_ContainerOpen{ContainerOpen: &pb.ContainerOpen{
		ContainerId: id, ItemId: uint32(c.def.Numeric), Capacity: uint32(c.def.Slots()),
		Items: c.stacks(), HasParent: c.parent != nil,
	}}})
	w.tutorialEvent(p, content.TriggerOpenContainer, c.def.ID)
}

// closeContainer closes p's window id (if open) and tells the client.
func (w *World) closeContainer(p *Player, id uint32) {
	for i, o := range p.open {
		if o.id != id {
			continue
		}
		p.open = append(p.open[:i], p.open[i+1:]...)
		c := o.item
		for j, v := range c.viewers {
			if v.p == p && v.id == id {
				c.viewers = append(c.viewers[:j], c.viewers[j+1:]...)
				break
			}
		}
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_ContainerClose{ContainerClose: &pb.ContainerClose{ContainerId: id}}})
		return
	}
}

// closeUnreachable closes the windows of it and of the containers inside it that their
// viewers can no longer reach (the container moved away from them).
func (w *World) closeUnreachable(it *Item) {
	for i := len(it.viewers) - 1; i >= 0; i-- {
		if v := it.viewers[i]; !w.reaches(v.p, it) {
			w.closeContainer(v.p, v.id)
		}
	}
	for _, c := range it.items {
		if c.def.Container != nil {
			w.closeUnreachable(c)
		}
	}
}

// closeAll closes the windows of it and of everything inside it (it is going away).
func (w *World) closeAll(it *Item) {
	for len(it.viewers) > 0 {
		v := it.viewers[len(it.viewers)-1]
		w.closeContainer(v.p, v.id)
	}
	for _, c := range it.items {
		w.closeAll(c)
	}
}

// checkContainers closes the windows p can no longer reach (after p moved).
func (w *World) checkContainers(p *Player) {
	for i := len(p.open) - 1; i >= 0; i-- {
		if i < len(p.open) && !w.reaches(p, p.open[i].item) {
			w.closeContainer(p, p.open[i].id)
		}
	}
}

// forgetContainers drops p from the viewers of its open windows (p leaves the world).
func (w *World) forgetContainers(p *Player) {
	for _, o := range p.open {
		c := o.item
		for j, v := range c.viewers {
			if v.p == p {
				c.viewers = append(c.viewers[:j], c.viewers[j+1:]...)
				break
			}
		}
	}
	p.open = nil
}

// ---- UseItem and LookAt --------------------------------------------------------

// useItem runs a UseItem intent: containers open or close, consumables heal and are
// eaten, runes are cast (T1.9), crafting stations of the map open (T3.4), doors of the
// map open and close (door.go), ladders are climbed (portal.go), reward chests give
// their rewards once (chest.go).
func (w *World) useItem(ctx *game.TickContext, p *Player, m *pb.UseItem) {
	if w.useDoor(ctx, p, m) || w.useHouseDoor(ctx, p, m) || w.useMarketBoard(ctx, p, m) || w.usePortal(ctx, p, m) ||
		w.useChest(ctx, p, m) || w.useStation(p, m) {
		return
	}
	it, from := w.itemAt(p, m.GetFrom(), m.GetItemId(), m.GetStackIndex())
	if it == nil {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	if from.kind == locGround && !w.near(p, from.pos) || from.kind == locContainer && !w.reaches(p, from.cont) {
		p.emit(systemMsg(msgTooFar))
		return
	}
	if from.kind == locContainer && it.def.Container == nil && w.reserved(ctx.Tick, p, it) {
		p.emit(systemMsg(msgNotOwner))
		return
	}
	if it.def.Container == nil && w.groundHeld(p, it) {
		p.emit(systemMsg(msgNotYours))
		return
	}
	if !w.mayUseInHouse(p, it) {
		return
	}
	switch {
	case it.def.Container != nil:
		w.toggleContainer(p, it)
	case it.def.Consumable != nil:
		if ctx.Tick < p.nextUse {
			p.tooEarly(ctx.Tick, antibot.KindItem)
			p.emit(systemMsg(msgNotReady))
			return
		}
		if w.stomachFull(p, it.def) {
			p.emit(systemMsg(msgFull)) // nothing eaten: no cooldown either
			return
		}
		p.activePaced(ctx.Tick, antibot.KindItem, p.nextUse)
		p.nextUse = ctx.Tick + w.useFor
		def := it.def
		w.consume(ctx, p, it)
		w.tutorialEvent(p, content.TriggerUseItem, def.ID)
	case it.def.Rune != nil:
		w.useRune(ctx, p, it, nil) // on the current target, or the caster for a heal
	default:
		p.emit(systemMsg(msgCannotUse))
	}
}

// consume eats or drinks one unit of a consumable: it heals, restores mana and, food,
// feeds (the well_fed condition, content audit m2).
func (w *World) consume(ctx *game.TickContext, p *Player, it *Item) {
	c := it.def.Consumable
	hp := min(c.HealHP, p.maxHealth-p.health)
	mp := min(c.HealMP, p.maxMana-p.mana)
	pct := healthPercent(p.health, p.maxHealth)
	p.health += hp
	p.mana += mp
	if c.FoodMs > 0 {
		w.feed(ctx, p, c.FoodMs)
	}
	w.useUp(p, it)
	if c.HealHP > 0 {
		w.abHeal(w.nowTick(), p) // bot detection: how fast p heals after a hit (T4.1)
	}
	if c.HealHP == 0 && c.HealMP == 0 {
		p.emit(systemMsg(msgAte, &pb.TextParam{Name: "item", Value: &pb.TextParam_Item{Item: &pb.ItemStack{ItemId: uint32(it.def.Numeric)}}}))
	}
	if hp > 0 {
		w.eachWatcher(p, func(o *Player) {
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_FloatingText{FloatingText: &pb.FloatingText{
				Pos: posMsg(p.pos), Kind: pb.FloatingTextKind_FLOATING_TEXT_KIND_HEAL, Amount: uint64(hp),
			}}})
		})
		if now := healthPercent(p.health, p.maxHealth); now != pct {
			w.eachWatcher(p, func(o *Player) {
				if o == p {
					return
				}
				o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureHealth{CreatureHealth: &pb.CreatureHealth{Id: p.id, HealthPercent: now}}})
			})
		}
	}
	if mp > 0 {
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_FloatingText{FloatingText: &pb.FloatingText{
			Pos: posMsg(p.pos), Kind: pb.FloatingTextKind_FLOATING_TEXT_KIND_MANA, Amount: uint64(mp),
		}}})
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
}

// useUp spends one unit (or charge) of it, used by p; the last one removes it.
func (w *World) useUp(p *Player, it *Item) {
	if it.def.Stackable || it.count <= 1 { // a rune's charge is not a unit: only its last one
		if o := it.carriedBy(); o != nil {
			w.econItem(o, EconConsume, "", it.def, -1)
		} else {
			w.econWorld(p.charID, EconConsume, "", it.def, -1) // on the ground: no ledger moves
		}
	}
	if it.count > 1 {
		it.count--
		w.changed(it)
		return
	}
	parent, owner, ground, pos := it.parent, it.owner, it.onGround, it.pos
	w.detach(it)
	switch {
	case parent != nil:
		w.containerChanged(parent)
	case owner != nil:
		w.sendInventory(owner)
		w.equipmentChanged(owner)
	case ground:
		w.tileChanged(pos)
	}
}

// lookAt answers a LookAt with a system message: the item (the client adds its
// translated name and description), its weight in grams and its combat numbers. Any
// visible item can be looked at, including the ground and the map's own items; the
// ground and fixed items (pickupable: false, not containers) say only their name. An
// instance goes with its mods (a refined one is named "+7 sword") and its numbers with
// what its refine level adds (the forge, refine.go refinedStat).
func (w *World) lookAt(p *Player, m *pb.LookAt) {
	var def *content.Item
	var inst *Item
	weight, count := 0, 0
	if pos, ok := posFromMsg(m.GetFrom().GetPos()); ok {
		if pos.Z != p.pos.Z || !Sees(p.pos, pos) {
			p.emit(systemMsg(msgTooFar))
			return
		}
		i := int(m.GetStackIndex())
		ground, _, exists := w.m.Tile(pos)
		static := w.m.Stack(pos)
		switch {
		case !exists:
		case i == 0:
			def = w.byNum[ground]
		case i <= len(static):
			def = w.byNum[static[i-1]]
		}
		if def != nil {
			if uint32(def.Numeric) != m.GetItemId() {
				def = nil
			} else {
				weight, count = def.Weight, 1
			}
		}
	}
	if def == nil {
		it, from := w.itemAt(p, m.GetFrom(), m.GetItemId(), m.GetStackIndex())
		if it == nil {
			p.emit(systemMsg(msgNotPossible))
			return
		}
		if from.kind == locContainer && !w.reaches(p, from.cont) {
			p.emit(systemMsg(msgTooFar))
			return
		}
		def, weight, count, inst = it.def, it.weight(), it.count, it
	}
	stack := &pb.ItemStack{ItemId: uint32(def.Numeric)}
	if def.Stackable || def.Rune != nil {
		stack.Count = uint32(count)
	}
	refined := 0
	if inst != nil {
		stack.Mods = inst.mods.msg()
		refined = w.refinedStat(inst)
	}
	num := func(name string, v int) *pb.TextParam {
		return &pb.TextParam{Name: name, Value: &pb.TextParam_Number{Number: int64(v)}}
	}
	params := []*pb.TextParam{{Name: "item", Value: &pb.TextParam_Item{Item: stack}}}
	key := msgLookItem
	switch {
	case def.Kind == "ground", !def.CanPickUp() && def.Container == nil:
		// The ground and the map's fixed items (a sign, an anvil, a tree) have no weight to
		// tell: their name (the client adds the description, a sign's text) is the answer.
		p.emit(systemMsg(msgLookGround, params...))
		return
	case def.Weapon != nil:
		key = msgLookWeapon
		params = append(params, num("attack", def.Weapon.Attack+refined), num("defense", def.Weapon.Defense))
	case def.Armor != nil:
		key = msgLookArmor
		params = append(params, num("armor", def.Armor.Armor+refined))
	case def.Shield != nil:
		key = msgLookShield
		params = append(params, num("defense", def.Shield.Defense+refined))
	case def.Container != nil:
		key = msgLookContainer
		params = append(params, num("slots", def.Slots()))
	}
	params = append(params, num("weight", weight))
	if def.Requires.Level > 0 {
		params = append(params, num("level", def.Requires.Level))
	}
	p.emit(systemMsg(key, params...))
}

// initItems indexes the item definitions and reads balance.yaml inventory. Missing
// values (tests) default to reach 1 and 16 open containers.
func (w *World) initItems() error {
	inv := w.cfg.Balance.Inventory
	w.byNum = w.cfg.Items.ByNumeric()
	w.reach = max(inv.Reach, 1)
	w.maxOpen = inv.MaxOpenContainers
	if w.maxOpen <= 0 {
		w.maxOpen = 16
	}
	w.useFor = ticksFor(max(inv.UseCooldownMs, 1))
	w.initPockets()
	if inv.StartContainer != "" {
		def := w.cfg.Items[inv.StartContainer]
		if def == nil || def.Container == nil {
			return fmt.Errorf("session: inventory.start_container %q is not a container item", inv.StartContainer)
		}
		w.startContainer = def
	}
	return nil
}
