package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
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

// KillForTest kills m as if a hit had taken its last health point: its loot goes into its
// remains, which decay on their own (tests only, loop goroutine).
func (w *World) KillForTest(ctx *game.TickContext, m *Monster) { w.killMonster(ctx, m) }

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

// SetManaForTest sets p's mana (tests only, loop goroutine).
func (p *Player) SetManaForTest(m int) { p.mana = m }

// SetDevForTest says whether n stands on a dev-only island, past the startup check
// (tests of the runtime defense only, loop goroutine).
func (n *NPC) SetDevForTest(dev bool) { n.dev = dev }

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

// PathNodesSpentForTest is how many tiles the pathfinding of the last tick expanded (its
// share of Config.PathNodesPerTick).
func (w *World) PathNodesSpentForTest() int { return w.cfg.PathNodesPerTick - w.pathBudget }

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

// HitByForTest returns the characters p remembers a recent hit from (T5.2), one per
// entry.
func (w *World) HitByForTest(p *Player) []int64 {
	var out []int64
	for _, h := range p.hitBy {
		out = append(out, h.char)
	}
	return out
}

// SetPvPLockForTest puts p in a PvP fight until tick (tests only, loop goroutine).
func (w *World) SetPvPLockForTest(p *Player, until game.Tick) { p.fightUntil = until }

// SetAttackLockForTest gives p the lock of an attacker until tick: no protection zone
// (tests only, loop goroutine).
func (w *World) SetAttackLockForTest(p *Player, until game.Tick) { p.lockUntil = until }

// MonsterCanEnterForTest reports whether a monster may stand on p (tests only).
func (w *World) MonsterCanEnterForTest(p world.Pos) bool { return w.monsterCanEnter(p) }

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

// CosmeticsForTest returns what p has equipped (T5.7).
func (p *Player) CosmeticsForTest() Cosmetics { return p.cos }

// Walkable reports whether the map lets a creature stand on p (tests only).
func (w *World) Walkable(p world.Pos) bool { return w.m.Walkable(p) }

// LineOfSight reports whether the map has line of sight from a to b (tests only).
func (w *World) LineOfSight(a, b world.Pos) bool { return w.m.LineOfSight(a, b) }

// InDoorRoom reports whether p lies in the room behind the locked door at door (tests
// only; false for no door, or a door with no room).
func (w *World) InDoorRoom(door, p world.Pos) bool {
	d := w.doors[door]
	return d != nil && d.inRoom(w.roomOf[p])
}

// DoorRoomSize returns how many tiles lie in the room behind the locked door at door
// (tests only; 0 for no door, or a door with no room).
func (w *World) DoorRoomSize(door world.Pos) int {
	d := w.doors[door]
	if d == nil {
		return 0
	}
	n := 0
	for _, r := range w.roomOf {
		if d.inRoom(r) {
			n++
		}
	}
	return n
}

// Why a locked door has no room (doorRoom), for errors.Is in tests.
var (
	ErrDoorBlocked   = errDoorBlocked
	ErrDoorOnPortal  = errDoorOnPortal
	ErrDoorWalled    = errDoorWalled
	ErrDoorInTheOpen = errDoorInTheOpen
	ErrDoorTruncated = errDoorTruncated
	ErrDoorTie       = errDoorTie
	ErrDoorOtherKey  = errDoorOtherKey
	ErrDoorNoEscape  = errDoorNoEscape
	ErrDoorBypassed  = errDoorBypassed
)

// AreaOf returns the area of p (area.go; tests only): 0 for none.
func (w *World) AreaOf(p world.Pos) int32 { return w.areaOf(p) }

// Areas returns how many areas the map has and how many sectors hold a tile of one
// (tests only: the memory of the index, docs/07).
func (w *World) Areas() (areas int32, sectors int) { return w.areaCount, len(w.areas) }

// FreeNear is freeNear (tests only): a search for a free tile by rings from p.
func (w *World) FreeNear(p world.Pos, radius int) (world.Pos, bool) { return w.freeNear(p, radius) }

// HouseAreaOf returns the house area of p (area.go; tests only): 0 for none.
func (w *World) HouseAreaOf(p world.Pos) int32 { return max(-w.tileArea(p), 0) }

// HouseAreas returns how many house areas the map has (tests only).
func (w *World) HouseAreas() int32 { return w.houseAreaCount }

// MarketViewers returns how many open market windows show item's book (mkWatch).
func (w *World) MarketViewers(item uint16) int { return len(w.mkWatch[item]) }

// InFlightForTest reports whether a transfer of charID waits for the database (its
// drops outside houses are held).
func (w *World) InFlightForTest(charID int64) bool { return w.inFlight[charID] != 0 }

// HeldGroundForTest returns how many ground items are reserved to a held character.
func (w *World) HeldGroundForTest() int { return len(w.heldGround) }

// InputAndGiftForTest is one command of cl's player that runs msg and then drops n of
// item id at its feet (they do not fit), as one command that changes a house and gives
// something away does (a rune of the house floor used from the street that kills a quest
// monster, hold.go; TestHouseRuneKillsAQuestMonsterFromTheStreet plays that one with the
// real rune). Tests only.
func (w *World) InputAndGiftForTest(cl Client, msg *pb.ClientMessage, id string, n int) game.Command {
	return game.CommandFunc(func(ctx *game.TickContext) {
		p := w.byClient[cl]
		w.playerCommand(p, func() {
			w.input(ctx, p, msg)
			c := p.capacity
			p.capacity = 0
			w.GiveForTest(p, id, n)
			p.capacity = c
		})
	})
}

// GiftAndInputForTest is one command of cl's player that drops n of item id at its feet
// (they do not fit) and then runs msg: a give-away before the command's own transfer,
// which no command makes (hold.go transferSnapshot logs it). Tests only.
func (w *World) GiftAndInputForTest(cl Client, id string, n int, msg *pb.ClientMessage) game.Command {
	return game.CommandFunc(func(ctx *game.TickContext) {
		p := w.byClient[cl]
		w.playerCommand(p, func() {
			c := p.capacity
			p.capacity = 0
			w.GiveForTest(p, id, n)
			p.capacity = c
			w.input(ctx, p, msg)
		})
	})
}

// UnlistForTest drops p from the index of clients while it stays in the world: the state
// in which Teleport does nothing (tests only).
func (w *World) UnlistForTest(p *Player) { delete(w.byClient, p.client) }

// RelistForTest undoes UnlistForTest.
func (w *World) RelistForTest(p *Player) { w.byClient[p.client] = p }

// HoldForTest holds p as if a transfer of it waited for the ack of its snapshot seq
// (hold.go inFlight; tests only).
func (w *World) HoldForTest(p *Player, seq uint64) { w.inFlight[p.charID] = seq }

// ReserveForTest reserves the ground item it to p until the ack of p's snapshot seq
// (hold.go heldGround; tests only).
func (w *World) ReserveForTest(it *Item, p *Player, seq uint64) {
	w.heldGround[it] = groundHold{char: p.charID, seq: seq}
}

// ReservedTo returns the character the ground item it is reserved to, or 0 (tests only).
func (w *World) ReservedTo(it *Item) int64 { return w.heldGround[it].char }

// DamageMonsterForTest makes p deal dmg physical damage to m, as a hit would (tests only,
// loop goroutine): it counts for the experience, the kill and the loot.
func (w *World) DamageMonsterForTest(ctx *game.TickContext, m *Monster, p *Player, dmg int) {
	w.damageMonster(ctx, m, p, dmg, ElementPhysical)
}

// QueueCapForTest is the capacity of p's step queue (it must not grow while a key is held).
func (p *Player) QueueCapForTest() int { return cap(p.queue) }

// FullViewForTest builds the MapArea of p's whole view as sendFullView does, without
// sending it or changing what p's client knows (benchmarks, loop goroutine).
func (w *World) FullViewForTest(p *Player) *pb.MapArea {
	kept := p.known
	p.known = nil
	area := w.mapArea(p, int(p.pos.X)-ViewHalfW, int(p.pos.Y)-ViewHalfH, ViewW, ViewH)
	p.known = kept
	return area
}

// FaceForTest turns m towards p as a fight does (tests only, loop goroutine).
func (w *World) FaceForTest(m *Monster, p world.Pos) { w.face(m, p) }

// GiveUpForTest makes m give up its fight: full health, told to who sees it (tests only,
// loop goroutine).
func (w *World) GiveUpForTest(ctx *game.TickContext, m *Monster) { w.giveUp(ctx, m) }

// DespawnForTest takes m out of the world without a death: no game path does it yet,
// but the protocol already has the reason (DISAPPEAR_REASON_DESPAWN).
func (w *World) DespawnForTest(m *Monster) { w.removeMonster(m, goneDespawn) }
