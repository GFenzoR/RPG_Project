package session

import (
	"fmt"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// The forge (docs/02-game-design.md "Forja", balance.yaml forge). At the forge's station
// (an anvil of the map, within reach like crafting) a player refines an equipable it
// carries (equipped or in an open container) one level at a time, up to the top level.
// Every attempt spends the temper stones of the item's band and money, and the protection
// material if the player uses it; up to forge.safe_level it never fails; after it the
// chance drops at every level and a failure destroys the item, or, with the protection
// spent in that attempt, costs it one level. The roll comes from the loop's seeded source
// (TickContext.Rand); the whole attempt happens in one command, so a disconnect sees it
// either done or not started, and the character is saved right after an attempt that could
// fail.

// Effects of a forge attempt on the station's tile (docs/05).
const (
	EffectRefine  = 8 // sparks: the item went up one level
	EffectShatter = 9 // a break, or the protection shattering instead of the item
)

// i18n keys of the forge's messages (i18n/*/client.yaml).
const (
	msgRefineOff        = "refine.unavailable"
	msgRefineNotItem    = "refine.not_refinable"
	msgRefineNotCarried = "refine.not_carried"
	msgRefineTop        = "refine.top_level"
	msgRefineInTrade    = "refine.in_trade"
	msgRefineStones     = "refine.no_stones"
	msgRefineProtection = "refine.no_protection"
	msgRefineMoney      = "refine.no_money"
	msgRefineChange     = "refine.no_change_room"
	msgRefineNotReady   = "refine.not_ready"
	msgRefineSuccess    = "refine.success"
	msgRefineBroken     = "refine.broken"
	msgRefineProtected  = "refine.protected"
)

// initForge reads balance.yaml forge: its items must exist (content.Forge.CheckItems), and
// the station opens StationOpen with the stones and the protection counted (sendStation).
func (w *World) initForge() error {
	f := &w.cfg.Balance.Forge
	if !f.Enabled {
		return nil
	}
	if err := f.CheckItems(w.cfg.Items); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	if s := f.SmithingBonus.Skill; f.SmithingBonus.PerLevels > 0 {
		if _, ok := w.cfg.Balance.Skills.Base[s]; !ok {
			return fmt.Errorf("session: forge: smithing_bonus.skill %q is not in skills.base", s)
		}
	}
	w.forge = f
	station := w.cfg.Items[f.Station]
	w.forgeStation = station.Numeric
	owned := w.stations[station.Numeric]
	if owned == nil {
		owned = []*content.Item{}
	}
	add := func(def *content.Item) {
		for _, d := range owned {
			if d == def {
				return
			}
		}
		owned = append(owned, def)
	}
	for _, b := range f.Bands {
		add(w.cfg.Items[b.Stone])
	}
	add(w.cfg.Items[f.Protection])
	w.stations[station.Numeric] = owned
	return nil
}

// offered reports whether it is in the trade window offer of p.
func offered(p *Player, it *Item) bool {
	t := p.trade
	if t == nil {
		return false
	}
	for _, x := range t.offer[t.side(p)] {
		if x.it == it {
			return true
		}
	}
	return false
}

// refine runs a Refine intent. Every check comes before anything changes; then the stones,
// the protection and the money go at once, the chance is rolled and the item goes up, down
// or away.
func (w *World) refine(ctx *game.TickContext, p *Player, m *pb.Refine) {
	f := w.forge
	if f == nil {
		p.emit(systemMsg(msgRefineOff))
		return
	}
	pos, ok := posFromMsg(m.GetStation())
	// A station of another floor or out of view answers like any tile (itemAt, craft).
	if !ok || pos.Z != p.pos.Z || !Sees(p.pos, pos) {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	station := w.byNum[w.forgeStation]
	if !w.hasStation(pos, station) {
		p.emit(systemMsg(msgCraftNoStation, itemParam(station, 1)))
		return
	}
	if !w.near(p, pos) {
		p.emit(systemMsg(msgTooFar))
		return
	}
	// The item: the player's own, equipped or in an open container it carries (never the
	// ground, a corpse or a chest), as the client saw it, all of its mods (a click repeated
	// after a success names the old level and does nothing; one sent before the result of
	// a break, after the container's items moved up, names the broken piece's mods: the
	// one in its place now is refined only when it is the same in every way).
	it, pl := w.itemAt(p, m.GetItem(), m.GetItemId(), 0)
	if it == nil || it.mods != modsOf(m.GetMods()) {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	if pl.kind == locGround || it.carriedBy() != p {
		p.emit(systemMsg(msgRefineNotCarried))
		return
	}
	if content.RefineKind(it.def) == "" {
		p.emit(systemMsg(msgRefineNotItem))
		return
	}
	target := it.mods.Refine + 1
	if target > f.MaxLevel() {
		p.emit(systemMsg(msgRefineTop, num("level", f.MaxLevel())))
		return
	}
	if offered(p, it) {
		p.emit(systemMsg(msgRefineInTrade))
		return
	}
	band := f.Band(it.def.Requires.Level)
	stone, need := w.cfg.Items[band.Stone], f.Level(target).Stones
	if have := w.countItem(p, stone, false); have < need {
		p.emit(systemMsg(msgRefineStones, itemParam(stone, need-have)))
		return
	}
	// The protection only counts where the attempt can fail.
	protect := m.GetProtect() && target > f.SafeLevel
	amber := w.cfg.Items[f.Protection]
	if protect && w.countItem(p, amber, false) < 1 {
		p.emit(systemMsg(msgRefineProtection, itemParam(amber, 1)))
		return
	}
	gold := f.Gold(it.def.Requires.Level, target)
	if w.money(p) < gold {
		p.emit(systemMsg(msgRefineMoney, num("price", int(gold))))
		return
	}
	if !w.canPay(p, gold) { // the change of a broken coin needs room
		p.emit(systemMsg(msgRefineChange))
		return
	}
	if ctx.Tick < p.nextGather {
		p.tooEarly(ctx.Tick, antibot.KindItem)
		p.emit(systemMsg(msgRefineNotReady))
		return
	}
	p.activePaced(ctx.Tick, antibot.KindItem, p.nextGather)
	p.nextGather = ctx.Tick + max(w.gatherFor, ticksFor(f.TimeMs))

	ref := it.def.ID
	chance := f.Chance(target, w.skillLevel(p, f.SmithingBonus.Skill)) // the level before this attempt
	if gold > 0 {
		w.pay(p, gold)
		w.econGold(p, EconForge, ref, -gold)
	}
	w.econTaken(p, EconForge, ref, stone, need, w.takeItem(p, stone, need, false))
	if protect {
		w.econTaken(p, EconForge, ref, amber, 1, w.takeItem(p, amber, 1, false))
	}
	success := chance >= 100 || ctx.Rand.IntN(100) < chance
	before := it.mods
	res := &pb.RefineResult{}
	switch {
	case success:
		w.setRefine(p, it, target)
		res.Outcome = pb.RefineOutcome_REFINE_OUTCOME_SUCCESS
		w.gatherEffect(pos, EffectRefine)
	case protect:
		w.setRefine(p, it, max(before.Refine-1, 0))
		res.Outcome = pb.RefineOutcome_REFINE_OUTCOME_PROTECTED
		w.gatherEffect(pos, EffectShatter)
	default:
		w.econInstance(p, EconForge, ref, 0, it, -1)
		w.removeItem(it)
		res.Outcome = pb.RefineOutcome_REFINE_OUTCOME_BROKEN
		w.gatherEffect(pos, EffectShatter)
	}
	// The message names the item as it was (a broken one keeps its name and level).
	key, level := msgRefineSuccess, it.mods.Refine
	switch res.Outcome {
	case pb.RefineOutcome_REFINE_OUTCOME_BROKEN:
		key, level = msgRefineBroken, 0
		res.Item = &pb.ItemStack{ItemId: uint32(it.def.Numeric)}
	case pb.RefineOutcome_REFINE_OUTCOME_PROTECTED:
		key = msgRefineProtected
		res.Item = it.stack()
	default:
		res.Item = it.stack()
	}
	res.Level = uint32(level)
	named := &pb.ItemStack{ItemId: uint32(it.def.Numeric), Mods: before.msg()}
	res.Text = &pb.LocalizedText{Key: key, Params: []*pb.TextParam{
		{Name: "item", Value: &pb.TextParam_Item{Item: named}},
		num("level", level),
		num("from", before.Refine),
	}}
	w.log.Info("forge: attempt", "character", p.charID, "item", ref, "from", before.Refine, "target", target,
		"chance", chance, "protect", protect, "outcome", res.Outcome.String(), "gold", gold)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_RefineResult{RefineResult: res}})
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_ChatMessage{ChatMessage: &pb.Message{
		Kind: pb.MessageKind_MESSAGE_KIND_SYSTEM, Body: &pb.Message_Localized{Localized: res.Text},
	}}})
	p.questDirty = true
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	w.queueMarket(p) // an open market window shows its money and items
	w.sendStation(p, pos, w.forgeStation)
	// An attempt that could fail is worth keeping at once (like a death or a guild's cost):
	// a crash right after it cannot bring a broken item back or lose a level reached. A
	// safe level waits for the next periodic save: going back to before it gives nothing
	// (the level and its stones and money come back together).
	if target > f.SafeLevel {
		w.save(w.snapshot(p, false))
	}
}

// setRefine sets it's refine level to level in place: the log names the instance out with
// its old mods and in with the new ones, the place that holds it is told, and a worn piece
// recomputes what the gear gives (applyGear only redoes the sums when gearFrom changes).
func (w *World) setRefine(p *Player, it *Item, level int) {
	if it.mods.Refine == level {
		return
	}
	w.econInstance(p, EconForge, it.def.ID, 0, it, -1)
	it.mods.Refine = level
	w.econInstance(p, EconForge, it.def.ID, 0, it, 1)
	w.changed(it)
	if worn(it) == 1 {
		p.gearFrom = [equipSlots]*Item{}
		w.equipmentChanged(p)
	}
}

// refinedStat is what it's refine level adds to its own number (the look text): a weapon's
// attack, an armor piece's armor or a shield's defense; 0 for a jewel (its share goes to
// its attribute), a plain item or with the forge off.
func (w *World) refinedStat(it *Item) int {
	if w.forge == nil || it.mods.Refine <= 0 || content.RefineKind(it.def) == content.RefineJewel {
		return 0
	}
	return w.forge.Gain(it.def, it.mods.Refine)
}

// refineGain is what the refine level of it, worn in slot, adds to p's gear (attributes.go
// wornGear): a weapon's attack (in the right hand), a shield's defense (in the left), an
// armor piece's armor, or for a jewel a share of its attribute's value (by attribute id).
func (w *World) refineGain(g *gearBonus, byAttr map[string]int, slot int, it *Item) {
	f := w.forge
	if f == nil || it.mods.Refine <= 0 {
		return
	}
	gain := f.Gain(it.def, it.mods.Refine)
	switch content.RefineKind(it.def) {
	case content.RefineAttack:
		if slot == int(pb.EquipmentSlot_EQUIPMENT_SLOT_RIGHT_HAND) {
			g.attack += gain
		}
	case content.RefineDefense:
		if slot == int(pb.EquipmentSlot_EQUIPMENT_SLOT_LEFT_HAND) {
			g.defend += gain
		}
	case content.RefineArmor:
		g.armor += gain
	case content.RefineJewel:
		if it.mods.Attr != "" {
			byAttr[it.mods.Attr] += f.JewelGain(it.mods.Value, it.mods.Refine)
		}
	}
}
