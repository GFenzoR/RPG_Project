package session

import (
	"fmt"
	"sort"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/dialog"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// System messages of NPCs, dialogs, shops and quests (i18n keys).
const (
	msgNPCTooFar = "dialog.too_far"
	// msgDialogPriceChanged: the price an option showed was for another level (M6).
	msgDialogPriceChanged = "dialog.price_changed"
	msgShopNoMoney        = "shop.no_money"
	msgShopNotEnough      = "shop.not_enough"
	msgShopNoRoom         = "shop.no_room"
	msgShopBought         = "shop.bought"
	msgShopSold           = "shop.sold"
	msgItemOnFloor        = "dialog.item_on_floor"
	msgQuestStarted       = "dialog.quest_started"
	msgQuestUpdated       = "dialog.quest_updated"
	msgQuestKills         = "dialog.quest_kills"
	msgQuestDone          = "dialog.quest_completed"
	// msgQuestDrop: a quest drop (loot each_player) went to the player (content audit m9).
	msgQuestDrop    = "dialog.quest_drop"
	msgPaid         = "dialog.paid"
	msgReceivedGold = "dialog.received_gold"
)

const (
	// TalkRange is how far (Chebyshev, same floor) a player may stand from an NPC to
	// talk or trade; walking farther closes the dialog.
	TalkRange = 3
	// maxShopCount is the most units one ShopBuy or ShopSell may move.
	maxShopCount = 100
	// blessKey is the storage key prefix of the blessings a player holds (T1.11 uses
	// them on death).
	blessKey = "bless."
)

// NPC is a non-player character standing on its tile. Loop goroutine only.
type NPC struct {
	id   uint32
	def  *content.NPC
	pos  world.Pos
	shop []shopLine
	// dev: the NPC stands on a dev-only island (world.Island.Dev), the only place where
	// its dev-only dialog actions run.
	dev bool
	// look is its body and what it wears (look.go), shared by its Creatures.
	look creatureLookMsgs
}

// ID returns the NPC's creature id.
func (n *NPC) ID() uint32 { return n.id }

// Kind returns the NPC's data/npcs id.
func (n *NPC) Kind() string { return n.def.ID }

// Pos returns where the NPC stands.
func (n *NPC) Pos() world.Pos { return n.pos }

// shopLine is one item of a shop: what the player pays (buy, 0 = not sold) and gets
// (sell, 0 = not bought).
type shopLine struct {
	def       *content.Item
	buy, sell int64
}

// openDialog is a player's dialog window with an NPC.
type openDialog struct {
	id   uint32
	npc  *NPC
	node string
	shop bool
	// level is the player's level when the node was sent: the prices its options showed
	// ({price} of a blessing, content audit M6) were for it.
	level int
}

// NPCs returns the NPCs in the world, ordered by creature id.
func (w *World) NPCs() []*NPC { return w.npcs }

// Storage returns a player's quest_state value (tests, tools). Loop goroutine only.
func (p *Player) Storage(key string) int64 { return p.storage.Get(key) }

// QuestState returns where p is in quest id.
func (w *World) QuestState(p *Player, id string) (quest.State, string) {
	return w.quests.State(p.storage, id)
}

func (w *World) initNPCs() error {
	w.npcByID = map[uint32]*NPC{}
	w.npcAt = map[world.Pos]*NPC{}
	w.nsectors = map[uint64][]*NPC{}
	w.quests = quest.NewEngine(w.cfg.Quests)
	for _, it := range w.cfg.Items {
		if it.Currency != nil && it.Currency.Worth > 0 {
			w.coins = append(w.coins, it)
		}
	}
	sort.Slice(w.coins, func(i, j int) bool {
		a, b := w.coins[i], w.coins[j]
		if a.Currency.Worth != b.Currency.Worth {
			return a.Currency.Worth > b.Currency.Worth
		}
		return a.ID < b.ID
	})
	if w.cfg.NPCs == nil {
		return nil
	}
	if err := content.CheckRefs(w.cfg.NPCs, w.cfg.Quests, w.cfg.Items, w.cfg.Monsters, w.skillIDs); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	for _, msg := range content.RefWarnings(w.cfg.NPCs, w.cfg.Quests) {
		w.log.Warn("content: dialog condition that likely is a mistake", "detail", msg)
	}
	for _, is := range w.m.Islands() {
		for _, pl := range is.NPCs {
			def := w.cfg.NPCs[pl.NPC]
			if def == nil {
				return fmt.Errorf("session: island %q places unknown NPC %q", is.ID, pl.NPC)
			}
			// make validate refuses it too; dialogChoose checks again (dialog.Check).
			if err := content.CheckDevPlacement(def, is.ID, is.Dev); err != nil {
				return fmt.Errorf("session: %w", err)
			}
			w.nextID++
			n := &NPC{id: w.nextID, def: def, pos: pl.Pos, dev: is.Dev}
			if def.Look != nil && w.cfg.Looks != nil {
				// make validate refuses it too (packages/content-schema checkLooks).
				if err := w.cfg.Looks.CheckCreature(*def.Look); err != nil {
					return fmt.Errorf("session: npc %q: %w", def.ID, err)
				}
				n.look = w.creatureLook(def.Look)
			}
			if s := def.Shop; s != nil {
				byItem := map[string]int{}
				line := func(item string) *shopLine {
					if i, ok := byItem[item]; ok {
						return &n.shop[i]
					}
					byItem[item] = len(n.shop)
					n.shop = append(n.shop, shopLine{def: w.cfg.Items[item]})
					return &n.shop[len(n.shop)-1]
				}
				for _, o := range s.Sells {
					line(o.Item).buy = o.Price
				}
				for _, o := range s.Buys {
					line(o.Item).sell = o.Price
				}
			}
			w.npcs = append(w.npcs, n)
			w.npcByID[n.id] = n
			w.npcAt[n.pos] = n
			k := sectorKey(int(n.pos.X), int(n.pos.Y), n.pos.Z)
			w.nsectors[k] = append(w.nsectors[k], n)
		}
	}
	return nil
}

// eachNPCInRect calls fn for every NPC in [x0, x1] x [y0, y1] on a floor seen with z.
func (w *World) eachNPCInRect(x0, y0, x1, y1 int, z uint8, fn func(*NPC)) {
	if len(w.npcs) == 0 {
		return
	}
	x0, y0 = max(x0, 0), max(y0, 0)
	x1, y1 = min(x1, 0xFFFF), min(y1, 0xFFFF)
	var floors [SeaLevel + 1]uint8
	for _, f := range viewFloors(z, floors[:0]) {
		for sy := y0 / world.SectorSize; sy <= y1/world.SectorSize; sy++ {
			for sx := x0 / world.SectorSize; sx <= x1/world.SectorSize; sx++ {
				for _, n := range w.nsectors[uint64(f)<<32|uint64(sx)<<16|uint64(sy)] {
					x, y := int(n.pos.X), int(n.pos.Y)
					if x >= x0 && x <= x1 && y >= y0 && y <= y1 {
						fn(n)
					}
				}
			}
		}
	}
}

func (w *World) npcMsg(n *NPC) *pb.Creature {
	return &pb.Creature{
		Id:            n.id,
		Kind:          pb.CreatureKind_CREATURE_KIND_NPC,
		ContentId:     n.def.ID,
		Pos:           posMsg(n.pos),
		Dir:           dirMsg(world.South),
		HealthPercent: 100,
		Look:          n.look.look,
		Worn:          n.look.worn,
	}
}

// ---- dialogs ------------------------------------------------------------------------

func (w *World) inTalkRange(p *Player, n *NPC) bool {
	return p.pos.Z == n.pos.Z && chebyshev(p.pos, n.pos) <= TalkRange
}

// npcTalk opens the dialog of an NPC the client knows and that is close enough.
func (w *World) npcTalk(p *Player, id uint32) {
	n := w.npcByID[id]
	if n == nil || !p.Knows(id) || n.def.Dialog.Start == "" {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	if !w.inTalkRange(p, n) {
		p.emit(systemMsg(msgNPCTooFar))
		return
	}
	w.closeDialog(p)
	p.nextDialog++
	p.dialog = &openDialog{id: p.nextDialog, npc: n, node: n.def.Dialog.Start}
	w.quests.ReachedNode(p.storage, n.def.ID, n.def.Dialog.Start, &questHost{w: w, p: p})
	w.sendDialog(p)
	p.active(w.nowTick(), antibot.KindOther)
	w.tutorialEvent(p, content.TriggerTalkNPC, n.def.ID)
}

// sendDialog sends the current node with the options p sees now. option_id is the
// option's position in the node (1-based), so it stays the same while the node is open.
func (w *World) sendDialog(p *Player) {
	d := p.dialog
	node := d.npc.def.Dialog.Nodes[d.node]
	msg := &pb.DialogOpen{DialogId: d.id, NpcCreatureId: d.npc.id, Text: &pb.LocalizedText{Key: node.Text}}
	d.level = p.level
	a := &actor{w: w, p: p}
	if node.BoatRoutes {
		msg.Options = append(msg.Options, w.routeOptions(d.npc)...)
	}
	for _, i := range dialog.Visible(node, a) {
		o := node.Options[i]
		msg.Options = append(msg.Options, &pb.DialogOption{OptionId: uint32(i + 1),
			Text: &pb.LocalizedText{Key: o.Text, Params: optionParams(o, a)}})
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_DialogOpen{DialogOpen: msg}})
}

// priceChanged reports whether option index of d's node shows a price (optionParams) that
// was computed for a level p no longer has.
func (w *World) priceChanged(d *openDialog, p *Player, index int) bool {
	node := d.npc.def.Dialog.Nodes[d.node]
	if node == nil || index < 0 || index >= len(node.Options) || d.level == p.level {
		return false
	}
	for _, a := range node.Options[index].Action {
		if a.Bless != nil && a.Bless.PerLevel != 0 {
			return true
		}
	}
	return false
}

// optionParams are the parameters of an option's text: {price}, what its blessing costs
// this player (content audit M6, the price grows with the level).
func optionParams(o content.DialogOption, a *actor) []*pb.TextParam {
	var price int64
	for _, act := range o.Action {
		if act.Bless != nil {
			price += act.Bless.PriceAt(a.Level())
		}
	}
	if price == 0 {
		return nil
	}
	return []*pb.TextParam{num("price", int(price))}
}

// closeDialog closes p's dialog (and its shop), if any.
func (w *World) closeDialog(p *Player) {
	if p.dialog == nil {
		return
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_DialogClose{DialogClose: &pb.DialogClose{DialogId: p.dialog.id}}})
	p.dialog = nil
}

// checkDialog closes the dialog of a player that walked out of talk range.
func (w *World) checkDialog(p *Player) {
	if p.dialog != nil && !w.inTalkRange(p, p.dialog.npc) {
		w.closeDialog(p)
	}
}

// dialogChoose runs a DialogChoose: the server evaluates the option's conditions again
// and its costs before running anything (docs/06-content-data.md).
func (w *World) dialogChoose(ctx *game.TickContext, p *Player, dialogID, optionID uint32) {
	d := p.dialog
	if d == nil || d.id != dialogID {
		return // a window that is already closed
	}
	if optionID == 0 {
		w.closeDialog(p)
		return
	}
	if !w.inTalkRange(p, d.npc) {
		w.closeDialog(p)
		p.emit(systemMsg(msgNPCTooFar))
		return
	}
	if rt := w.pickedRoute(d, optionID); rt != nil {
		w.sail(ctx, p, rt)
		return
	}
	a := &actor{w: w, p: p, d: d}
	if w.priceChanged(d, p, int(optionID)-1) {
		// The option showed a price for another level (one gained or lost since the node
		// was sent): nothing is charged; the node goes again with the price of now.
		p.emit(systemMsg(msgDialogPriceChanged))
		w.sendDialog(p)
		return
	}
	r := dialog.Choose(d.npc.def, d.node, int(optionID)-1, a)
	if r.Refused != "" {
		p.emit(systemMsg(r.Refused))
	}
	p.questDirty = true
	if a.moved || p.dialog != d {
		w.closeDialog(p)
		return
	}
	if r.Node == "" {
		w.closeDialog(p)
		return
	}
	d.node = r.Node
	if r.Entered {
		w.quests.ReachedNode(p.storage, d.npc.def.ID, r.Node, &questHost{w: w, p: p})
	}
	p.active(ctx.Tick, antibot.KindOther)
	w.sendDialog(p)
	if d.shop && r.Refused == "" {
		w.sendShop(p)
	}
}

// ---- shops --------------------------------------------------------------------------

func (w *World) sendShop(p *Player) {
	d := p.dialog
	msg := &pb.ShopOpen{NpcCreatureId: d.npc.id, DialogId: d.id, Money: uint64(max(w.money(p), 0))}
	for _, l := range d.npc.shop {
		msg.Offers = append(msg.Offers, &pb.ShopOffer{
			ItemId:    uint32(l.def.Numeric),
			BuyPrice:  uint64(l.buy),
			SellPrice: uint64(l.sell),
			Owned:     uint32(w.countItem(p, l.def, false)),
		})
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_ShopOpen{ShopOpen: msg}})
}

// shopLine returns the open shop's line for a numeric item id, or nil.
func (w *World) openShopLine(p *Player, dialogID, itemID uint32) *shopLine {
	d := p.dialog
	if d == nil || d.id != dialogID || !d.shop {
		return nil
	}
	if !w.inTalkRange(p, d.npc) {
		w.closeDialog(p)
		p.emit(systemMsg(msgNPCTooFar))
		return nil
	}
	for i := range d.npc.shop {
		if uint32(d.npc.shop[i].def.Numeric) == itemID {
			return &d.npc.shop[i]
		}
	}
	return nil
}

// shopBuy sells count units of an item to p: all or nothing (money, capacity and room
// are checked first).
func (w *World) shopBuy(p *Player, dialogID, itemID, count uint32) {
	l := w.openShopLine(p, dialogID, itemID)
	if l == nil || l.buy <= 0 || count == 0 || count > maxShopCount {
		if p.dialog != nil {
			p.emit(systemMsg(msgNotPossible))
		}
		return
	}
	n := int(count)
	price := l.buy * int64(n)
	if w.money(p) < price {
		p.emit(systemMsg(msgShopNoMoney))
		return
	}
	// Paying may break a coin: the change needs room too, so neither the change nor the
	// purchase ends up on the floor.
	if !w.canBuy(p, l.def, n, price) {
		p.emit(systemMsg(msgShopNoRoom))
		return
	}
	w.pay(p, price)
	made := w.giveItem(p, l.def, n)
	w.econGold(p, EconNPCBuy, p.dialog.npc.def.ID, -price)
	w.econMade(p, EconNPCBuy, p.dialog.npc.def.ID, 0, l.def, n, made)
	w.log.Info("economy: npc sale", "character", p.charID, "npc", p.dialog.npc.def.ID, "item", l.def.ID, "count", n, "amount", price)
	p.emit(systemMsg(msgShopBought, itemParam(l.def, n), num("price", int(price))))
	w.afterTrade(p)
}

// shopSell buys count units of an item from p (from its containers, never equipped).
func (w *World) shopSell(p *Player, dialogID, itemID, count uint32) {
	l := w.openShopLine(p, dialogID, itemID)
	if l == nil || l.sell <= 0 || count == 0 || count > maxShopCount {
		if p.dialog != nil {
			p.emit(systemMsg(msgNotPossible))
		}
		return
	}
	n := int(count)
	if w.countItem(p, l.def, false) < n {
		p.emit(systemMsg(msgShopNotEnough))
		return
	}
	// The NPC pays the base value: an equipable's attribute never changes the price
	// (docs/02 "Atributos de items"); it takes the weakest instances first (spareFirst)
	// and never a refined one (spareable).
	amount := l.sell * int64(n)
	taken := w.takeItem(p, l.def, n, false)
	w.giveMoney(p, amount)
	w.econTaken(p, EconNPCSell, p.dialog.npc.def.ID, l.def, n, taken)
	w.econGold(p, EconNPCSell, p.dialog.npc.def.ID, amount)
	w.log.Info("economy: npc purchase", "character", p.charID, "npc", p.dialog.npc.def.ID, "item", l.def.ID, "count", n, "amount", amount)
	p.emit(systemMsg(msgShopSold, itemParam(l.def, n), num("price", int(amount))))
	w.afterTrade(p)
}

func (w *World) afterTrade(p *Player) {
	p.active(w.nowTick(), antibot.KindOther)
	p.questDirty = true
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	w.sendShop(p)
}

func itemParam(def *content.Item, n int) *pb.TextParam {
	s := &pb.ItemStack{ItemId: uint32(def.Numeric)}
	if def.Stackable || n > 1 {
		s.Count = uint32(n)
	}
	return &pb.TextParam{Name: "item", Value: &pb.TextParam_Item{Item: s}}
}

// ---- inventory helpers --------------------------------------------------------------

// units is how many units of its item an item instance holds (a rune is one unit with
// charges).
func units(it *Item) int {
	if it.def.Stackable {
		return it.count
	}
	return 1
}

// eachCarried calls fn for every item p carries, equipment slots in order and then
// each container depth-first, and last what p's pockets hold (pockets.go; never the
// pockets themselves). With equipped false, only items inside containers (the pockets'
// count as such).
func (p *Player) eachCarried(equipped bool, fn func(*Item)) {
	var walk func(it *Item)
	walk = func(it *Item) {
		for _, c := range it.items {
			fn(c)
			walk(c)
		}
	}
	for _, it := range p.equip {
		if it == nil {
			continue
		}
		if equipped {
			fn(it)
		}
		walk(it)
	}
	if p.pockets != nil {
		walk(p.pockets)
	}
}

// countItem counts the units of def p carries that a path may take without p picking
// which (spareable): has_item counts equipment too; shops only what is inside containers.
func (w *World) countItem(p *Player, def *content.Item, equipped bool) int {
	n := 0
	if def == nil {
		return 0
	}
	p.eachCarried(equipped, func(it *Item) {
		if spareable(it, def) {
			n += units(it)
		}
	})
	return n
}

// takeable reports whether it is a unit of def that can be counted, sold or taken: a
// container that holds something never is (its content would be lost with it).
func takeable(it *Item, def *content.Item) bool {
	return it.def == def && len(it.items) == 0
}

// spareable reports whether it is a unit of def that a path may count and take without
// the player picking which one (an NPC buying it, a dialog's has_item and take_item, a
// recipe's ingredient, a ticket): takeable and never a refined piece (docs/02 "Forja",
// final review of lote 11). A refined piece leaves only by the player's own hand: the
// market's picker, a trade, the ground; to the rest it is as if the player did not carry
// it, so a +9 is never sold at the base value nor used up by a recipe by mistake.
func spareable(it *Item, def *content.Item) bool {
	return takeable(it, def) && it.mods.Refine == 0
}

// takeItem removes n units of def from p (the caller checked p has them with countItem:
// spareable ones), in the order eachCarried walks them (an equipable's instances
// spareFirst), and returns the instances it removed whole (for econTaken).
func (w *World) takeItem(p *Player, def *content.Item, n int, equipped bool) []*Item {
	var found, taken []*Item
	p.eachCarried(equipped, func(it *Item) {
		if spareable(it, def) {
			found = append(found, it)
		}
	})
	w.spareFirst(found)
	for _, it := range found {
		if n <= 0 {
			break
		}
		if k := units(it); it.def.Stackable && k > n {
			it.count -= n
			w.changed(it)
			n = 0
			continue
		} else {
			n -= k
		}
		w.removeItem(it)
		taken = append(taken, it)
	}
	p.questDirty = true
	return taken
}

// econTaken records the n units of def that takeItem took from p: an equipable is one
// entry per instance with its attribute (taken), anything else one entry for all n.
func (w *World) econTaken(p *Player, kind, ref string, def *content.Item, n int, taken []*Item) {
	if !content.Rolls(def) {
		w.econItem(p, kind, ref, def, -n)
		return
	}
	for _, it := range taken {
		w.econInstance(p, kind, ref, 0, it, -1)
	}
}

// removeItem takes it out of p's inventory for good.
func (w *World) removeItem(it *Item) {
	parent, owner := it.parent, it.owner
	w.closeAll(it)
	w.detach(it)
	switch {
	case parent != nil:
		w.containerChanged(parent)
	case owner != nil:
		w.sendInventory(owner)
		w.equipmentChanged(owner)
	}
}

// room reports whether n units of def fit at the top level of p's packs (its backpack,
// then its pockets: pockets.go) with extra more cells left free: the units that merge
// into the stacks there, and a cell for each new stack.
func (w *World) room(p *Player, def *content.Item, n, extra int) (fits bool) {
	n -= min(n, p.mergeRoom(def))
	stacks := n
	if def.Stackable {
		stacks = (n + def.StackLimit() - 1) / def.StackLimit()
	}
	return stacks+extra <= p.freeCells()
}

// canReceive reports whether n units of def fit in p's capacity and packs (backpack and
// pockets), with extra cells left free.
func (w *World) canReceive(p *Player, def *content.Item, n, extra int) bool {
	return def.Weight*n <= p.capacity-p.carried() && w.room(p, def, n, extra)
}

// giveItem puts n new units of def in p's backpack and then its pockets (pockets.go),
// merging stacks. What does not fit (no room or too heavy) falls on p's tile, with a
// message. An equipable is created: it rolls its attribute (attributes.go). It returns the
// new instances (not the units merged into a stack p had), for econMade.
func (w *World) giveItem(p *Player, def *content.Item, n int) []*Item {
	return w.give(p, def, n, nil)
}

// giveMods is giveItem of one instance whose mods are known (a market offer, a mailbox
// entry): it keeps them (an equipable without an attribute rolls one, as on load).
func (w *World) giveMods(p *Player, def *content.Item, mods Mods) []*Item {
	return w.give(p, def, 1, &mods)
}

func (w *World) give(p *Player, def *content.Item, n int, mods *Mods) []*Item {
	if def == nil || n <= 0 {
		return nil
	}
	newUnits := func(k int) *Item {
		if mods != nil {
			return w.instance(def, k, *mods)
		}
		return w.created(def, k)
	}
	var made []*Item
	p.questDirty = true
	before := p.carried()
	floor := false
	release := w.holdInventory(p) // one Inventory for every stack into the pockets
	for n > 0 {
		k := min(n, def.StackLimit())
		if !def.Stackable {
			k = 1
		}
		merge := p.packStack(def)
		if merge != nil {
			k = min(n, def.StackLimit()-merge.count)
		}
		pack := p.packWithRoom()
		heavy := def.Weight*k > p.capacity-p.carried()
		switch {
		case merge != nil && !heavy:
			merge.count += k
			w.changed(merge)
		case merge == nil && pack != nil && !heavy:
			it := newUnits(k)
			if !def.Stackable {
				it.count = def.StackLimit() // a rune comes with all its charges
			}
			made = append(made, it)
			w.attach(p, it, place{kind: locContainer, cont: pack})
			w.containerChanged(pack)
		default:
			it := newUnits(k)
			if !def.Stackable {
				it.count = def.StackLimit()
			}
			made = append(made, it)
			w.drop(it, p.pos)
			w.holdGround(p, it) // T5.3 fail-safe: p's own while a transfer of p is unconfirmed
			w.tileChanged(p.pos)
			p.ground(measure(it, it.count), -1) // created for p, but it landed on the floor
			floor = true
		}
		n -= k
	}
	release()
	if floor {
		p.emit(systemMsg(msgItemOnFloor))
	}
	if p.carried() != before {
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	}
	return made
}

// money is the worth of every coin p carries, in the smallest coin.
func (w *World) money(p *Player) int64 {
	var total int64
	p.eachCarried(true, func(it *Item) {
		if c := it.def.Currency; c != nil {
			total += c.Worth * int64(it.count)
		}
	})
	return total
}

// pay takes amount from p's coins, smallest coins first; a coin worth more than what
// is left is broken and the change given back (the caller checked p has enough).
func (w *World) pay(p *Player, amount int64) {
	for i := len(w.coins) - 1; i >= 0 && amount > 0; i-- {
		coin := w.coins[i]
		worth := coin.Currency.Worth
		have := int64(w.countItem(p, coin, true))
		take := min(have, (amount+worth-1)/worth)
		if take == 0 {
			continue
		}
		w.takeItem(p, coin, int(take), true)
		amount -= take * worth
	}
	if amount < 0 {
		w.giveMoney(p, -amount)
	}
}

// changeFor returns what pay(p, amount) would take from each coin and the change it
// would give back (p must have amount).
func (w *World) changeFor(p *Player, amount int64) (taken []int, change int64) {
	taken = make([]int, len(w.coins))
	for i := len(w.coins) - 1; i >= 0 && amount > 0; i-- {
		worth := w.coins[i].Currency.Worth
		have := int64(w.countItem(p, w.coins[i], true))
		take := min(have, (amount+worth-1)/worth)
		taken[i] = int(take)
		amount -= take * worth
	}
	return taken, max(-amount, 0)
}

// changeNeeds is what paying amount does to the top level of p's packs (backpack and
// pockets, pockets.go) and to its load: the new stacks its change needs (after merging
// into the coin stacks there) and the net weight (change minus the coins taken; negative
// when paying lightens p). Conservative: the cells that the paid coins free are not
// counted. p must carry amount.
func (w *World) changeNeeds(p *Player, amount int64) (stacks, weight int) {
	taken, change := w.changeFor(p, amount)
	for i, n := range taken {
		weight -= w.coins[i].Weight * n
	}
	for _, coin := range w.coins {
		n := int(change / coin.Currency.Worth)
		if n == 0 {
			continue
		}
		change -= int64(n) * coin.Currency.Worth
		weight += coin.Weight * n
		n -= min(n, p.mergeRoom(coin))
		stacks += (n + coin.StackLimit() - 1) / coin.StackLimit()
	}
	return stacks, weight
}

// canPay reports whether p carries amount and its change fits (changeNeeds) at the top
// level of its packs and in capacity.
func (w *World) canPay(p *Player, amount int64) bool {
	if w.money(p) < amount {
		return false
	}
	stacks, weight := w.changeNeeds(p, amount)
	return stacks <= p.freeCells() && weight <= p.capacity-p.carried()
}

// canBuy reports whether p can pay price for n units of def: the money, and room and
// capacity for both the units and the change.
func (w *World) canBuy(p *Player, def *content.Item, n int, price int64) bool {
	stacks, weight := w.changeNeeds(p, price)
	return def.Weight*n+weight <= p.capacity-p.carried() && w.room(p, def, n, stacks)
}

// giveMoney gives amount in the fewest coins.
func (w *World) giveMoney(p *Player, amount int64) {
	for _, coin := range w.coins {
		if n := amount / coin.Currency.Worth; n > 0 {
			w.giveItem(p, coin, int(n))
			amount -= n * coin.Currency.Worth
		}
	}
}

// ---- quests ------------------------------------------------------------------------

// questHost lets the quest engine read and reward one player.
type questHost struct {
	w *World
	p *Player
}

func (h *questHost) ItemCount(item string) int {
	return h.w.countItem(h.p, h.w.cfg.Items[item], true)
}

func (h *questHost) Reward(q *content.Quest, r content.QuestReward) {
	switch {
	case r.XP > 0:
		h.w.gainExperience(h.p, r.XP)
	case r.Gold > 0:
		h.w.giveMoney(h.p, r.Gold)
		h.w.econGold(h.p, EconQuest, q.ID, r.Gold)
		h.p.emit(systemMsg(msgReceivedGold, num("amount", int(r.Gold))))
	case r.Item != "":
		def := h.w.cfg.Items[r.Item]
		h.w.econMade(h.p, EconQuest, q.ID, 0, def, 1, h.w.giveItem(h.p, def, 1))
	}
}

func (h *questHost) Now() int64 { return h.w.nowUnix() }

func (h *questHost) Inside(r *content.Reach) bool {
	pl := h.w.reachAt[r]
	return pl != nil && pl.contains(h.p.pos)
}

// Notify marks every change of p's quests (questsChanged) and tells the player what it
// hears of; a set_quest_step (StepSet) says nothing itself: the dialog that ran it does.
func (h *questHost) Notify(e quest.Event) {
	h.p.questsChanged() // the quest log and the reach places (questlog.go)
	q := &pb.TextParam{Name: "quest", Value: &pb.TextParam_ContentId{ContentId: e.Quest.ID}}
	switch e.Kind {
	case quest.Started:
		h.p.emit(systemMsg(msgQuestStarted, q))
		h.w.tutorialEvent(h.p, content.TriggerQuestStart, e.Quest.ID)
	case quest.StepDone:
		if e.Step.ID != e.Quest.Steps[len(e.Quest.Steps)-1].ID {
			h.p.emit(systemMsg(msgQuestUpdated, q))
		}
	case quest.KillProgress:
		k := e.Step.CompleteWhen.Kill
		h.p.emit(systemMsg(msgQuestKills, q,
			&pb.TextParam{Name: "monster", Value: &pb.TextParam_ContentId{ContentId: k.Monster}},
			num("count", e.Kills), num("total", k.Count)))
	case quest.Done:
		h.p.emit(systemMsg(msgQuestDone, q))
	}
}

// questKill counts a monster kill for p's quests.
func (w *World) questKill(p *Player, monster string) {
	w.quests.Killed(p.storage, monster, &questHost{w: w, p: p})
}

// questRecheck re-evaluates has_item steps of players whose inventory changed this
// tick (called before the flush).
func (w *World) questRecheck(p *Player) {
	if !p.questDirty {
		return
	}
	p.questDirty = false
	w.quests.Recheck(p.storage, &questHost{w: w, p: p})
}

// ---- dialog effects ----------------------------------------------------------------

// actor is a player as the dialog engine sees it.
type actor struct {
	w *World
	p *Player
	d *openDialog
	// moved is set when an action took the player away (teleport).
	moved bool
}

func (a *actor) Level() int       { return a.p.level }
func (a *actor) Vocation() string { return a.p.vocation.ID }
func (a *actor) ItemCount(item string) int {
	return a.w.countItem(a.p, a.w.cfg.Items[item], true)
}
func (a *actor) QuestState(id string) (quest.State, string) { return a.w.QuestState(a.p, id) }
func (a *actor) QuestAvailable(id string) bool {
	return a.w.quests.Available(a.p.storage, id, a.w.nowUnix())
}
func (a *actor) QuestCoolingDown(id string) bool {
	return a.w.quests.CoolingDown(a.p.storage, id, a.w.nowUnix())
}
func (a *actor) Flag(key string) int64       { return a.p.storage.Get(quest.FlagKey(key)) }
func (a *actor) SkillLevel(skill string) int { return a.w.skillLevel(a.p, skill) }
func (a *actor) Money() int64                { return a.w.money(a.p) }
func (a *actor) CanPay(amount int64) bool    { return a.w.canPay(a.p, amount) }
func (a *actor) HasBlessing(id string) bool  { return a.p.storage.Get(blessKey+id) != 0 }

func (a *actor) CanTeleport(pos content.Position) bool {
	_, ok := a.w.teleportDest(pos)
	return ok
}

// DevIsland reports whether the NPC of the dialog stands on a dev-only island.
func (a *actor) DevIsland() bool { return a.d != nil && a.d.npc != nil && a.d.npc.dev }

func (a *actor) GiveItem(item string) {
	def := a.w.cfg.Items[item]
	a.w.econMade(a.p, EconNPC, a.npcID(), 0, def, 1, a.w.giveItem(a.p, def, 1))
}
func (a *actor) TakeItem(item string, n int) {
	def := a.w.cfg.Items[item]
	a.w.econTaken(a.p, EconNPC, a.npcID(), def, n, a.w.takeItem(a.p, def, n, true))
}

// npcID is the NPC whose dialog runs the action (economy log), or "".
func (a *actor) npcID() string {
	if a.d == nil || a.d.npc == nil {
		return ""
	}
	return a.d.npc.def.ID
}
func (a *actor) GiveXP(xp int64) { a.w.gainExperience(a.p, xp) }
func (a *actor) GiveGold(n int64) {
	a.w.giveMoney(a.p, n)
	a.w.econGold(a.p, EconNPC, a.npcID(), n)
	a.p.emit(systemMsg(msgReceivedGold, num("amount", int(n))))
}
func (a *actor) TakeGold(n int64) {
	a.w.pay(a.p, n)
	a.w.econGold(a.p, EconNPC, a.npcID(), -n)
	a.p.emit(systemMsg(msgPaid, num("amount", int(n))))
}
func (a *actor) StartQuest(id string) {
	a.w.quests.Start(a.p.storage, id, &questHost{w: a.w, p: a.p})
}
func (a *actor) SetQuestStep(q, step string) {
	a.w.quests.SetStep(a.p.storage, q, step, &questHost{w: a.w, p: a.p})
}
func (a *actor) SetFlag(key string, v int64) {
	a.w.quests.SetFlag(a.p.storage, key, v, &questHost{w: a.w, p: a.p})
}
func (a *actor) OpenShop(string) {
	if a.d != nil {
		a.d.shop = true
	}
}

func (a *actor) Heal() {
	a.w.heal(a.p, a.p.maxHealth)
	a.p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: a.w.stats(a.p)}})
}

// RestoreMana fills the mana (dev-only: the sandbox instructor).
func (a *actor) RestoreMana() {
	if a.p.mana >= a.p.maxMana {
		return
	}
	a.p.mana = a.p.maxMana
	a.p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: a.w.stats(a.p)}})
}

// TrainSkill raises a skill to level (dev-only: the sandbox instructor).
func (a *actor) TrainSkill(skill string, level int) { a.w.raiseSkill(a.p, skill, level) }

func (a *actor) Teleport(pos content.Position) {
	if to, ok := a.w.teleportDest(pos); ok {
		a.moved = true
		a.w.Teleport(a.p, to)
	}
}

func (a *actor) Bless(b content.Bless) {
	if price := b.PriceAt(a.Level()); price > 0 {
		a.TakeGold(price)
	}
	a.p.storage.Set(blessKey+b.Blessing, 1)
}

// teleportDest returns a free tile at or next to pos, never a house tile (like the
// arrival of a boat or a portal: a dialog does not put anyone inside a house).
func (w *World) teleportDest(pos content.Position) (world.Pos, bool) {
	if pos.X < 0 || pos.Y < 0 || pos.X > 0xFFFF || pos.Y > 0xFFFF || pos.Z < 0 || pos.Z > world.MaxFloor {
		return world.Pos{}, false
	}
	return w.freeAround(world.Pos{X: uint16(pos.X), Y: uint16(pos.Y), Z: uint8(pos.Z)}, 1, true)
}
