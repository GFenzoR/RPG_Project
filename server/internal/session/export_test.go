package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// SetHealth sets a monster's health (tests only).
func (m *Monster) SetHealth(h int) { m.health = h }

// EquipForTest gives p a weapon and a shield until equipment exists (T1.8).
func (p *Player) EquipForTest(weapon, shield *content.Item) { p.weapon, p.shield = weapon, shield }

// Level returns p's level (tests only).
func (w *World) Level(p *Player) int { return p.level }

// Mana returns p's mana (tests only).
func (w *World) Mana(p *Player) int { return p.mana }

// MonsterHealth returns m's health (tests only).
func (w *World) MonsterHealth(m *Monster) int { return m.health }

// DropForTest puts count units of def on the ground at pos (tests only, loop goroutine).
func (w *World) DropForTest(def *content.Item, count int, pos world.Pos) {
	w.drop(newItem(def, count), pos)
	w.tileChanged(pos)
}

// Viewers returns how many players have container it open (tests only).
func (it *Item) Viewers() int { return len(it.viewers) }

// GroundAt returns the runtime items on pos, bottom first (tests only).
func (w *World) GroundAt(pos world.Pos) []*Item { return w.ground[pos] }

// CountItem returns how many units of item id p carries, equipment included (tests).
func (w *World) CountItem(p *Player, id string) int { return w.countItem(p, w.cfg.Items[id], true) }

// Money returns the money p carries (tests only).
func (w *World) Money(p *Player) int64 { return w.money(p) }

// GiveForTest puts n units of item id in p's backpack (tests only, loop goroutine).
func (w *World) GiveForTest(p *Player, id string, n int) {
	w.giveItem(p, w.cfg.Items[id], n)
	w.econItem(p, EconGM, "test", w.cfg.Items[id], n) // keeps the economy ledger right
}

// TakeForTest takes n units of item id from p, as a GM would (tests only, loop goroutine).
func (w *World) TakeForTest(p *Player, id string, n int) {
	w.takeItem(p, w.cfg.Items[id], n, true)
	w.econItem(p, EconGM, "test", w.cfg.Items[id], -n) // keeps the economy ledger right
}

// HurtForTest makes p take dmg as if a monster hit it (tests only, loop goroutine).
func (w *World) HurtForTest(ctx *game.TickContext, p *Player, dmg int) {
	w.damagePlayer(ctx, p, dmg, "")
}

// RestoreForTest refills p's health (tests only, loop goroutine).
func (w *World) RestoreForTest(p *Player) { p.health = p.maxHealth }

// DieForTest kills p now (as if a monster had taken its last hit point).
func (w *World) DieForTest(ctx *game.TickContext, p *Player) { w.die(ctx, p) }

// MaxMana returns p's maximum mana.
func (p *Player) MaxMana() int { return p.maxMana }

// Mana returns p's mana.
func (p *Player) Mana() int { return p.mana }

// Map returns the world's map.
func (w *World) Map() *world.Map { return w.m }

// SetHealthForTest sets p's health (tests only, loop goroutine).
func (p *Player) SetHealthForTest(h int) { p.health = h }

// ApplyConditionForTest gives p (or, if p is nil, m) condition a from source (tests only,
// loop goroutine). It reports whether it took (chance, immunity).
func (w *World) ApplyConditionForTest(ctx *game.TickContext, p *Player, m *Monster, a *content.ConditionApply, source uint32) bool {
	if p != nil {
		return w.applyCondition(ctx, holder{p: p}, a, source)
	}
	return w.applyCondition(ctx, holder{m: m}, a, source)
}

// ConditionsForTest returns p's conditions: id → hits left (damage) or ms left (others).
func (w *World) ConditionsForTest(p *Player) map[string]int {
	out := map[string]int{}
	for _, c := range p.conds {
		if c.ticks > 0 {
			out[c.def.ID] = c.ticks
		} else {
			out[c.def.ID] = w.leftMs(c)
		}
	}
	return out
}

// MonsterConditionsForTest returns the ids of m's conditions.
func (m *Monster) MonsterConditionsForTest() []string {
	var out []string
	for _, c := range m.conds {
		out = append(out, c.def.ID)
	}
	return out
}

// CombatSkillForTest is p's skill level as combat uses it (with keen_eye).
func (w *World) CombatSkillForTest(p *Player, id string) int { return w.combatSkill(p, id) }

// DamageShareForTest is the damage creature id dealt to m (its experience share).
func (m *Monster) DamageShareForTest(id uint32) int {
	for _, d := range m.damage {
		if d.player == id {
			return d.amount
		}
	}
	return 0
}

// PartyForTest returns the creature ids of p's party members (join order), its leader
// and whether shared experience is on; nil, 0, false without a party.
func (p *Player) PartyForTest() (members []uint32, leader uint32, shared bool) {
	if p.party == nil {
		return nil, 0, false
	}
	for _, o := range p.party.members {
		members = append(members, o.id)
	}
	return members, p.party.leader.id, p.party.shared
}

// Share is one damage share for ShareForTest.
type Share struct {
	P      *Player
	Amount int
}

// ShareForTest pays xp of a kill at pos by shares, as killMonster does (loop goroutine).
func (w *World) ShareForTest(ctx *game.TickContext, pos world.Pos, xp int64, shares ...Share) {
	ds := make([]damageShare, len(shares))
	for i, s := range shares {
		ds[i] = damageShare{player: s.P.id, amount: s.Amount}
	}
	w.shareExperience(ctx.Tick, pos, xp, ds)
}

// ContributeForTest marks that p just helped a fight (loop goroutine).
func (w *World) ContributeForTest(ctx *game.TickContext, p *Player) { w.contribute(ctx, p) }

// SetLevelForTest sets p's level (loop goroutine).
func (w *World) SetLevelForTest(p *Player, level int) { w.setLevel(p, level) }

// InvitesForTest returns how many party invitations are pending.
func (w *World) InvitesForTest() int { return len(w.invites) }

// TrainForTest adds n tries of skill id to p (T3.4).
func (w *World) TrainForTest(p *Player, id string, n int64) { w.addTries(p, w.skillIdx[id], n) }

// SetCapacityForTest sets p's capacity in grams (T3.4).
func (w *World) SetCapacityForTest(p *Player, grams int) { p.capacity = grams }

// SetStorageForTest sets a quest_state value of p (tests only, loop goroutine).
func (p *Player) SetStorageForTest(key string, v int64) { p.storage.Set(key, v) }

// DupeForTest gives items without telling the economy log: what a duplication bug does.
func (w *World) DupeForTest(p *Player, id string, n int) { w.giveItem(p, w.cfg.Items[id], n) }

// ProjectileForTest shows a physical projectile between two tiles.
func (w *World) ProjectileForTest(from, to world.Pos) { w.projectile(from, to, ElementPhysical) }

// EarningsForTest is how many characters have an outlier window in memory.
func (w *World) EarningsForTest() int { return len(w.earnings) }

// SetInvisibleForTest hides or shows p as the invisibility condition does (no timer).
func (w *World) SetInvisibleForTest(p *Player, on bool) {
	if on {
		w.hide(nil, p)
	} else {
		w.unhide(p)
	}
}

// SuspicionForTest returns p's suspicion score, its last signals and response level.
func (w *World) SuspicionForTest(p *Player) (float64, [5]float64, int) {
	if p.sus == nil {
		return -1, [5]float64{}, 0
	}
	return p.sus.score, p.sus.signals, p.sus.level
}

// SetSuspicionForTest sets p's score as of now (bot detection, T4.1).
func (w *World) SetSuspicionForTest(p *Player, score float64) {
	p.sus.score, p.sus.lastEval = score, w.nowTick()
}

// EvaluateNowForTest makes p's next bot detection evaluation due on the next tick.
func (w *World) EvaluateNowForTest(p *Player) { p.abNext = 0 }

// IncomeRatioForTest recomputes the band medians and returns p's income ratio now.
func (w *World) IncomeRatioForTest(p *Player) float64 {
	w.incomeMedians(w.nowTick())
	return w.incomeRatio(w.nowTick(), p)
}

// GainExperienceForTest gives p experience as a kill would.
func (w *World) GainExperienceForTest(p *Player, xp int64) { w.gainExperience(p, xp) }

// AntiBotEvalMsForTest is antibot.eval_every_ms (one evaluation round).
func (w *World) AntiBotEvalMsForTest() int { return w.abCfg.EvalEveryMs }

// PvPHitForTest lands a physical hit of dmg (before pvp.damage_pct) of a on v (T5.2).
func (w *World) PvPHitForTest(ctx *game.TickContext, a, v *Player, dmg int) {
	w.hurtPlayer(ctx, a, v, dmg, ElementPhysical, true)
}

// PvPStateForTest is what a snapshot would save of p's PvP state.
func (w *World) PvPStateForTest(p *Player) PvPState { return w.pvpState(p) }

// SetPvPLockForTest puts p in a PvP fight until tick (tests only, loop goroutine).
func (w *World) SetPvPLockForTest(p *Player, until game.Tick) { p.fightUntil = until }

// MarketOfferAmount returns the units left of offer id, or -1 if it is not in the book.
func (w *World) MarketOfferAmount(id int64) int {
	if o := w.offers[id]; o != nil {
		return o.Amount
	}
	return -1
}

// MarketOffers returns the ids of the offers of character charID (tests only).
func (w *World) MarketOffers(charID int64) []int64 {
	var out []int64
	for _, o := range w.byOwner[charID] {
		out = append(out, o.ID)
	}
	return out
}

// Mailbox returns the gold and the item stacks waiting in charID's mailbox.
func (w *World) Mailbox(charID int64) (int64, []ItemState) {
	b := w.mail[charID]
	if b == nil {
		return 0, nil
	}
	var items []ItemState
	for _, m := range b.items {
		items = append(items, m.Item)
	}
	return b.gold, items
}

// SetRoleForTest changes p's role (tests only, loop goroutine).
func (w *World) SetRoleForTest(p *Player, r Role) { p.role = r }

// MailGoldForTest adds add to the market mailbox gold of a character and returns it.
func (w *World) MailGoldForTest(charID, add int64) int64 {
	b := w.box(charID)
	b.gold += add
	return b.gold
}

// MailItemsForTest is how many items wait in a character's mailbox.
func (w *World) MailItemsForTest(charID int64) int { return len(w.box(charID).items) }

// ForceSaveForTest submits an autosave of client's player now.
func (w *World) ForceSaveForTest(c Client) game.Command {
	return game.CommandFunc(func(*game.TickContext) {
		if p := w.byClient[c]; p != nil {
			w.save(w.snapshot(p, false))
		}
	})
}

// MailForTest is the items waiting in a character's mailbox.
func (w *World) MailForTest(charID int64) []ItemState {
	var out []ItemState
	for _, m := range w.box(charID).items {
		out = append(out, m.Item)
	}
	return out
}

// ItemForTest is an item definition by content id.
func (w *World) ItemForTest(id string) *content.Item { return w.cfg.Items[id] }
