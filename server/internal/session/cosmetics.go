package session

import (
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Cosmetic shop in the game (T5.7, docs/02 "Tienda cosmética"). Purchases happen on the
// website (httpapi/shop.go, one database transaction each); the game only equips what
// the account owns. What the account owns and its balance are loaded with the login
// (Character.Owned, Premium) and pushed by the HTTP side through CosmeticsChanged: the
// loop never reads the shop tables. Equipped cosmetics are only a look: no game rule
// reads Player.cos (the sim test TestCosmeticsDoNotChangeCombat checks it).

// Cosmetics are the equipped cosmetics of a character: content ids of
// data/cosmetics.yaml, one per kind ("" = the default look).
type Cosmetics struct {
	Outfit, Color, NameEffect string
}

// ShopUpdate is the shop state of an account after a change outside the loop (a
// purchase on the website, a payment, a refund, a staff grant).
type ShopUpdate struct {
	AccountID int64
	Owned     []string
	Balance   int64
	// Seq is the id of the account's newest premium_ledger row: an update older than
	// what a player already has is ignored (two updates may arrive out of order).
	Seq int64
}

// Message keys of the shop.
const (
	msgShopNotOwned    = "shop.not_owned"
	msgShopUnavailable = "shop.unavailable"
)

// The equip anti-flood (every change is broadcast to the watchers) and the bound of a
// staff /premium change are data/cosmetics.yaml limits.
const (
	// shopPendingFor is how long an update for an account that is not online is kept,
	// for a login whose database read ran before the purchase committed.
	shopPendingFor = game.Tick(120 * 1000 / 50)
)

type pendingShop struct {
	up   ShopUpdate
	tick game.Tick
}

// cosmeticsMsg is the protocol form of c.
func cosmeticsMsg(c Cosmetics) *pb.Cosmetics {
	if c == (Cosmetics{}) {
		return nil
	}
	return &pb.Cosmetics{Outfit: c.Outfit, Color: c.Color, NameEffect: c.NameEffect}
}

// loadCosmetics sets p's shop state at login. An equipped cosmetic the account no longer
// owns, or that left the catalog, is dropped (default look).
func (w *World) loadCosmetics(p *Player, c Character) {
	p.owned = slices.Clone(c.Owned)
	slices.Sort(p.owned)
	p.premium, p.premSeq = c.Premium, c.PremiumSeq
	if pend, ok := w.shopPending[p.accountID]; ok && pend.up.Seq >= p.premSeq {
		p.owned, p.premium, p.premSeq = slices.Clone(pend.up.Owned), pend.up.Balance, pend.up.Seq
	}
	p.cos = w.validCosmetics(p, c.Cosmetics)
}

// validCosmetics keeps the slots of c that p may wear.
func (w *World) validCosmetics(p *Player, c Cosmetics) Cosmetics {
	keep := func(id, kind string) string {
		if id == "" {
			return ""
		}
		if def := w.cfg.Cosmetics.Cosmetic(id); def == nil || def.Kind != kind || !p.owns(id) {
			return ""
		}
		return id
	}
	return Cosmetics{
		Outfit:     keep(c.Outfit, content.CosmeticOutfit),
		Color:      keep(c.Color, content.CosmeticColor),
		NameEffect: keep(c.NameEffect, content.CosmeticNameEffect),
	}
}

func (p *Player) owns(id string) bool {
	_, ok := slices.BinarySearch(p.owned, id)
	return ok
}

// cosmeticsState is p's CosmeticsState.
func (w *World) cosmeticsState(p *Player) *pb.ServerMessage {
	return &pb.ServerMessage{Message: &pb.ServerMessage_CosmeticsState{CosmeticsState: &pb.CosmeticsState{
		Owned: slices.Clone(p.owned), Balance: p.premium, Equipped: cosmeticsMsg(p.cos),
	}}}
}

// sendCosmetics sends p its CosmeticsState if the server has a catalog.
func (w *World) sendCosmetics(p *Player) {
	if w.cfg.Cosmetics != nil {
		p.emit(w.cosmeticsState(p))
	}
}

// equipCosmetic handles EquipCosmetic: the cosmetic must exist and be owned.
func (w *World) equipCosmetic(ctx *game.TickContext, p *Player, id string) {
	if w.cfg.Cosmetics == nil {
		p.emit(systemMsg(msgShopUnavailable))
		return
	}
	if !w.cosmeticFlood(ctx, p) {
		return
	}
	def := w.cfg.Cosmetics.Cosmetic(id)
	if def == nil || !p.owns(id) {
		p.emit(systemMsg(msgShopNotOwned))
		w.sendCosmetics(p)
		return
	}
	c := p.cos
	switch def.Kind {
	case content.CosmeticOutfit:
		c.Outfit = id
	case content.CosmeticColor:
		c.Color = id
	case content.CosmeticNameEffect:
		c.NameEffect = id
	default:
		p.emit(systemMsg(msgShopNotOwned))
		return
	}
	w.setCosmetics(p, c)
}

// unequipCosmetic handles UnequipCosmetic: one slot back to the default look.
func (w *World) unequipCosmetic(ctx *game.TickContext, p *Player, kind string) {
	if w.cfg.Cosmetics == nil {
		p.emit(systemMsg(msgShopUnavailable))
		return
	}
	if !w.cosmeticFlood(ctx, p) {
		return
	}
	c := p.cos
	switch kind {
	case content.CosmeticOutfit:
		c.Outfit = ""
	case content.CosmeticColor:
		c.Color = ""
	case content.CosmeticNameEffect:
		c.NameEffect = ""
	default:
		return // not a slot: a malformed intent, ignored
	}
	w.setCosmetics(p, c)
}

// cosmeticFlood counts one equip change (GCRA: a burst of limits.equip_burst, then one
// every limits.equip_refill_ms); over the limit it is dropped silently.
func (w *World) cosmeticFlood(ctx *game.TickContext, p *Player) bool {
	l := w.cfg.Cosmetics.Limits
	refill := ticksFor(l.EquipRefillMs)
	now := ctx.Tick
	tat := max(p.cosTAT, now)
	if tat-now > refill*game.Tick(l.EquipBurst-1) {
		return false
	}
	p.cosTAT = tat + refill
	return true
}

// setCosmetics changes p's look, tells its watchers (CreatureCosmetics) and p
// (CosmeticsState). It is saved with the next snapshot, like everything else.
func (w *World) setCosmetics(p *Player, c Cosmetics) {
	changed := c != p.cos
	p.cos = c
	if changed {
		msg := &pb.ServerMessage{Message: &pb.ServerMessage_CreatureCosmetics{CreatureCosmetics: &pb.CreatureCosmetics{
			Id: p.id, Cosmetics: cosmeticsMsg(c),
		}}}
		w.eachWatcher(p, func(o *Player) {
			if o != p {
				o.emit(msg)
			}
		})
		p.emit(msg)
	}
	p.emit(w.cosmeticsState(p))
}

// CosmeticsChanged returns the command the HTTP side enqueues after an account's shop
// state changed (app.shopChanged): every online character of the account gets the new
// owned list and balance (CosmeticsState). An update for an account with nobody online
// is kept for shopPendingFor, for a login that read the database just before.
func (w *World) CosmeticsChanged(u ShopUpdate) game.Command {
	return game.CommandFunc(func(ctx *game.TickContext) {
		online := false
		for _, p := range w.players {
			if p.accountID != u.AccountID {
				continue
			}
			online = true
			if u.Seq < p.premSeq {
				continue
			}
			p.owned, p.premium, p.premSeq = slices.Clone(u.Owned), u.Balance, u.Seq
			slices.Sort(p.owned)
			// A cosmetic taken away (none is today) would come off here.
			if c := w.validCosmetics(p, p.cos); c != p.cos {
				w.setCosmetics(p, c)
				continue
			}
			w.sendCosmetics(p)
		}
		if !online {
			if old, ok := w.shopPending[u.AccountID]; !ok || old.up.Seq <= u.Seq {
				w.shopPending[u.AccountID] = pendingShop{up: u, tick: ctx.Tick}
			}
		}
	})
}

// pruneShopPending forgets the updates kept for logins in flight, once a minute.
func (w *World) pruneShopPending(tick game.Tick) {
	if len(w.shopPending) == 0 || tick < w.shopPrune {
		return
	}
	w.shopPrune = tick + game.Tick(60*1000/50)
	for id, pend := range w.shopPending {
		if tick-pend.tick > shopPendingFor {
			delete(w.shopPending, id)
		}
	}
}

// ---- staff commands --------------------------------------------------------------

// PremiumEntry is one premium_ledger row shown by /purchases.
type PremiumEntry struct {
	At     time.Time
	Reason string
	Delta  int64
	Ref    string // cosmetic or pack id, or the staff note
}

// cmdPremium: "/premium Name +100 reason" or "/premium Name -100 reason" changes the
// balance of the account of a character (online or not); "/premium Name +0 reason"
// with "clear" as the reason's first word also clears its shop flag. The database writes
// the ledger row and the audit entry in one transaction; AdminDone answers.
func (w *World) cmdPremium(ctx *game.TickContext, p *Player, args []string) bool {
	at := -1
	for i, a := range args {
		if len(a) > 1 && (a[0] == '+' || a[0] == '-') && a[1] >= '0' && a[1] <= '9' {
			if _, err := strconv.ParseInt(a, 10, 64); err == nil {
				at = i
				break
			}
		}
	}
	if at <= 0 || at == len(args)-1 {
		return false
	}
	delta, _ := strconv.ParseInt(args[at], 10, 64)
	name := strings.Join(args[:at], " ")
	note := cleanChat(strings.Join(args[at+1:], " "))
	if w.cfg.Cosmetics == nil {
		p.emit(systemMsg(msgShopUnavailable))
		return true
	}
	maxGrant := w.cfg.Cosmetics.Limits.MaxPremiumGrant
	if delta < -maxGrant || delta > maxGrant || len([]rune(note)) > MaxBanReason || note == "" {
		p.emit(systemMsg(msgGMPremiumAmount, num64("max", maxGrant)))
		w.audit(ctx, p, "premium_grant", nil, map[string]string{"target": name, "delta": args[at]}, auditInvalid)
		return true
	}
	clear := strings.EqualFold(strings.Fields(note)[0], "clear")
	if delta == 0 && !clear {
		return false
	}
	job := AdminJob{Kind: AdminPremium, TargetName: name, ActorRole: p.role, Reason: note, Delta: delta, ClearFlag: clear}
	w.submitAdmin(ctx, p, job, "premium_grant", map[string]string{"delta": args[at], "note": note})
	return true
}

// cmdPurchases: "/purchases Name" lists the newest premium ledger rows of the account of
// a character, with its balance (audited).
func (w *World) cmdPurchases(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) == 0 {
		return false
	}
	w.submitAdmin(ctx, p, AdminJob{Kind: AdminPurchases, TargetName: strings.Join(args, " "), ActorRole: p.role},
		"premium_history", nil)
	return true
}

// premiumDone answers the staff member of an AdminPremium or AdminPurchases job.
func (w *World) premiumDone(gm *Player, kind AdminJobKind, r AdminResult) {
	name := textParam("name", r.Name)
	switch {
	case r.Result == AdminNotFound:
		gm.emit(systemMsg(msgGMNotFound, name))
	case r.Result == AdminInsufficient:
		gm.emit(systemMsg(msgGMPremiumLow, name, num64("balance", r.Balance)))
	case r.Result != AdminOK:
		gm.emit(systemMsg(msgGMFailed))
	case kind == AdminPremium:
		gm.emit(systemMsg(msgGMPremiumDone, name, num64("balance", r.Balance)))
	default:
		gm.emit(systemMsg(msgGMPurchases, name, num64("balance", r.Balance), num("count", len(r.Premium))))
		for _, e := range r.Premium {
			gm.emit(systemMsg(msgGMPurchaseLine, textParam("at", e.At.UTC().Format("2006-01-02 15:04")),
				textParam("reason", e.Reason), num64("amount", e.Delta), textParam("ref", e.Ref)))
		}
	}
}

func num64(name string, v int64) *pb.TextParam {
	return &pb.TextParam{Name: name, Value: &pb.TextParam_Number{Number: v}}
}
