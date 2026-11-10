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
	msgNPCTooFar     = "dialog.too_far"
	msgShopNoMoney   = "shop.no_money"
	msgShopNotEnough = "shop.not_enough"
	msgShopNoRoom    = "shop.no_room"
	msgShopBought    = "shop.bought"
	msgShopSold      = "shop.sold"
	msgItemOnFloor   = "dialog.item_on_floor"
	msgQuestStarted  = "dialog.quest_started"
	msgQuestUpdated  = "dialog.quest_updated"
	msgQuestKills    = "dialog.quest_kills"
	msgQuestDone     = "dialog.quest_completed"
	msgPaid          = "dialog.paid"
	msgReceivedGold  = "dialog.received_gold"
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
	for _, is := range w.m.Islands() {
		for _, pl := range is.NPCs {
			def := w.cfg.NPCs[pl.NPC]
			if def == nil {
				return fmt.Errorf("session: island %q places unknown NPC %q", is.ID, pl.NPC)
			}
			w.nextID++
			n := &NPC{id: w.nextID, def: def, pos: pl.Pos}
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
	a := &actor{w: w, p: p}
	if node.BoatRoutes {
		msg.Options = append(msg.Options, w.routeOptions(d.npc)...)
	}
	for _, i := range dialog.Visible(node, a) {
		msg.Options = append(msg.Options, &pb.DialogOption{OptionId: uint32(i + 1), Text: &pb.LocalizedText{Key: node.Options[i].Text}})
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_DialogOpen{DialogOpen: msg}})
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
	w.giveItem(p, l.def, n)
	w.econGold(p, EconNPCBuy, p.dialog.npc.def.ID, -price)
	w.econItem(p, EconNPCBuy, p.dialog.npc.def.ID, l.def, n)
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
	amount := l.sell * int64(n)
	w.takeItem(p, l.def, n, false)
	w.giveMoney(p, amount)
	w.econItem(p, EconNPCSell, p.dialog.npc.def.ID, l.def, -n)
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
// each container depth-first. With equipped false, only items inside containers.
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
}

// countItem counts the units of def p carries (has_item counts equipment too; shops
// only what is inside containers).
func (w *World) countItem(p *Player, def *content.Item, equipped bool) int {
	n := 0
	if def == nil {
		return 0
	}
	p.eachCarried(equipped, func(it *Item) {
		if takeable(it, def) {
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

// takeItem removes n units of def from p (the caller checked p has them).
func (w *World) takeItem(p *Player, def *content.Item, n int, equipped bool) {
	var found []*Item
	p.eachCarried(equipped, func(it *Item) {
		if takeable(it, def) {
			found = append(found, it)
		}
	})
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
	}
	p.questDirty = true
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

// room returns where n units of def would go in p's backpack (top level): how many
// merge into existing stacks and how many new stacks are needed and fit.
func (w *World) room(p *Player, def *content.Item, n, extra int) (fits bool) {
	bp := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK]
	if bp == nil || bp.def.Container == nil {
		return false
	}
	if def.Stackable {
		for _, c := range bp.items {
			if c.def == def {
				n -= min(n, def.StackLimit()-c.count)
			}
		}
	}
	if n <= 0 {
		return len(bp.items)+extra <= bp.def.Slots()
	}
	stacks := n
	if def.Stackable {
		stacks = (n + def.StackLimit() - 1) / def.StackLimit()
	}
	return len(bp.items)+stacks+extra <= bp.def.Slots()
}

// canReceive reports whether n units of def fit in p's capacity and backpack, with
// extra backpack slots left free.
func (w *World) canReceive(p *Player, def *content.Item, n, extra int) bool {
	return def.Weight*n <= p.capacity-p.carried() && w.room(p, def, n, extra)
}

// giveItem puts n units of def in p's backpack, merging stacks. What does not fit (no
// backpack, no room or too heavy) falls on p's tile, with a message.
func (w *World) giveItem(p *Player, def *content.Item, n int) {
	if def == nil || n <= 0 {
		return
	}
	p.questDirty = true
	bp := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK]
	before := p.carried()
	floor := false
	for n > 0 {
		k := min(n, def.StackLimit())
		if !def.Stackable {
			k = 1
		}
		var merge *Item
		if bp != nil && def.Stackable {
			for _, c := range bp.items {
				if c.def == def && c.count < def.StackLimit() {
					merge = c
					k = min(n, def.StackLimit()-c.count)
					break
				}
			}
		}
		heavy := def.Weight*k > p.capacity-p.carried()
		switch {
		case merge != nil && !heavy:
			merge.count += k
			w.changed(merge)
		case bp != nil && bp.def.Container != nil && len(bp.items) < bp.def.Slots() && !heavy:
			it := newItem(def, k)
			if !def.Stackable {
				it.count = def.StackLimit() // a rune comes with all its charges
			}
			w.attach(p, it, place{kind: locContainer, cont: bp})
			w.containerChanged(bp)
		default:
			it := newItem(def, k)
			if !def.Stackable {
				it.count = def.StackLimit()
			}
			w.drop(it, p.pos)
			w.tileChanged(p.pos)
			p.ground(measure(it, it.count), -1) // created for p, but it landed on the floor
			floor = true
		}
		n -= k
	}
	if floor {
		p.emit(systemMsg(msgItemOnFloor))
	}
	if p.carried() != before {
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	}
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

// changeNeeds is what paying amount does to p's top backpack and load: the new stacks
// its change needs (after merging into the backpack's coin stacks) and the net weight
// (change minus the coins taken; negative when paying lightens p). Conservative: the
// slots that the paid coins free are not counted. p must carry amount.
func (w *World) changeNeeds(p *Player, amount int64) (stacks, weight int) {
	taken, change := w.changeFor(p, amount)
	for i, n := range taken {
		weight -= w.coins[i].Weight * n
	}
	bp := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK]
	for _, coin := range w.coins {
		n := int(change / coin.Currency.Worth)
		if n == 0 {
			continue
		}
		change -= int64(n) * coin.Currency.Worth
		weight += coin.Weight * n
		if bp != nil {
			for _, c := range bp.items {
				if c.def == coin {
					n -= min(n, coin.StackLimit()-c.count)
				}
			}
		}
		stacks += (n + coin.StackLimit() - 1) / coin.StackLimit()
	}
	return stacks, weight
}

// canPay reports whether p carries amount and its change fits (changeNeeds) in the top
// backpack and in capacity.
func (w *World) canPay(p *Player, amount int64) bool {
	if w.money(p) < amount {
		return false
	}
	stacks, weight := w.changeNeeds(p, amount)
	if stacks == 0 {
		return weight <= p.capacity-p.carried()
	}
	bp := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK]
	return bp != nil && bp.def.Container != nil && len(bp.items)+stacks <= bp.def.Slots() &&
		weight <= p.capacity-p.carried()
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
		h.w.giveItem(h.p, h.w.cfg.Items[r.Item], 1)
		h.w.econItem(h.p, EconQuest, q.ID, h.w.cfg.Items[r.Item], 1)
	}
}

func (h *questHost) Notify(e quest.Event) {
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
func (a *actor) Flag(key string) int64                      { return a.p.storage.Get(quest.FlagKey(key)) }
func (a *actor) SkillLevel(skill string) int                { return a.w.skillLevel(a.p, skill) }
func (a *actor) Money() int64                               { return a.w.money(a.p) }
func (a *actor) CanPay(amount int64) bool                   { return a.w.canPay(a.p, amount) }
func (a *actor) HasBlessing(id string) bool                 { return a.p.storage.Get(blessKey+id) != 0 }

func (a *actor) CanTeleport(pos content.Position) bool {
	_, ok := a.w.teleportDest(pos)
	return ok
}

func (a *actor) GiveItem(item string) {
	a.w.giveItem(a.p, a.w.cfg.Items[item], 1)
	a.w.econItem(a.p, EconNPC, a.npcID(), a.w.cfg.Items[item], 1)
}
func (a *actor) TakeItem(item string, n int) {
	a.w.takeItem(a.p, a.w.cfg.Items[item], n, true)
	a.w.econItem(a.p, EconNPC, a.npcID(), a.w.cfg.Items[item], -n)
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

func (a *actor) Teleport(pos content.Position) {
	if to, ok := a.w.teleportDest(pos); ok {
		a.moved = true
		a.w.Teleport(a.p, to)
	}
}

func (a *actor) Bless(b content.Bless) {
	if b.Price > 0 {
		a.TakeGold(b.Price)
	}
	a.p.storage.Set(blessKey+b.Blessing, 1)
}

// teleportDest returns a free tile at or next to pos.
func (w *World) teleportDest(pos content.Position) (world.Pos, bool) {
	if pos.X < 0 || pos.Y < 0 || pos.X > 0xFFFF || pos.Y > 0xFFFF || pos.Z < 0 || pos.Z > world.MaxFloor {
		return world.Pos{}, false
	}
	return w.freeNear(world.Pos{X: uint16(pos.X), Y: uint16(pos.Y), Z: uint8(pos.Z)}, 1)
}
