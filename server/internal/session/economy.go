package session

import (
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
)

// Economy log (T4.1, docs/01-architecture.md "Trampas y anti-bot"). Every creation and
// destruction of gold and items is an EconomyEntry with its source. The loop only
// appends entries to a reused buffer; at flush they get the tick's time and go to the
// persistence goroutine (Config.Economy) by value, so the tick never waits for the
// database and recording an entry does not allocate.
//
// Each online character also has a ledger: the gold and item units it had when it
// joined plus what its entries (and its moves to and from the ground) say it gained and
// lost. Every economy.check_every_ms its actual possessions must match; a mismatch is a
// code path that creates or destroys things without saying so (possible duplication).

// Sources of the economy log (economy_log.kind).
const (
	EconLoot    = "loot"     // a monster's remains were filled (character: the loot owner)
	EconNPCBuy  = "npc_buy"  // bought from an NPC: money out, items in
	EconNPCSell = "npc_sell" // sold to an NPC: items out, money in
	EconNPC     = "npc"      // given or taken by an NPC dialog (quest items, blessings)
	EconQuest   = "quest"    // quest rewards
	EconTravel  = "travel"   // boat fare and ticket
	EconTrade   = "trade"    // player trade (reserved: the trade window does not exist yet)
	EconGather  = "gather"   // fishing, mining, woodcutting
	EconCraft   = "craft"    // crafting inputs out, output in
	EconDeath   = "death"    // lost into the remains at death
	EconGM      = "gm"       // created by a staff command (/item)
	EconConsume = "consume"  // eaten, drunk, a rune's last charge, ammo shot
	EconConjure = "conjure"  // created by a spell
	EconDecay   = "decay"    // left in remains that decayed (character: the dead player, if any)
)

// EconomyEntry is one row of the economy log. Count (item units) and Amount (money, in
// the smallest coin) are signed: positive is created or received, negative destroyed or
// lost. ItemID 0 means a money entry. Ref is the content id of the source (monster, NPC,
// quest, recipe, resource...) and always a static string.
type EconomyEntry struct {
	At               time.Time
	Kind             string
	CharacterID      int64
	OtherCharacterID int64
	ItemID           uint16
	Count            int32
	Amount           int64
	Ref              string
}

// holdings is what the ledger reconciles: money (smallest coin) and item units (coins
// excluded; a container counts as one unit plus its content).
type holdings struct {
	gold  int64
	units int64
}

func (h holdings) add(o holdings) holdings { return holdings{h.gold + o.gold, h.units + o.units} }

// Alert kinds (Config.Alert, metric economy_alerts_total{kind}).
const (
	AlertMismatch     = "mismatch"
	AlertGoldOutlier  = "gold_outlier"
	AlertItemsOutlier = "items_outlier"
	AlertLogDropped   = "log_dropped"
)

// maxEconRetry bounds the entries kept while the persistence queue is full; beyond it
// they are dropped (and alerted): the log must never grow the loop's memory unbounded.
const maxEconRetry = 1 << 16

// initEconomy reads balance.yaml economy in ticks.
func (w *World) initEconomy() {
	e := w.cfg.Balance.Economy
	w.econCheckFor = game.TicksFor(time.Duration(e.CheckEveryMs) * time.Millisecond)
	w.outlierFor = game.TicksFor(time.Duration(e.Outlier.WindowMs) * time.Millisecond)
	w.earnings = map[int64]*earning{}
}

// measure returns the holdings of count units of it (all of it if count >= it.count)
// and of everything inside it.
func measure(it *Item, count int) holdings {
	var h holdings
	n := min(count, it.count)
	if c := it.def.Currency; c != nil {
		h.gold = c.Worth * int64(n)
	} else if it.def.Stackable {
		h.units = int64(n)
	} else {
		h.units = 1
	}
	for _, c := range it.items {
		h = h.add(measure(c, c.count))
	}
	return h
}

// held returns what p carries now.
func (w *World) held(p *Player) holdings {
	var h holdings
	for _, it := range p.equip {
		if it != nil {
			h = h.add(measure(it, it.count))
		}
	}
	return h
}

// econItem records n units (signed) of def for p from source kind and books them.
func (w *World) econItem(p *Player, kind, ref string, def *content.Item, n int) {
	if def == nil || n == 0 || p == nil {
		return
	}
	if c := def.Currency; c != nil {
		w.econGold(p, kind, ref, c.Worth*int64(n))
		return
	}
	p.econDelta.units += int64(n)
	if n > 0 && earns(kind) {
		p.earn.items += int64(n)
	}
	w.econRecord(p, EconomyEntry{Kind: kind, CharacterID: p.charID, ItemID: def.Numeric, Count: int32(n), Ref: ref})
}

// econGold records amount (signed) of money for p and books it.
func (w *World) econGold(p *Player, kind, ref string, amount int64) {
	if amount == 0 || p == nil {
		return
	}
	p.econDelta.gold += amount
	switch {
	case amount > 0 && earns(kind):
		p.earn.gold += amount
	case kind == EconNPCBuy:
		p.earn.gold += amount // buying back from an NPC is not new wealth (sell and rebuy)
	}
	w.econRecord(p, EconomyEntry{Kind: kind, CharacterID: p.charID, Amount: amount, Ref: ref})
}

// econTree records it and everything inside it (signed by sign) for p: a whole
// container lost at death.
func (w *World) econTree(p *Player, kind, ref string, it *Item, sign int) {
	w.econItem(p, kind, ref, it.def, sign*units(it))
	for _, c := range it.items {
		w.econTree(p, kind, ref, c, sign)
	}
}

// econWorld records n units (signed) of def that are not anyone's possessions (used
// or decayed on the ground): logged for character id charID (0 = nobody), no ledger.
func (w *World) econWorld(charID int64, kind, ref string, def *content.Item, n int) {
	if def == nil || n == 0 {
		return
	}
	e := EconomyEntry{Kind: kind, CharacterID: charID, Ref: ref}
	if c := def.Currency; c != nil {
		e.Amount = c.Worth * int64(n)
	} else {
		e.ItemID, e.Count = def.Numeric, int32(n)
	}
	w.econRecord(nil, e)
}

// econWorldTree records it and everything inside it as destroyed (econWorld).
func (w *World) econWorldTree(charID int64, kind, ref string, it *Item) {
	w.econWorld(charID, kind, ref, it.def, -units(it))
	for _, c := range it.items {
		w.econWorldTree(charID, kind, ref, c)
	}
}

// econLoot records the loot of a monster's remains: it is created on the ground, so no
// ledger moves, but it counts as what the owner earned (outliers).
func (w *World) econLoot(owner *Player, monster string, it *Item) {
	e := EconomyEntry{Kind: EconLoot, Ref: monster}
	if owner != nil {
		e.CharacterID = owner.charID
	}
	n := units(it)
	if c := it.def.Currency; c != nil {
		e.Amount = c.Worth * int64(n)
		if owner != nil {
			owner.earn.gold += e.Amount
		}
	} else {
		e.ItemID, e.Count = it.def.Numeric, int32(n)
		if owner != nil {
			owner.earn.items += int64(n)
		}
	}
	w.econRecord(owner, e)
}

// earns reports whether a positive entry of kind is new wealth for the outlier check
// (buying from an NPC is not: it was paid for).
func earns(kind string) bool { return kind != EconNPCBuy && kind != EconTrade }

// ground books h moving between p and the ground (sign +1 picked up, -1 dropped). It is
// not logged: items on the ground stay in the world.
func (p *Player) ground(h holdings, sign int64) {
	p.econDelta.gold += sign * h.gold
	p.econDelta.units += sign * h.units
}

func (w *World) econRecord(p *Player, e EconomyEntry) {
	if p != nil {
		p.recordEconomy(w.nowTick(), &e)
	}
	if w.cfg.Economy == nil {
		return
	}
	w.econBuf = append(w.econBuf, e)
}

// flushEconomy stamps this tick's entries with its time and submits them; what the
// queue does not take waits (in order) for the next ticks, up to maxEconRetry.
func (w *World) flushEconomy(ctx *game.TickContext) {
	if w.cfg.Economy == nil {
		return
	}
	n := 0
	for n < len(w.econRetry) && w.cfg.Economy(w.econRetry[n]) {
		n++
	}
	w.econRetry = append(w.econRetry[:0], w.econRetry[n:]...)
	for i := range w.econBuf {
		e := w.econBuf[i]
		e.At = ctx.Now
		if len(w.econRetry) > 0 || !w.cfg.Economy(e) {
			if len(w.econRetry) >= maxEconRetry {
				w.econDropped++
				continue
			}
			w.econRetry = append(w.econRetry, e)
		}
	}
	w.econBuf = w.econBuf[:0]
	if w.econDropped > 0 && ctx.Tick%game.TicksFor(time.Second) == 0 {
		w.log.Error("economy: log entries dropped, persistence queue full", "dropped", w.econDropped)
		w.alert(AlertLogDropped)
		w.econDropped = 0
	}
}

// PendingEconomy returns the entries not queued yet (shutdown), stamped with now. Call
// it only after the loop stopped.
func (w *World) PendingEconomy(now time.Time) []EconomyEntry {
	out := append([]EconomyEntry(nil), w.econRetry...)
	for _, e := range w.econBuf {
		e.At = now
		out = append(out, e)
	}
	w.econRetry, w.econBuf = w.econRetry[:0], w.econBuf[:0]
	return out
}

// earning is what a character created in its current outlier window. It lives in the
// World by character, so logging out and in does not restart the window.
type earning struct {
	start   game.Tick
	xp      int64 // experience gained (bot detection, T4.1 2/2)
	gold    int64
	items   int64
	alerted uint8 // 1 gold, 2 items already alerted in this window
}

// startLedger sets p's ledger to what it carries at login and finds its outlier window.
func (w *World) startLedger(tick game.Tick, p *Player) {
	p.econBase, p.econDelta = w.held(p), holdings{}
	p.earn = w.earnings[p.charID]
	if p.earn == nil {
		p.earn = &earning{start: tick}
		w.earnings[p.charID] = p.earn
	}
	if w.econCheckFor > 0 {
		// Staggered by creature id (no random draw: the seeded sequence stays the same).
		p.econNext = tick + 1 + game.Tick(p.id)%w.econCheckFor
	}
}

// checkEconomy reconciles the ledgers that are due and checks the outliers. Once per
// window it forgets the windows of characters that are offline and expired.
func (w *World) checkEconomy(tick game.Tick) {
	w.pruneEarnings(tick) // also with the checks off: the map must not grow forever
	if w.econCheckFor == 0 {
		return
	}
	for _, p := range w.players {
		if tick < p.econNext {
			continue
		}
		p.econNext = tick + w.econCheckFor
		w.reconcile(tick, p)
	}
}

// pruneEarnings forgets, once per outlier window, the windows of characters that are
// offline and expired.
func (w *World) pruneEarnings(tick game.Tick) {
	if tick >= w.earnPrune {
		w.earnPrune = tick + max(w.outlierFor, 1)
		for id, e := range w.earnings {
			if w.byChar[id] == nil && tick-e.start >= w.outlierFor {
				delete(w.earnings, id)
			}
		}
	}
}

func (w *World) reconcile(tick game.Tick, p *Player) {
	want, got := p.econBase.add(p.econDelta), w.held(p)
	if got != want {
		w.log.Error("economy: possessions do not match the economy log (possible duplication)",
			"character", p.charID, "name", p.name, "gold", got.gold, "gold_expected", want.gold,
			"units", got.units, "units_expected", want.units)
		w.alert(AlertMismatch)
		p.econBase, p.econDelta = got, holdings{}
	}
	e := p.earn
	if e == nil {
		return
	}
	o := w.cfg.Balance.Economy.Outlier
	window := time.Duration(o.WindowMs) * time.Millisecond
	perWindow := func(perHour int64) int64 { return int64(float64(perHour) * window.Hours()) }
	// Compare first, then start a new window: what came in since the last check counts.
	if e.alerted&1 == 0 && e.gold > perWindow(o.GoldPerHour.At(p.level)) {
		e.alerted |= 1
		w.log.Warn("economy: character earns gold far above normal", "character", p.charID, "name", p.name,
			"level", p.level, "gold", e.gold, "window", window.String())
		w.alert(AlertGoldOutlier)
	}
	if e.alerted&2 == 0 && e.items > perWindow(o.ItemsPerHour.At(p.level)) {
		e.alerted |= 2
		w.log.Warn("economy: character creates items far above normal", "character", p.charID, "name", p.name,
			"level", p.level, "items", e.items, "window", window.String())
		w.alert(AlertItemsOutlier)
	}
	if tick-e.start >= w.outlierFor {
		*e = earning{start: tick}
	}
}

func (w *World) alert(kind string) {
	if w.cfg.Alert != nil {
		w.cfg.Alert(kind)
	}
}
