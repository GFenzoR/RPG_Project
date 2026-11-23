package session

import (
	"cmp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/dialog"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Global market (T5.3, docs/02-game-design.md "Economía", docs/01 "Transacciones").
//
// The loop owns the whole market in memory, like the guilds: every offer, every mailbox
// and the recent history are loaded once before the loop starts (Config.Market). A
// command is validated and applied on the loop in one tick, so two buyers of the last
// unit are two commands in order: the first takes it, the second finds the offer gone.
// Nothing ever reads the database on the loop.
//
// Every change leaves as one Transfer (a persistence Job): the market rows it changes
// plus the snapshot of the online character whose inventory changed, written by the
// persistence goroutine in ONE database transaction and in queue order with that
// character's autosaves. A crash before the transaction commits loses the operation on
// both sides (the old snapshot and the old market rows); after it, both are there. The
// other party of an operation never needs a snapshot: what it gets goes to its mailbox,
// which is a market row.

// i18n keys of the market messages (i18n/*/client.yaml).
const (
	msgMarketClosed     = "market.closed"
	msgMarketStaff      = "market.staff"
	msgMarketTooFast    = "market.too_fast"
	msgMarketNotHere    = "market.not_at_board"
	msgMarketBadItem    = "market.bad_item"
	msgMarketBadAmount  = "market.bad_amount"
	msgMarketBadPrice   = "market.bad_price"
	msgMarketTooMany    = "market.too_many_offers"
	msgMarketNoItems    = "market.not_enough_items"
	msgMarketNoMoney    = "market.not_enough_money"
	msgMarketNoRoom     = "market.no_room"
	msgMarketGone       = "market.offer_gone"
	msgMarketOwnOffer   = "market.own_offer"
	msgMarketCreated    = "market.created"
	msgMarketCancelled  = "market.cancelled"
	msgMarketBought     = "market.bought"
	msgMarketSold       = "market.sold"
	msgMarketFilled     = "market.offer_filled"
	msgMarketExpired    = "market.offer_expired"
	msgMarketWithdrawn  = "market.withdrawn"
	msgMarketMailEmpty  = "market.mailbox_empty"
	msgMarketMailRoom   = "market.mailbox_room"
	msgMarketReadOnly   = "market.read_only"
	msgGMMarketSell     = "gm.market_offer_sell"
	msgGMMarketBuy      = "gm.market_offer_buy"
	msgGMMarketNone     = "gm.market_none"
	msgGMMarketCanceled = "gm.market_cancelled"
	msgGMMarketUnknown  = "gm.market_unknown"
)

// MarketOffer is one market offer as stored (market_offers). Name and AccountID are the
// owner's, for the listing and the ban check. Mods: a sell offer of an equipable is one
// instance (Amount 1) and keeps its attribute (docs/02 "Atributos de items"); zero on
// anything else.
type MarketOffer struct {
	ID          int64
	CharacterID int64
	AccountID   int64
	Name        string
	Sell        bool
	ItemID      uint16
	Amount      int
	Price       int64
	Created     time.Time
	Expires     time.Time
	Mods        Mods
}

// MarketMail is one item waiting in a mailbox (market_mail_items).
type MarketMail struct {
	ID          int64
	CharacterID int64
	Item        ItemState
	Created     time.Time
}

// MarketHistory is one completed operation of a character (market_history): it sold
// (Sold) or bought Amount units at Price each, with Other.
type MarketHistory struct {
	CharacterID int64
	Other       int64
	Sold        bool
	ItemID      uint16
	Amount      int
	Price       int64
	At          time.Time
}

// MarketSale is the units sold and money paid of one item on one day (UTC) by the
// characters of one seller account to those of one buyer account, for the reference
// prices.
type MarketSale struct {
	ItemID        uint16
	Day           time.Time
	SellerAccount int64
	BuyerAccount  int64
	Units         int64
	Total         int64
}

// MarketData is the market as loaded before the loop starts.
type MarketData struct {
	Offers  []MarketOffer
	Mail    []MarketMail
	Gold    map[int64]int64
	History []MarketHistory // oldest first
	Sales   []MarketSale
	// Bans are the active bans of every account (until; zero = permanent): their offers
	// are hidden and their sales, as seller or buyer, do not count for reference prices.
	Bans      map[int64]time.Time
	OfferHigh int64
	MailHigh  int64
	// TransferHigh is the id of the last transfer written: new ones continue after it.
	TransferHigh int64
}

// MarketOpKind says what a MarketOp changes.
type MarketOpKind uint8

// Market changes. The store applies them in order inside the transfer's transaction.
const (
	// MarketOfferAdd inserts Offer.
	MarketOfferAdd MarketOpKind = iota + 1
	// MarketOfferFill takes Units from offer ID (deleting it at zero). It fails the
	// transaction if the offer has fewer units left: no unit is sold twice.
	MarketOfferFill
	// MarketOfferRemove deletes offer ID (cancelled or expired), which must have exactly
	// Units left: if the database disagrees (a fill of it was not stored), the transfer
	// fails whole instead of returning a smaller deposit than the database holds.
	MarketOfferRemove
	// MarketMailAdd inserts Mail; MarketMailRemove deletes mail ID of CharacterID.
	MarketMailAdd
	MarketMailRemove
	// MarketGoldAdd adds Gold (signed) to the gold mailbox of CharacterID.
	MarketGoldAdd
	// MarketHistoryAdd inserts History.
	MarketHistoryAdd
)

// MarketOp is one market change of a Transfer.
type MarketOp struct {
	Kind        MarketOpKind
	ID          int64
	CharacterID int64
	Units       int
	Gold        int64
	Offer       MarketOffer
	Mail        MarketMail
	History     MarketHistory
}

// Transfer is a change that moves items or gold between characters, or between a
// character and the market (T5.3): the snapshots of the online characters whose
// inventory changed and the market changes, written in one transaction. ID only names it
// in logs. OfferHigh and MailHigh are the highest ids issued so far.
type Transfer struct {
	ID        uint64
	Snapshots []Snapshot
	// Houses are the house changes (T5.4), applied before the market changes.
	Houses []HouseOp
	// Stash are the account stash changes (stash.go), applied after the houses.
	Stash     []StashOp
	Market    []MarketOp
	OfferHigh int64
	MailHigh  int64
}

// offer is a live offer in the book.
type offer struct {
	MarketOffer
	def *content.Item
}

// book is the offers of one item: sells cheapest first, buys dearest first (ties: the
// older offer first).
type book struct {
	sells []*offer
	buys  []*offer
}

func offerOrder(a, b *offer) int {
	if a.Price != b.Price {
		if a.Sell {
			return cmp.Compare(a.Price, b.Price)
		}
		return cmp.Compare(b.Price, a.Price)
	}
	return cmp.Compare(a.ID, b.ID)
}

func (b *book) side(sell bool) *[]*offer {
	if sell {
		return &b.sells
	}
	return &b.buys
}

// mailbox is what waits for a character at the market boards.
type mailbox struct {
	gold  int64
	items []MarketMail // oldest first
}

// priceDay is one day of sales of an item, by seller and buyer account.
type priceDay struct {
	day   int64 // Unix day
	sales []priceSale
}

// priceSale is what one seller account sold of an item on one day to one buyer account.
type priceSale struct{ seller, buyer, units, total int64 }

// priceVote is what one seller account sold of an item on one day that counts for the
// reference price: its vote is the average unit price, total / units.
type priceVote struct{ units, total int64 }

// refCached is a reference price computed on day, valid until until (zero: the whole
// day; else a suspension of an account it left out ends then).
type refCached struct {
	day, price int64
	until      time.Time
}

// marketView is the market window a player has open: the board it stands at and the
// browsed item (0: none, kept in World.mkWatch). queued: a refresh waits in World.mkPush;
// next: the first tick a pushed refresh may go out (World.mkPushEvery apart).
type marketView struct {
	board  world.Pos
	item   uint16
	queued bool
	next   game.Tick
}

func (w *World) initMarket() {
	m := w.cfg.Balance.Market
	if !m.Enabled || w.cfg.Transfer == nil {
		return
	}
	w.mkOn, w.mk = true, m
	w.mkRefill = max(game.Tick(m.ActionRefillMs/int(game.TickDuration.Milliseconds())), 1)
	w.mkBurst = w.mkRefill * game.Tick(m.ActionBurst-1)
	w.mkPushEvery = ticksFor(m.PushEveryMs)
	w.offers = map[int64]*offer{}
	w.books = map[uint16]*book{}
	w.byOwner = map[int64][]*offer{}
	w.mail = map[int64]*mailbox{}
	w.mkWatch = map[uint16][]*Player{}
	w.history = map[int64][]MarketHistory{}
	w.sales = map[uint16][]priceDay{}
	w.refCache = map[uint16]refCached{}
	w.refPairs = map[[2]int64]bool{}
	w.refVotes = map[[2]int64]priceVote{}
	w.refSellers = map[int64]bool{}
	w.refAccounts = map[int64]bool{}
	w.mkKinds = map[pieceKind]bool{}
	d := w.cfg.Market
	if d == nil {
		return
	}
	w.nextOffer, w.nextMail = d.OfferHigh, d.MailHigh
	for id, g := range d.Gold {
		w.box(id).gold = g
	}
	var retired []MarketOp
	for _, o := range d.Offers {
		w.nextOffer = max(w.nextOffer, o.ID)
		def := w.byNum[o.ItemID]
		if def == nil {
			// A retired item: the offer is closed. A buy offer's gold goes back to the
			// mailbox; a sell offer's units of an item that no longer exists are gone.
			w.log.Warn("market: offer of a retired item closed", "offer", o.ID, "item", o.ItemID, "sell", o.Sell)
			retired = append(retired, MarketOp{Kind: MarketOfferRemove, ID: o.ID, Units: o.Amount})
			if !o.Sell {
				gold := int64(o.Amount) * o.Price
				w.box(o.CharacterID).gold += gold
				retired = append(retired, MarketOp{Kind: MarketGoldAdd, CharacterID: o.CharacterID, Gold: gold})
			}
			continue
		}
		w.addOffer(&offer{MarketOffer: o, def: def})
	}
	for _, m := range d.Mail {
		w.box(m.CharacterID).items = append(w.box(m.CharacterID).items, m)
		w.nextMail = max(w.nextMail, m.ID)
	}
	if len(retired) > 0 {
		w.transfer(nil, retired...) // queued now, written when persistence starts
	}
	for _, h := range d.History {
		w.addHistory(h)
	}
	for _, s := range d.Sales {
		w.addSale(s.ItemID, s.Day, s.SellerAccount, s.BuyerAccount, s.Units, s.Total)
	}
	for acc, until := range d.Bans {
		w.banned[acc] = until
	}
}

func (w *World) box(charID int64) *mailbox {
	b := w.mail[charID]
	if b == nil {
		b = &mailbox{}
		w.mail[charID] = b
	}
	return b
}

func (w *World) addOffer(o *offer) {
	w.offers[o.ID] = o
	b := w.books[o.ItemID]
	if b == nil {
		b = &book{}
		w.books[o.ItemID] = b
	}
	list := b.side(o.Sell)
	i, _ := slices.BinarySearchFunc(*list, o, offerOrder)
	*list = slices.Insert(*list, i, o)
	w.byOwner[o.CharacterID] = append(w.byOwner[o.CharacterID], o)
	i, _ = slices.BinarySearchFunc(w.expiry, o, expiryOrder)
	w.expiry = slices.Insert(w.expiry, i, o)
}

func expiryOrder(a, b *offer) int {
	if c := a.Expires.Compare(b.Expires); c != 0 {
		return c
	}
	return cmp.Compare(a.ID, b.ID)
}

func (w *World) dropOffer(o *offer) {
	delete(w.offers, o.ID)
	if b := w.books[o.ItemID]; b != nil {
		list := b.side(o.Sell)
		if i, ok := slices.BinarySearchFunc(*list, o, offerOrder); ok {
			*list = slices.Delete(*list, i, i+1)
		}
		if len(b.sells) == 0 && len(b.buys) == 0 {
			delete(w.books, o.ItemID)
		}
	}
	own := w.byOwner[o.CharacterID]
	if i := slices.Index(own, o); i >= 0 {
		own = slices.Delete(own, i, i+1)
	}
	if len(own) == 0 {
		delete(w.byOwner, o.CharacterID)
	} else {
		w.byOwner[o.CharacterID] = own
	}
	if i, ok := slices.BinarySearchFunc(w.expiry, o, expiryOrder); ok {
		w.expiry = slices.Delete(w.expiry, i, i+1)
	}
}

func (w *World) addHistory(h MarketHistory) {
	w.history[h.CharacterID] = append(w.history[h.CharacterID], h)
	if n := len(w.history[h.CharacterID]) - w.mk.HistorySize; n > 0 {
		w.history[h.CharacterID] = slices.Delete(w.history[h.CharacterID], 0, n)
	}
}

func unixDay(t time.Time) int64 { return t.Unix() / 86400 }

// addSale records units of item sold for total by a character of account seller to one
// of account buyer.
func (w *World) addSale(item uint16, at time.Time, seller, buyer, units, total int64) {
	if units <= 0 {
		return
	}
	delete(w.refCache, item)
	day := unixDay(at)
	days := w.sales[item]
	if n := len(days); n == 0 || days[n-1].day != day {
		days = append(days, priceDay{day: day})
	}
	d := &days[len(days)-1]
	if i := slices.IndexFunc(d.sales, func(s priceSale) bool { return s.seller == seller && s.buyer == buyer }); i >= 0 {
		d.sales[i].units += units
		d.sales[i].total += total
	} else {
		d.sales = append(d.sales, priceSale{seller: seller, buyer: buyer, units: units, total: total})
	}
	// Keep only the reference window.
	first := 0
	for first < len(days) && days[first].day <= day-int64(w.mk.ReferenceDays) {
		first++
	}
	w.sales[item] = days[first:]
}

// referencePrice is the reference price of item (0: none). Informative only. Content
// audit m13: each seller account votes once a day with its average unit price of that
// day, and the reference is the median vote of the last reference_days (the lower one of
// an even count). Left out: the sales between two accounts that sold to each other in the
// window (both ways), and those of suspended accounts. With fewer than
// reference_min_votes votes, reference_min_sellers seller accounts or
// reference_min_accounts accounts in all (sellers and buyers) there is none. So one
// account selling to another of its own, however many units or sales, casts at most one
// vote a day; two that sell to each other cast none, and a ring of three accounts still
// shows only while the other sellers do not outvote it. It is cached per item for the
// day (addSale and a change of suspensions drop it).
func (w *World) referencePrice(item uint16, now time.Time) int64 {
	today := unixDay(now)
	if c, ok := w.refCache[item]; ok && c.day == today && (c.until.IsZero() || now.Before(c.until)) {
		return c.price
	}
	price, until := w.medianVote(item, now)
	w.refCache[item] = refCached{day: today, price: price, until: until}
	return price
}

// medianVote computes referencePrice's value and until when it holds (zero: the day).
func (w *World) medianVote(item uint16, now time.Time) (int64, time.Time) {
	today := unixDay(now)
	var until time.Time
	banned := func(acc int64) bool { // isBanned without forgetting an expired ban
		end, ok := w.banned[acc]
		if !ok || !end.IsZero() && !now.Before(end) {
			return false
		}
		if !end.IsZero() && (until.IsZero() || end.Before(until)) {
			until = end
		}
		return true
	}
	clear(w.refPairs)
	for _, d := range w.sales[item] {
		if d.day > today-int64(w.mk.ReferenceDays) {
			for _, s := range d.sales {
				w.refPairs[[2]int64{s.seller, s.buyer}] = true
			}
		}
	}
	clear(w.refVotes)
	clear(w.refAccounts)
	clear(w.refSellers)
	for _, d := range w.sales[item] {
		if d.day <= today-int64(w.mk.ReferenceDays) {
			continue
		}
		for _, s := range d.sales {
			if w.refPairs[[2]int64{s.buyer, s.seller}] || banned(s.seller) || banned(s.buyer) {
				continue
			}
			k := [2]int64{s.seller, d.day}
			v := w.refVotes[k]
			v.units += s.units
			v.total += s.total
			w.refVotes[k] = v
			w.refSellers[s.seller] = true
			w.refAccounts[s.seller] = true
			w.refAccounts[s.buyer] = true
		}
	}
	prices := w.refPrices[:0]
	for _, v := range w.refVotes { // any order: sorted below
		prices = append(prices, v.total/v.units)
	}
	w.refPrices = prices
	if len(prices) == 0 || len(prices) < max(w.mk.ReferenceMinVotes, 1) ||
		len(w.refSellers) < max(w.mk.ReferenceMinSellers, 1) || len(w.refAccounts) < max(w.mk.ReferenceMinAccounts, 1) {
		return 0, until
	}
	slices.Sort(prices)
	return prices[(len(prices)-1)/2], until
}

// ---- access -----------------------------------------------------------------------

// useMarketBoard opens the market window if m points at a market board of the map. It
// reports whether m was about a board.
func (w *World) useMarketBoard(ctx *game.TickContext, p *Player, m *pb.UseItem) bool {
	pos, ok := posFromMsg(m.GetFrom().GetPos())
	// A tile of another floor or out of view is no board use (like itemAt): no answer
	// about a tile p does not see.
	if !ok || pos.Z != p.pos.Z || !Sees(p.pos, pos) || int(m.GetStackIndex()) >= w.staticCount(pos) {
		return false
	}
	id := w.staticAt(pos, int(m.GetStackIndex()))
	def := w.byNum[id]
	if id == 0 || uint32(id) != m.GetItemId() || def == nil || !def.MarketBoard {
		return false
	}
	switch {
	case !w.mkOn:
		p.emit(systemMsg(msgMarketClosed))
	case !w.near(p, pos):
		p.emit(systemMsg(msgTooFar))
	case p.role > RolePlayer:
		p.emit(systemMsg(msgMarketStaff))
	case w.isBanned(p.accountID, ctx.Now):
		p.emit(systemMsg(msgMarketClosed))
	default:
		w.dropMarket(p) // a window open at another board stops watching its item
		p.market = &marketView{board: pos}
		p.active(ctx.Tick, antibot.KindOther)
		w.sendMarket(ctx.Now, p, false)
	}
	return true
}

// atMarket reports whether p may act on the market now: the window is open and p is
// still next to its board. A player that walked away gets the window closed.
func (w *World) atMarket(ctx *game.TickContext, p *Player) bool {
	if !w.mkOn {
		return false
	}
	if p.market == nil {
		p.emit(systemMsg(msgMarketNotHere))
		return false
	}
	if !w.near(p, p.market.board) {
		w.closeMarket(p)
		p.emit(systemMsg(msgMarketNotHere))
		return false
	}
	if p.role > RolePlayer || w.isBanned(p.accountID, ctx.Now) {
		w.closeMarket(p)
		p.emit(systemMsg(msgMarketStaff))
		return false
	}
	return true
}

// checkMarket closes the window of a player that is no longer next to its board.
func (w *World) checkMarket(p *Player) {
	if p.market != nil && !w.near(p, p.market.board) {
		w.closeMarket(p)
	}
}

func (w *World) closeMarket(p *Player) {
	if p.market == nil {
		return
	}
	w.dropMarket(p)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_MarketUpdate{MarketUpdate: &pb.MarketUpdate{}}})
}

// ---- live refresh -------------------------------------------------------------------
//
// A window shows a snapshot of the market: when another player's action changes what it
// shows (the browsed item's offers, the player's own offers or its mailbox), the loop
// pushes a fresh MarketUpdate (refresh = true) at the end of the tick. mkWatch indexes
// the open windows by browsed item, so an action finds its viewers without walking every
// player; mkPush collects the windows to send, each once per tick at most and
// mkPushEvery (balance.yaml market.push_every_ms) apart: a busy book costs each viewer at
// most one MarketUpdate per push_every_ms, and a change inside that time goes out when it
// ends. A refresh is the whole window (what an answer costs), not a delta. Nothing here
// reads the database.

// dropMarket forgets p's window (closed, walked away, left the world or link-dead).
func (w *World) dropMarket(p *Player) {
	if p.market == nil {
		return
	}
	w.watch(p, 0)
	p.market = nil
}

// watch makes p's open window show item (0: none), keeping mkWatch in step.
func (w *World) watch(p *Player, item uint16) {
	v := p.market
	if v.item == item {
		return
	}
	if v.item != 0 {
		list := w.mkWatch[v.item]
		if i := slices.Index(list, p); i >= 0 {
			list = slices.Delete(list, i, i+1)
		}
		if len(list) == 0 {
			delete(w.mkWatch, v.item)
		} else {
			w.mkWatch[v.item] = list
		}
	}
	v.item = item
	if item != 0 {
		w.mkWatch[item] = append(w.mkWatch[item], p)
	}
}

// bookChanged queues a refresh of every window that shows item's offers.
func (w *World) bookChanged(item uint16) {
	for _, p := range w.mkWatch[item] {
		w.queueMarket(p)
	}
}

// marketOwnerChanged queues a refresh of the window of character id, if it is online
// with the market open: its own offers or its mailbox changed.
func (w *World) marketOwnerChanged(id int64) {
	if p := w.byChar[id]; p != nil {
		w.queueMarket(p)
	}
}

// marketAccountChanged queues a refresh of every window whose book lists an offer of
// account (banned or unbanned: its offers are hidden or shown again). It gathers the
// items the account has offers of (its characters' own lists, at most max_offers each)
// and queues their viewers: no book is walked.
func (w *World) marketAccountChanged(account int64) {
	if w.mkOn {
		clear(w.refCache) // m13: its sales count again or no more for the reference
	}
	if !w.mkOn || len(w.mkWatch) == 0 {
		return
	}
	var items []uint16
	for _, own := range w.byOwner {
		if len(own) == 0 || own[0].AccountID != account { // a character's offers share its account
			continue
		}
		for _, o := range own {
			if !slices.Contains(items, o.ItemID) {
				items = append(items, o.ItemID)
			}
		}
	}
	slices.Sort(items) // byOwner is a map: queue in a fixed order
	for _, item := range items {
		w.bookChanged(item)
	}
}

func (w *World) queueMarket(p *Player) {
	if p.market == nil || p.market.queued {
		return
	}
	p.market.queued = true
	w.mkPush = append(w.mkPush, p)
}

// flushMarket sends the queued refreshes; one still inside its mkPushEvery waits for
// a later tick (it is not lost). Called once per tick, before the batches go out.
func (w *World) flushMarket(ctx *game.TickContext) {
	if len(w.mkPush) == 0 {
		return
	}
	keep := w.mkPush[:0]
	for _, p := range w.mkPush {
		v := p.market
		if v == nil || !v.queued || w.byChar[p.charID] != p {
			continue // closed, already answered by a command this tick, or gone
		}
		if ctx.Tick < v.next {
			keep = append(keep, p)
			continue
		}
		w.sendMarket(ctx.Now, p, true)
		v.next = ctx.Tick + w.mkPushEvery
	}
	clear(w.mkPush[len(keep):])
	w.mkPush = keep
}

// marketFlood counts one action against the market anti-flood limit (GCRA).
func (w *World) marketFlood(ctx *game.TickContext, p *Player) bool {
	tat := max(p.mkTAT, ctx.Tick)
	if tat-ctx.Tick > w.mkBurst {
		p.emit(systemMsg(msgMarketTooFast))
		return false
	}
	p.mkTAT = tat + w.mkRefill
	return true
}

// marketCommand runs one MarketCommand.
func (w *World) marketCommand(ctx *game.TickContext, p *Player, m *pb.MarketCommand) {
	if _, ok := m.GetAction().(*pb.MarketCommand_Close); ok {
		w.dropMarket(p)
		return
	}
	if !w.atMarket(ctx, p) || !w.marketFlood(ctx, p) {
		return
	}
	p.active(ctx.Tick, antibot.KindOther)
	if _, browse := m.GetAction().(*pb.MarketCommand_Browse); !browse && w.readOnly {
		p.emit(systemMsg(msgMarketReadOnly))
		w.sendMarket(ctx.Now, p, false)
		return
	}
	switch a := m.GetAction().(type) {
	case *pb.MarketCommand_Browse:
		if def := w.byNum[uint16(min(a.Browse.GetItemId(), 0xFFFF))]; def != nil && marketItem(def) {
			w.watch(p, def.Numeric)
		} else {
			w.watch(p, 0)
		}
	case *pb.MarketCommand_Create:
		w.marketCreate(ctx, p, a.Create)
	case *pb.MarketCommand_Cancel:
		w.marketCancel(ctx, p, int64(min(a.Cancel.GetOfferId(), 1<<62)))
	case *pb.MarketCommand_Accept:
		w.marketAccept(ctx, p, int64(min(a.Accept.GetOfferId(), 1<<62)), a.Accept.GetAmount(),
			modsOf(a.Accept.GetMods()))
	case *pb.MarketCommand_Withdraw:
		w.marketWithdraw(ctx, p)
	default:
		return
	}
	if p.market != nil {
		w.sendMarket(ctx.Now, p, false) // also answers a refresh this action queued for p
	}
}

// marketItem reports whether def may be offered at all: tradeable and not money.
func marketItem(def *content.Item) bool {
	return def.Tradeable && def.Currency == nil && def.CanPickUp()
}

// marketUnit reports whether it is a unit of def that can go to the market: not
// equipped (the caller walks the containers), empty, and whole (a rune with all its
// charges), so the buyer gets exactly what the seller gave.
func marketUnit(it *Item, def *content.Item) bool {
	return takeable(it, def) && (def.Stackable || it.count == def.StackLimit())
}

// marketInstance returns the first unit of def p carries (in its containers) with exactly
// mods, or nil: the instance of an equipable the player picked (MarketCreate.mods,
// MarketAccept.mods). The mods are only a key: the instance keeps its own.
func (w *World) marketInstance(p *Player, def *content.Item, mods Mods) *Item {
	var found *Item
	p.eachCarried(false, func(it *Item) {
		if found == nil && marketUnit(it, def) && it.mods == mods {
			found = it
		}
	})
	return found
}

// ownedMods are the mods of every market unit of an equipable def p carries
// (MarketUpdate.owned_mods; nil for anything else), the ones a path that takes without
// the player picking would take first at the top (spareFirst: the lowest refine level,
// then the weakest roll): the client's instance picker starts on the first one, so
// selling a +7 always takes a choice.
func (w *World) ownedMods(p *Player, def *content.Item) []*pb.ItemMods {
	if !content.Rolls(def) {
		return nil
	}
	var units []*Item
	p.eachCarried(false, func(it *Item) {
		if marketUnit(it, def) {
			units = append(units, it)
		}
	})
	w.spareFirst(units)
	out := make([]*pb.ItemMods, 0, len(units))
	for _, it := range units {
		m := it.mods.msg()
		if m == nil {
			m = &pb.ItemMods{}
		}
		out = append(out, m)
	}
	return out
}

func (w *World) marketUnits(p *Player, def *content.Item) int {
	n := 0
	p.eachCarried(false, func(it *Item) {
		if marketUnit(it, def) {
			n += units(it)
		}
	})
	return n
}

// takeMarketUnits removes n units of def that marketUnit accepts (the caller checked).
func (w *World) takeMarketUnits(p *Player, def *content.Item, n int) {
	var found []*Item
	p.eachCarried(false, func(it *Item) {
		if marketUnit(it, def) {
			found = append(found, it)
		}
	})
	for _, it := range found {
		if n <= 0 {
			break
		}
		if k := units(it); def.Stackable && k > n {
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

// marketFee is the posting fee of an offer of total value v.
func (w *World) marketFee(v int64) int64 {
	return min(max(v*int64(w.mk.FeePermille)/1000, w.mk.FeeMin), w.mk.FeeMax)
}

// moneyThatFits is the largest part of amount (up to it) that canReceiveMoney accepts.
func (w *World) moneyThatFits(p *Player, amount int64) int64 {
	if w.canReceiveMoney(p, amount) {
		return amount
	}
	lo, hi := int64(0), amount // lo fits, hi does not
	for hi-lo > 1 {
		mid := lo + (hi-lo)/2
		if w.canReceiveMoney(p, mid) {
			lo = mid
		} else {
			hi = mid
		}
	}
	return lo
}

// canReceiveMoney reports whether amount, in the fewest coins, fits in p's packs
// (backpack and pockets, pockets.go; new stacks only: conservative) and capacity.
func (w *World) canReceiveMoney(p *Player, amount int64) bool {
	weight, stacks := 0, 0
	for _, coin := range w.coins {
		n := amount / coin.Currency.Worth
		if n == 0 {
			continue
		}
		amount -= n * coin.Currency.Worth
		if n > int64(1<<20) {
			return false
		}
		weight += coin.Weight * int(n)
		stacks += (int(n) + coin.StackLimit() - 1) / coin.StackLimit()
	}
	if stacks == 0 {
		return true
	}
	return stacks <= p.freeCells() && weight <= p.capacity-p.carried()
}

// ---- operations --------------------------------------------------------------------

func (w *World) marketCreate(ctx *game.TickContext, p *Player, m *pb.MarketCreate) {
	sell := m.GetSide() == pb.MarketSide_MARKET_SIDE_SELL
	if !sell && m.GetSide() != pb.MarketSide_MARKET_SIDE_BUY {
		return
	}
	def := w.byNum[uint16(min(m.GetItemId(), 0xFFFF))]
	switch {
	case def == nil || !marketItem(def):
		p.emit(systemMsg(msgMarketBadItem))
		return
	case m.GetAmount() == 0 || m.GetAmount() > uint32(w.mk.MaxAmount):
		p.emit(systemMsg(msgMarketBadAmount, num("max", w.mk.MaxAmount)))
		return
	case m.GetPrice() == 0 || m.GetPrice() > uint64(w.mk.MaxPrice):
		p.emit(systemMsg(msgMarketBadPrice, num("max", int(w.mk.MaxPrice))))
		return
	case int(m.GetDurationIndex()) >= len(w.mk.DurationsHours):
		return
	case len(w.byOwner[p.charID]) >= w.mk.MaxOffers:
		p.emit(systemMsg(msgMarketTooMany, num("max", w.mk.MaxOffers)))
		return
	}
	// docs/02 "Atributos de items": a sell offer of an equipable is one instance, the one
	// the player picked by its mods.
	var inst *Item
	if sell && content.Rolls(def) {
		if m.GetAmount() != 1 {
			p.emit(systemMsg(msgMarketBadAmount, num("max", 1)))
			return
		}
		if inst = w.marketInstance(p, def, modsOf(m.GetMods())); inst == nil {
			p.emit(systemMsg(msgMarketNoItems))
			return
		}
	}
	amount, price := int(m.GetAmount()), int64(m.GetPrice())
	total := int64(amount) * price
	fee := w.marketFee(total)
	pay := fee
	if !sell {
		pay += total
	}
	if w.money(p) < pay {
		p.emit(systemMsg(msgMarketNoMoney, num("price", int(pay))))
		return
	}
	if !w.canPay(p, pay) {
		p.emit(systemMsg(dialog.MsgNoChangeRoom))
		return
	}
	if sell && w.marketUnits(p, def) < amount {
		p.emit(systemMsg(msgMarketNoItems))
		return
	}
	var mods Mods
	switch {
	case inst != nil:
		mods = inst.mods
		w.removeItem(inst)
		p.questDirty = true
		w.econInstance(p, EconMarket, "offer", 0, inst, -1)
	case sell:
		w.takeMarketUnits(p, def, amount)
		w.econItem(p, EconMarket, "offer", def, -amount)
	}
	w.pay(p, pay)
	w.econGold(p, EconMarket, "fee", -fee)
	if !sell {
		w.econGold(p, EconMarket, "offer", -total)
	}
	w.nextOffer++
	o := &offer{def: def, MarketOffer: MarketOffer{
		ID: w.nextOffer, CharacterID: p.charID, AccountID: p.accountID, Name: p.name, Sell: sell,
		ItemID: def.Numeric, Amount: amount, Price: price, Created: ctx.Now,
		Expires: ctx.Now.Add(time.Duration(w.mk.DurationsHours[m.GetDurationIndex()]) * time.Hour),
		Mods:    mods,
	}}
	w.addOffer(o)
	w.transfer([]*Player{p}, MarketOp{Kind: MarketOfferAdd, Offer: o.MarketOffer})
	w.log.Info("market: offer posted", "character", p.charID, "offer", o.ID, "sell", sell, "item", def.ID,
		"amount", amount, "price", price, "fee", fee)
	p.emit(systemMsg(msgMarketCreated, itemParam(def, amount), num("fee", int(fee))))
	w.watch(p, def.Numeric)
	w.bookChanged(def.Numeric)
	w.afterMarket(p)
}

func (w *World) marketCancel(ctx *game.TickContext, p *Player, id int64) {
	o := w.offers[id]
	if o == nil || o.CharacterID != p.charID {
		p.emit(systemMsg(msgMarketGone))
		return
	}
	w.closeOffer(o, ctx.Now)
	p.emit(systemMsg(msgMarketCancelled, itemParam(o.def, o.Amount)))
}

// closeOffer takes o off the book and returns its deposit to the owner's mailbox
// (cancelled, expired or removed by staff). No inventory changes: no snapshot.
func (w *World) closeOffer(o *offer, now time.Time) {
	w.dropOffer(o)
	ops := []MarketOp{{Kind: MarketOfferRemove, ID: o.ID, Units: o.Amount}}
	if o.Sell {
		ops = append(ops, w.mailItems(o.CharacterID, o.def, o.Amount, o.Mods, now)...)
	} else {
		gold := int64(o.Amount) * o.Price
		w.box(o.CharacterID).gold += gold
		ops = append(ops, MarketOp{Kind: MarketGoldAdd, CharacterID: o.CharacterID, Gold: gold})
	}
	w.transfer(nil, ops...)
	w.bookChanged(o.ItemID)
	w.marketOwnerChanged(o.CharacterID)
}

// mailItems puts n units of def in charID's mailbox, one entry per full stack (or per
// unit when it does not stack), each with mods (an equipable's instance: n is 1), and
// returns the inserts.
func (w *World) mailItems(charID int64, def *content.Item, n int, mods Mods, at time.Time) []MarketOp {
	var ops []MarketOp
	b := w.box(charID)
	for n > 0 {
		k := min(n, def.StackLimit())
		count := k
		if !def.Stackable {
			k, count = 1, def.StackLimit()
		}
		n -= k
		w.nextMail++
		m := MarketMail{ID: w.nextMail, CharacterID: charID, Item: ItemState{ItemID: def.Numeric, Count: count, Mods: mods},
			Created: at}
		b.items = append(b.items, m)
		ops = append(ops, MarketOp{Kind: MarketMailAdd, Mail: m})
	}
	return ops
}

func (w *World) marketAccept(ctx *game.TickContext, p *Player, id int64, n uint32, mods Mods) {
	o := w.offers[id]
	switch {
	case o == nil || w.isBanned(o.AccountID, ctx.Now):
		p.emit(systemMsg(msgMarketGone))
		return
	case o.CharacterID == p.charID || o.AccountID == p.accountID:
		p.emit(systemMsg(msgMarketOwnOffer))
		return
	case n == 0 || n > uint32(o.Amount):
		p.emit(systemMsg(msgMarketBadAmount, num("max", o.Amount)))
		return
	}
	units := int(n)
	total := int64(units) * o.Price
	// Selling an equipable to a buy offer gives the one instance the seller picked.
	var inst *Item
	if !o.Sell && content.Rolls(o.def) {
		if units != 1 {
			p.emit(systemMsg(msgMarketBadAmount, num("max", 1)))
			return
		}
		if inst = w.marketInstance(p, o.def, mods); inst == nil {
			p.emit(systemMsg(msgMarketNoItems))
			return
		}
	}
	var ops []MarketOp
	if o.Sell {
		// p buys: pays now, gets the items now; the seller's gold goes to its mailbox.
		if w.money(p) < total {
			p.emit(systemMsg(msgMarketNoMoney, num("price", int(total))))
			return
		}
		if !w.canBuy(p, o.def, units, total) {
			p.emit(systemMsg(msgMarketNoRoom))
			return
		}
		w.pay(p, total)
		var made []*Item
		if content.Rolls(o.def) {
			// Each unit is its own instance: a new offer is one (Amount 1, with its mods);
			// one posted before attributes existed may hold several without mods, and each
			// unit rolls its own as it is created.
			for range units {
				made = append(made, w.giveMods(p, o.def, o.Mods)...)
			}
		} else {
			made = w.giveItem(p, o.def, units)
		}
		w.econGoldWith(p, EconMarket, "buy", o.CharacterID, -total)
		w.econMade(p, EconMarket, "buy", o.CharacterID, o.def, units, made)
		w.box(o.CharacterID).gold += total
		ops = append(ops, MarketOp{Kind: MarketGoldAdd, CharacterID: o.CharacterID, Gold: total})
		p.emit(systemMsg(msgMarketBought, itemParam(o.def, units), num("price", int(total))))
	} else {
		// p sells: gives the items now, gets the deposited gold now; the buyer's items go
		// to its mailbox.
		if w.marketUnits(p, o.def) < units {
			p.emit(systemMsg(msgMarketNoItems))
			return
		}
		if !w.canReceiveMoney(p, total) {
			p.emit(systemMsg(msgMarketNoRoom))
			return
		}
		var given Mods // the instance's, which the buyer gets
		if inst != nil {
			given = inst.mods
			w.removeItem(inst)
			p.questDirty = true
			w.econInstance(p, EconMarket, "sell", o.CharacterID, inst, -1)
		} else {
			w.takeMarketUnits(p, o.def, units)
			w.econItemWith(p, EconMarket, "sell", o.CharacterID, o.def, -units)
		}
		w.giveMoney(p, total)
		w.econGoldWith(p, EconMarket, "sell", o.CharacterID, total)
		ops = append(ops, w.mailItems(o.CharacterID, o.def, units, given, ctx.Now)...)
		p.emit(systemMsg(msgMarketSold, itemParam(o.def, units), num("price", int(total))))
	}
	o.Amount -= units
	ops = append(ops, MarketOp{Kind: MarketOfferFill, ID: o.ID, Units: units})
	seller, buyer := o.CharacterID, p.charID
	if !o.Sell {
		seller, buyer = p.charID, o.CharacterID
	}
	sold := MarketHistory{CharacterID: seller, Other: buyer, Sold: true, ItemID: o.ItemID, Amount: units, Price: o.Price, At: ctx.Now}
	bought := MarketHistory{CharacterID: buyer, Other: seller, ItemID: o.ItemID, Amount: units, Price: o.Price, At: ctx.Now}
	w.addHistory(sold)
	w.addHistory(bought)
	sellerAcc, buyerAcc := o.AccountID, p.accountID
	if !o.Sell {
		sellerAcc, buyerAcc = p.accountID, o.AccountID
	}
	w.addSale(o.ItemID, ctx.Now, sellerAcc, buyerAcc, int64(units), total)
	ops = append(ops, MarketOp{Kind: MarketHistoryAdd, History: sold}, MarketOp{Kind: MarketHistoryAdd, History: bought})
	if o.Amount == 0 {
		w.dropOffer(o)
	}
	w.transfer([]*Player{p}, ops...)
	w.log.Info("market: offer accepted", "character", p.charID, "offer", o.ID, "owner", o.CharacterID,
		"item", o.def.ID, "amount", units, "total", total)
	if owner := w.byChar[o.CharacterID]; owner != nil {
		owner.emit(systemMsg(msgMarketFilled, itemParam(o.def, units), num("price", int(total))))
	}
	w.bookChanged(o.ItemID)
	w.marketOwnerChanged(o.CharacterID)
	w.afterMarket(p)
}

func (w *World) marketWithdraw(ctx *game.TickContext, p *Player) {
	b := w.mail[p.charID]
	if b == nil || b.gold == 0 && len(b.items) == 0 {
		p.emit(systemMsg(msgMarketMailEmpty))
		return
	}
	var ops []MarketOp
	full := false
	// In order, every item that fits; one that does not (too heavy, no room) stays and the
	// next ones are still tried, so nothing blocks the mailbox (T5.4).
	kept := b.items[:0]
	for _, m := range b.items {
		def := w.byNum[m.Item.ItemID]
		if def == nil { // retired item: it stays in the database, out of the way
			continue
		}
		n := m.Item.Count
		if !def.Stackable {
			n = 1
		}
		if !def.Stackable && (len(m.Item.Items) > 0 || m.Item.Count != def.StackLimit() || content.Rolls(def) ||
			!m.Item.Mods.Zero()) {
			// The saved instance itself (T5.4): a rune keeps its charges (a container that
			// still has content, from before houses mailed them flat, keeps it), an
			// equipable its attribute (one mailed without, from before attributes, rolls it).
			it := w.loadItem(m.Item)
			pack := p.packWithRoom() // the backpack, or else the pockets (pockets.go)
			if it == nil || pack == nil || it.weight() > p.capacity-p.carried() || depth(pack)+1+it.height() > maxDepth {
				full = true
				kept = append(kept, m)
				continue
			}
			w.attach(p, it, place{kind: locContainer, cont: pack})
			w.containerChanged(pack)
			w.econTree(p, EconMarket, "mailbox", it, 1)
			ops = append(ops, MarketOp{Kind: MarketMailRemove, ID: m.ID, CharacterID: p.charID})
			continue
		}
		if !w.canReceive(p, def, n, 0) {
			full = true
			kept = append(kept, m)
			continue
		}
		w.giveItem(p, def, n)
		w.econItem(p, EconMarket, "mailbox", def, n)
		ops = append(ops, MarketOp{Kind: MarketMailRemove, ID: m.ID, CharacterID: p.charID})
	}
	clear(b.items[len(kept):])
	b.items = kept
	if b.gold > 0 {
		// Then as much of the gold as fits (the rest waits): it never takes the room of items.
		gold := w.moneyThatFits(p, b.gold)
		if gold < b.gold {
			full = true
		}
		if gold > 0 {
			w.giveMoney(p, gold)
			w.econGold(p, EconMarket, "mailbox", gold)
			b.gold -= gold
			ops = append(ops, MarketOp{Kind: MarketGoldAdd, CharacterID: p.charID, Gold: -gold})
			p.emit(systemMsg(msgMarketWithdrawn, num("price", int(gold))))
		}
	}
	if b.gold == 0 && len(b.items) == 0 {
		delete(w.mail, p.charID)
	}
	if full {
		p.emit(systemMsg(msgMarketMailRoom))
	}
	if len(ops) == 0 {
		return
	}
	w.transfer([]*Player{p}, ops...)
	w.afterMarket(p)
}

func (w *World) afterMarket(p *Player) {
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
}

// transfer submits one Transfer with the snapshots of players (whose inventory changed)
// and the market changes ops.
func (w *World) transfer(players []*Player, ops ...MarketOp) {
	w.flushHouses() // T5.4: before numbering, so transfer ids grow in submission order
	w.nextTransfer++
	t := Transfer{ID: w.nextTransfer, Market: ops, OfferHigh: w.nextOffer, MailHigh: w.nextMail}
	for _, p := range players {
		t.Snapshots = append(t.Snapshots, w.transferSnapshot(p))
	}
	w.submitJob(Job{Transfer: &t})
}

// checkMarketExpiry returns the deposits of the expired offers to their mailboxes, once
// per second; at most marketExpireBatch per sweep keeps the tick's cost bounded.
func (w *World) checkMarketExpiry(ctx *game.TickContext) {
	if !w.mkOn || w.readOnly || ctx.Tick < w.mkNext {
		return
	}
	w.mkNext = ctx.Tick + game.Tick(1000/game.TickDuration.Milliseconds())
	for n := 0; n < marketExpireBatch && len(w.expiry) > 0 && !w.expiry[0].Expires.After(ctx.Now); n++ {
		o := w.expiry[0]
		w.closeOffer(o, ctx.Now)
		if owner := w.byChar[o.CharacterID]; owner != nil {
			owner.emit(systemMsg(msgMarketExpired, itemParam(o.def, o.Amount)))
		}
		w.log.Info("market: offer expired", "offer", o.ID, "character", o.CharacterID)
	}
}

// marketExpireBatch bounds the offers one expiry sweep closes.
const marketExpireBatch = 64

// ---- the window ---------------------------------------------------------------------

func (w *World) offerMsg(o *offer, p *Player) *pb.MarketOffer {
	side := pb.MarketSide_MARKET_SIDE_BUY
	if o.Sell {
		side = pb.MarketSide_MARKET_SIDE_SELL
	}
	return &pb.MarketOffer{
		OfferId: uint64(o.ID), Side: side, ItemId: uint32(o.ItemID), Amount: uint32(o.Amount),
		Price: uint64(o.Price), ExpiresAt: uint64(max(o.Expires.UnixMilli(), 0)), OwnerName: o.Name,
		Own: o.CharacterID == p.charID, Mods: o.Mods.msg(),
	}
}

// sendMarket sends p its market window: the browsed item's best offers (hidden: those
// of banned accounts), its own offers, its mailbox and its history. refresh: pushed by
// flushMarket, not the answer to p's own command. Either way the window is now current,
// so a refresh queued for it is no longer needed.
func (w *World) sendMarket(now time.Time, p *Player, refresh bool) {
	mk := w.mk
	p.market.queued = false
	u := &pb.MarketUpdate{
		Open: true, Money: uint64(max(w.money(p), 0)), FeePermille: uint32(mk.FeePermille),
		FeeMin: uint64(mk.FeeMin), FeeMax: uint64(mk.FeeMax), MaxOffers: uint32(mk.MaxOffers),
		MaxAmount: uint32(mk.MaxAmount), MaxPrice: uint64(mk.MaxPrice), ReadOnly: w.readOnly,
		Refresh: refresh,
	}
	for _, h := range mk.DurationsHours {
		u.DurationsHours = append(u.DurationsHours, uint32(h))
	}
	if item := p.market.item; item != 0 {
		u.ItemId = uint32(item)
		u.ReferencePrice = uint64(w.referencePrice(item, now))
		u.Owned = uint32(w.marketUnits(p, w.byNum[item]))
		u.OwnedMods = w.ownedMods(p, w.byNum[item])
		if b := w.books[item]; b != nil {
			u.Sells = w.listing(b.sells, p, now, true)
			u.Buys = w.listing(b.buys, p, now, false)
		}
	}
	for _, o := range w.byOwner[p.charID] {
		u.Own = append(u.Own, w.offerMsg(o, p))
	}
	if b := w.mail[p.charID]; b != nil {
		u.MailboxGold = uint64(b.gold)
		for i, m := range b.items {
			if i == mk.MailboxShown {
				u.MailboxMore = uint32(len(b.items) - i)
				break
			}
			u.MailboxItems = append(u.MailboxItems, &pb.MarketMailItem{Id: uint64(m.ID),
				Item: &pb.ItemStack{ItemId: uint32(m.Item.ItemID), Count: uint32(m.Item.Count), Mods: m.Item.Mods.msg()}})
		}
	}
	hist := w.history[p.charID]
	for i := len(hist) - 1; i >= 0; i-- {
		h := hist[i]
		side := pb.MarketSide_MARKET_SIDE_BUY
		if h.Sold {
			side = pb.MarketSide_MARKET_SIDE_SELL
		}
		u.History = append(u.History, &pb.MarketHistoryEntry{Side: side, ItemId: uint32(h.ItemID),
			Amount: uint32(h.Amount), Price: uint64(h.Price), At: uint64(max(h.At.UnixMilli(), 0))})
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_MarketUpdate{MarketUpdate: u}})
}

// listing is the best visible offers of one side, in its order: the first list_size and,
// for the sells of an item that rolls an attribute (pieces), also the best one of every
// kind of piece further down: one per attribute and refine level (pieceKind). Each sell
// of a piece is an offer of its own, so without them a refined piece or a rare attribute
// dearer than list_size common ones would show to nobody and nobody could take it
// (docs/02 "Mercado global", final review of lote 11). The rows stay in price order and
// are at most list_size plus the kinds on sale. Hidden offers (banned owners) are
// skipped; there are few. The walk is the whole book only for the sells of pieces.
func (w *World) listing(list []*offer, p *Player, now time.Time, kinds bool) []*pb.MarketOffer {
	var out []*pb.MarketOffer
	kinds = kinds && len(list) > 0 && content.Rolls(list[0].def)
	clear(w.mkKinds)
	for _, o := range list {
		if len(out) >= w.mk.ListSize && !kinds {
			break
		}
		if w.isBanned(o.AccountID, now) {
			continue
		}
		k := pieceKind{attr: o.Mods.Attr, refine: o.Mods.Refine}
		if len(out) < w.mk.ListSize || kinds && !w.mkKinds[k] {
			w.mkKinds[k] = true
			out = append(out, w.offerMsg(o, p))
		}
	}
	return out
}

// pieceKind is what tells one sell of a piece from another in the listing: its attribute
// and its refine level (the value of the attribute does not: the cheapest of a kind
// shows, and the next one once it is taken).
type pieceKind struct {
	attr   string
	refine int
}

// ---- staff ---------------------------------------------------------------------------

// cmdMarketOffers: "/marketoffers Name" lists the offers of a character (online or not).
func (w *World) cmdMarketOffers(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) == 0 || !w.mkOn {
		return false
	}
	name := strings.Join(args, " ")
	key := strings.ToLower(name)
	n := 0
	for _, list := range w.byOwner {
		for _, o := range list {
			if strings.ToLower(o.Name) != key {
				continue
			}
			n++
			key := msgGMMarketBuy
			if o.Sell {
				key = msgGMMarketSell
			}
			p.emit(systemMsg(key, num("id", int(o.ID)), textParam("name", o.Name), itemParam(o.def, o.Amount),
				num("price", int(o.Price))))
		}
	}
	if n == 0 {
		p.emit(systemMsg(msgGMMarketNone, textParam("name", name)))
	}
	w.audit(ctx, p, "market_offers", nil, map[string]string{"target": name, "offers": itoa(n)}, auditOK)
	return true
}

// cmdMarketCancel: "/marketcancel id" takes an offer down; its deposit goes back to the
// owner's mailbox, as if it expired.
func (w *World) cmdMarketCancel(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) != 1 || !w.mkOn {
		return false
	}
	if w.readOnly {
		p.emit(systemMsg(msgMarketReadOnly))
		return true
	}
	id, err := strconv.ParseInt(args[0], 10, 64)
	o := w.offers[id]
	if err != nil || o == nil {
		p.emit(systemMsg(msgGMMarketUnknown, textParam("id", args[0])))
		w.audit(ctx, p, "market_cancel", nil, map[string]string{"offer": args[0]}, auditInvalid)
		return true
	}
	w.closeOffer(o, ctx.Now)
	p.emit(systemMsg(msgGMMarketCanceled, num("id", int(o.ID)), textParam("name", o.Name)))
	if owner := w.byChar[o.CharacterID]; owner != nil {
		owner.emit(systemMsg(msgMarketExpired, itemParam(o.def, o.Amount)))
	}
	w.audit(ctx, p, "market_cancel", nil, map[string]string{"offer": args[0], "target": o.Name,
		"item": o.def.ID, "amount": itoa(o.Amount), "price": strconv.FormatInt(o.Price, 10), "side": sideName(o.Sell)}, auditOK)
	return true
}

func sideName(sell bool) string {
	if sell {
		return "sell"
	}
	return "buy"
}

// ---- a transfer that was not stored ------------------------------------------------

// Tainted returns the command the persistence side enqueues when transfers of characters
// could not be stored (T5.3, Saver taint): the database stays behind what the loop holds
// for them, and anything else built on it would be saved by halves. So the failure is
// made safe until a restart: those characters leave the world (SAVE_FAILED), their
// unsaved state is dropped and their logins are refused (CHARACTER_LOCKED); the market
// becomes read-only (browse only, no expiry) and every open trade is cancelled. The
// corpses they left while held, and what was reserved to them on the ground, stay
// reserved (locked out, hold.go): the items there may come from the dropped state; a
// corpse decays. The operator sees the error log,
// persistence_errors_total{outcome="skipped"} and its alert.
func (w *World) Tainted(ids []int64) game.Command {
	return game.CommandFunc(func(ctx *game.TickContext) {
		fresh := !w.readOnly
		if fresh {
			w.log.Error("market: a transfer was not stored; market and trades are read-only until a restart")
		}
		w.readOnly = true
		w.closeEveryStash() // stash.go: no deposit or withdrawal until a restart
		for len(w.trades) > 0 {
			w.endTrade(w.trades[0], pb.TradeState_TRADE_STATE_CANCELLED, tradeCancelReadOnly)
		}
		for _, id := range ids {
			w.locked[id] = true
			if p := w.byChar[id]; p != nil {
				w.remove(ctx, p, pb.DisconnectReason_DISCONNECT_REASON_SAVE_FAILED, false)
			}
			delete(w.unsaved, id)
			delete(w.inFlight, id)
			w.log.Error("session: character locked until a restart, a transfer of it was not stored", "character", id)
		}
		if !fresh {
			return // the windows already show it: a later taint changes nothing they show
		}
		for _, p := range w.players {
			if p.market != nil {
				w.sendMarket(ctx.Now, p, true)
			}
		}
	})
}

// ReadOnly reports whether the market and the trade window are read-only (Tainted).
// Loop goroutine only.
func (w *World) ReadOnly() bool { return w.readOnly }
