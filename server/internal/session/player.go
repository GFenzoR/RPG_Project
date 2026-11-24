package session

import (
	"slices"
	"sort"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Player is a player character in the world. Loop goroutine only.
type Player struct {
	id        uint32
	charID    int64
	accountID int64
	name      string
	town      string // residence: the island whose temple it wakes up at (T1.11)
	vocation  content.Vocation
	client    Client
	// role is the account's role at login (T2.6): what staff commands p may run.
	role Role
	// cmdTAT is the staff command rate limit's theoretical arrival tick (GCRA).
	cmdTAT game.Tick

	level      int
	experience int64
	health     int
	maxHealth  int
	mana       int
	maxMana    int
	capacity   int
	// speed is the effective speed: baseSpeed (vocation and level) with the speed
	// conditions (T3.2).
	speed     int
	baseSpeed int

	pos world.Pos
	dir world.Direction

	// Walking: queue[qhead:] are the steps left; readyAt is the first tick at which
	// the next step may start (the current step's duration has elapsed).
	queue   []world.Direction
	qhead   int
	readyAt game.Tick
	// dest is where a WalkPath ends; reroutes around creatures aim at it.
	dest    world.Pos
	hasDest bool
	// keyWalk: the queue holds only keyboard steps (Walk), which a Walk queues after;
	// a path or a chase step is dropped by the next Walk instead.
	keyWalk bool
	// qseq is the Walk.seq of each keyboard step, parallel to queue while keyWalk (empty
	// otherwise): the step's CreatureMove carries it back to the client (walk_seq).
	qseq []uint32
	// walkEpoch numbers the resets of the walk (WalkRejected, FullMapView): a Walk of
	// another epoch was sent before the client heard of the last one. Never 0 (a Walk
	// with 0 skips the check).
	walkEpoch uint32

	// known is the sorted list of creature ids the client knows (has been sent).
	known []uint32
	out   []*pb.ServerMessage

	autosave game.EventID

	// Combat (T1.6): the monster being attacked, the stance and chase mode from
	// SetFightMode, and the first tick of the next attack round.
	target     *Monster
	stance     pb.FightStance
	chase      bool
	nextAttack game.Tick

	// Progress (T1.7): skills aligned with World.skillIDs, the equipment that trains
	// them (set by T1.8), the last tick the target fought back (anti-AFK, 0 = not
	// fighting yet), the shield tries of the current attack round, and regeneration.
	skills      []skillSlot
	weapon      *content.Item
	shield      *content.Item
	afkTarget   *Monster
	answeredAt  game.Tick
	shieldRound game.Tick
	shieldTries int
	regen       game.EventID

	// Items (T1.8): equipment by pb.EquipmentSlot, the armor it adds up to, the open
	// container windows (oldest first), the last window id, the first tick a
	// consumable can be used again and the first tick p may open or close a door again.
	equip [equipSlots]*Item
	// pockets are p's built-in pocket cells (pockets.go): a container that is part of p,
	// never an item of its equipment.
	pockets *Item
	armor   int
	// gear is what the attributes of the worn items add up to (attributes.go): already
	// in maxHealth, maxMana and armor; the rest is read by the formulas. gearFrom are the
	// worn instances with an attribute it was summed from.
	gear          gearBonus
	gearFrom      [equipSlots]*Item
	open          []openContainer
	nextContainer uint32
	nextUse       game.Tick
	nextDoor      game.Tick

	// Chat (T1.13): the anti-flood theoretical arrival tick (GCRA), the tick a flood
	// mute ends and the first tick p may speak on the global channel again.
	chatTAT     game.Tick
	mutedUntil  game.Tick
	globalReady game.Tick

	// Magic (T1.9): the first tick each spell, and each spell group, can be cast again.
	spellReady map[string]game.Tick
	groupReady map[string]game.Tick

	// NPCs and quests (T1.10): storage values (quest_state), the open dialog, the last
	// dialog id and whether the inventory changed this tick (has_item steps).
	storage    *quest.Log
	dialog     *openDialog
	nextDialog uint32
	questDirty bool
	// The quest log (questlog.go): the places of the current reach steps and the floors
	// they are on (a bit per floor: a move off them costs one test), whether those must
	// be read again after a quest changed, and whether the client's QuestLog is stale.
	reach         []*reachPlace
	reachFloors   uint16
	reachStale    bool
	questLogDirty bool
	// milestoneMarks is the fingerprint of the met marks last sent in the quest log.
	milestoneMarks uint64
	// sigilMet is what it met of the milestone of the plate it stands on when last
	// checked (sigilMarks): a change marks the room again (sigilRecheck).
	sigilMet uint8
	// An Inventory held back (holdInventory): above 0, sendInventory only marks it due,
	// and the outermost release sends one with the state by then.
	invHold int
	invDue  bool

	// Gathering (T1.12): the first tick p can gather again, the tile p has been
	// gathering from since gatherSince (anti-AFK, 0 = not gathering yet) and its last
	// counted attempt.
	nextGather game.Tick
	// nextPush is when p may push a living object again (livingworld.go).
	nextPush    game.Tick
	gatherPos   world.Pos
	gatherSince game.Tick
	gatherLast  game.Tick

	// Conditions (T3.2): the active ones (few: at most one per condition id), whether
	// the client's list is stale, and whether p is hidden by invisibility. statusTold is
	// what the client was last told of p's statuses (status.go).
	conds           []*condition
	conditionsDirty bool
	invisible       bool
	statusTold      statusView

	// Parties (T3.3): the party, what p's client last heard of it, the first tick of its
	// next periodic update, and the last tick p helped a fight (0 = never).
	party         *party
	partyView     []partyView
	partyState    pb.SharedExperience
	partyNext     game.Tick
	contributedAt game.Tick

	// Market and trade (T5.3): the open market window, the market anti-flood (GCRA) and
	// the trade p is in (as requester or partner).
	market *marketView
	mkTAT  game.Tick
	// house is the house window p has open and hsTAT its anti-flood (T5.4).
	house *houseView
	hsTAT game.Tick
	trade *trade
	// stash is the account stash window p has open at the chest stashAt (stash.go), and
	// stashTAT its anti-flood (GCRA).
	stash    *accountStash
	stashAt  world.Pos
	stashTAT game.Tick
	// tradeTAT is the trade anti-flood's theoretical arrival tick (GCRA).
	tradeTAT game.Tick
	// gave is set from a give-away to the public ground (T5.3 fail-safe, lote 16, hold.go
	// gaveAway) until p's snapshot after it is taken: settleGivers submits it at once,
	// or at the end of its coalescing window (giveNext). Any snapshot of p clears it.
	gave bool
	// gaveRoots are where p's give-aways since its last snapshot landed (the pile or the
	// container lying on the street): the next snapshot of p reserves them to p with its
	// seq (heldGround), so nobody else takes them before the database has p without them.
	// giveWait are the ones already reserved while their save waits for giveNext (the
	// tick the next give-away save may go out: one per giveSaveEvery); giveDue: p is in
	// World.giveDue.
	gaveRoots []*Item
	giveWait  []*Item
	giveNext  game.Tick
	giveDue   bool
	// left are the piles and containers on the public ground that leftHouse reserved to p
	// since its last transfer snapshot: the house write that took them out numbers their
	// reservations with p's snapshot in it (hold.go numberLeft). What p gave away in a
	// command that also changed a house joins them (reserveGiven).
	left []*Item
	// given are where p's give-aways since its last snapshot landed on the public ground,
	// one entry each: the pile or container when it may be reserved to p (a pile of its
	// own, or one already reserved to p), nil when it may not (a stranger's pile or bag).
	// Cleared with gave (snapshot).
	given []*Item

	// Guilds (T5.1): p's membership (nil: none) and whether a GuildUpdate is queued.
	gm          *guildMember
	guildQueued bool

	// PvP (T5.2, pvp.go): the player p attacks (instead of target), safe mode, the
	// marks (mark is murderer or outlaw until markUntil; aggressor until aggrUntil), the
	// skull its observers last heard, whether p is in World.skulled, its kill counter and
	// unjustified kills (oldest first), the recent player hits on p, and the locks: no
	// logout or protection zone until lockUntil (attacker), no logout until fightUntil.
	ptarget    *Player
	safe       bool
	mark       pb.Skull
	markUntil  time.Time
	aggrUntil  time.Time
	skull      pb.Skull
	skullList  bool
	pvpKills   int
	unjust     []time.Time
	hitBy      []pvpHit
	lockUntil  game.Tick
	fightUntil game.Tick
	// linkDead: its connection closed in a fight (inCombat); it stays until the fight is
	// over or travel.link_dead_max_ms passed since linkDeadAt (linkdead.go holdsLinkDead).
	linkDead   bool
	linkDeadAt game.Tick
	// dropped: the loop closed its connection (Client.Close) while it stayed link-dead (a
	// slow client, a password reset); nothing is sent or closed when it leaves.
	dropped bool
	// diedLinkDead: it died while link-dead and leaves at the end of the tick, saved then
	// (deathSave, checkLinkDead).
	diedLinkDead bool

	// Travel (T3.5): the last tick p fought (attacked, hurt or hitting a monster; 0 =
	// never, or not since its death), which blocks sailing and logging out for balance
	// travel.combat_block_ms (inCombat).
	fightAt game.Tick

	// Economy (T4.1): what p carried at login, what the log says it gained and lost
	// since, the tick of the next reconciliation, and its outlier window (World.earnings).
	econBase  holdings
	econDelta holdings
	econNext  game.Tick
	earn      *earning

	// Reports (T4.1): p's recent events, chat lines in a ring of their own so that a
	// burst of other events cannot push them out before a report.
	recent   eventRing
	chats    eventRing
	eventSeq uint64

	// Idle (T4.1): the tick of p's last real action and whether it was warned.
	lastAction game.Tick
	idleWarned bool
	// Bot detection (T4.1 2/2): p's state (World.suspects; nil when off) and the tick
	// of its next evaluation.
	sus    *suspect
	abNext game.Tick
	// earlyTry: the last try of each kind of action refused for its cooldown; kindLast:
	// the last accepted one (antibot.Kind*; see activePaced).
	earlyTry [antibot.NumKinds]game.Tick
	kindLast [antibot.NumKinds]game.Tick
	joinedAt game.Tick

	// Tutorial (T4.2): the current step index + 1, 0 when not in the tutorial, and the
	// tick and monster of p's last kill while in it (tutorialMet).
	tut       int
	tutKillAt game.Tick
	tutKill   string

	// Cosmetic shop (T5.7, cosmetics.go): the equipped cosmetics (a look only: no game
	// rule reads them), the account's cosmetics (sorted) and premium balance with the
	// ledger seq they come from, and the equip anti-flood (GCRA).
	cos     Cosmetics
	owned   []string
	premium int64
	premSeq int64
	cosTAT  game.Tick

	// Appearance (look.go): the body (a look only: no game rule reads it) and its message,
	// the item ids of the visible slots and theirs (nil: nothing shows), and the SetLook
	// anti-flood (GCRA); lookOff: appearance.unavailable was already said (no looks.yaml).
	look     content.Look
	lookMsg  *pb.BodyLook
	shown    shownItems
	equipMsg *pb.VisibleEquipment
	lookTAT  game.Tick
	lookOff  bool
	// lookDirty: in World.lookDirty, its CreatureLook goes out at the end of the tick.
	lookDirty bool
	// turnTAT: the Turn broadcast anti-flood (GCRA, move.go turnFlood); turnHeld: in
	// World.turnHeld, its last direction not told to the observers yet.
	turnTAT  game.Tick
	turnHeld bool
}

// Invisible reports whether p is invisible (T3.2).
func (p *Player) Invisible() bool { return p.invisible }

// Health returns the player's current and maximum health.
func (p *Player) Health() (cur, maxHealth int) { return p.health, p.maxHealth }

// Experience returns the player's total experience.
func (p *Player) Experience() int64 { return p.experience }

// Target returns the creature id the player attacks, or 0.
func (p *Player) Target() uint32 {
	if p.ptarget != nil {
		return p.ptarget.id
	}
	if p.target == nil {
		return 0
	}
	return p.target.id
}

// ID returns the player's creature id.
func (p *Player) ID() uint32 { return p.id }

// CharacterID returns the database id of the character.
func (p *Player) CharacterID() int64 { return p.charID }

// Pos returns the player's position.
func (p *Player) Pos() world.Pos { return p.pos }

// Dir returns the direction the player faces.
func (p *Player) Dir() world.Direction { return p.dir }

// Speed returns the player's speed.
func (p *Player) Speed() int { return p.speed }

// Walking reports whether the player has steps queued.
func (p *Player) Walking() bool { return p.qhead < len(p.queue) }

// Knows reports whether the player's client knows creature id.
func (p *Player) Knows(id uint32) bool {
	i := sort.Search(len(p.known), func(i int) bool { return p.known[i] >= id })
	return i < len(p.known) && p.known[i] == id
}

// Known returns the creature ids the client knows, sorted.
func (p *Player) Known() []uint32 { return p.known }

func (p *Player) remember(id uint32) {
	i := sort.Search(len(p.known), func(i int) bool { return p.known[i] >= id })
	if i < len(p.known) && p.known[i] == id {
		return
	}
	p.known = append(p.known, 0)
	copy(p.known[i+1:], p.known[i:])
	p.known[i] = id
}

func (p *Player) forget(id uint32) bool {
	i := sort.Search(len(p.known), func(i int) bool { return p.known[i] >= id })
	if i == len(p.known) || p.known[i] != id {
		return false
	}
	p.known = append(p.known[:i], p.known[i+1:]...)
	return true
}

func (p *Player) emit(m *pb.ServerMessage) { p.out = append(p.out, m) }

func (p *Player) stopWalk() {
	p.queue = p.queue[:0]
	p.qseq = p.qseq[:0]
	p.qhead = 0
	p.hasDest = false
	p.keyWalk = false
}

// queued is how many steps are left in the queue.
func (p *Player) queued() int { return len(p.queue) - p.qhead }

// resetWalk empties the queue and starts a new walk epoch: Walks still on their way
// (sent before the client hears of the reset) are dropped when they arrive.
func (p *Player) resetWalk() {
	p.stopWalk()
	p.walkEpoch++
	if p.walkEpoch == 0 {
		p.walkEpoch = 1
	}
}

// WalkEpoch returns the current walk epoch (tests).
func (p *Player) WalkEpoch() uint32 { return p.walkEpoch }

func (w *World) snapshot(p *Player, final bool) Snapshot {
	// T5.4: no snapshot is taken while a house has unwritten item changes (an autosave
	// would carry an inventory without the house that explains it). Every site that
	// numbers a transfer flushes before numbering; inside the flush this is a no-op.
	w.flushHouses()
	w.saveSeq++
	// T5.3 / lote 16: every snapshot is submitted (a save or a transfer's), and it comes
	// after whatever p gave away so far: what that landed in is reserved to p until the
	// database acks this snapshot (hold.go reserveGave).
	w.reserveGave(p, w.saveSeq)
	p.gave = false
	clear(p.given)
	p.given = p.given[:0]
	return Snapshot{
		CharacterID: p.charID,
		Seq:         w.saveSeq,
		Level:       p.level,
		Experience:  p.experience,
		Health:      p.health,
		Mana:        p.mana,
		Pos:         p.pos,
		Skills:      p.skillStates(w.skillIDs),
		Inventory:   p.inventoryStates(),
		Storage:     p.storage.Values(),
		Conditions:  w.conditionStates(p),
		PvP:         w.pvpState(p),
		Cosmetics:   p.cos,
		Look:        p.look,
		Final:       final,
	}
}

// ---- join and leave -----------------------------------------------------------

// Join returns the command that puts a loaded character in the world for client. If the
// character is already online, the old connection is closed (LOGGED_IN_ELSEWHERE) and
// the new one takes over its in-memory state.
func (w *World) Join(c Character, client Client) game.Command {
	// Lifecycle lane (game/fairness.go): a flooded queue never refuses a login.
	return game.LifecycleFunc(func(ctx *game.TickContext) { w.join(ctx, c, client) })
}

// Leave returns the command that removes client's player (connection closed). It is
// idempotent: a client that already left is ignored. In combat the player stays link-dead
// instead (linkDeadOnLeave), also when the loop closed the connection itself (disconnect):
// the gateway's Leave that follows changes nothing.
//
// It stays in the shared queue, behind what the connection enqueued before it (an attack
// sent right before closing still counts); the gateway moves it to the lifecycle lane only
// when that queue is full (gateway leave).
func (w *World) Leave(client Client) game.Command {
	return game.CommandFunc(func(ctx *game.TickContext) {
		if p := w.byClient[client]; p != nil && !w.linkDeadOnLeave(ctx.Tick, p) {
			w.remove(ctx, p, pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED, false)
		}
	})
}

// Saved returns the command the persistence goroutine enqueues after writing a
// snapshot. The Saver writes in order and skips everything of a character after a
// transfer it dropped, so an ack of seq means the database has that character's state
// at seq, built on every transfer before it: the final snapshot of a character is
// forgotten once it (or a later one) is in, unless a login of that character is reading
// the database right now;
// the hold ends if seq covers the last transfer, and every reservation it covers is
// freed (T5.3, hold.go). So one ack stands for every earlier one of its character: the
// app retries only the highest seq per character the full queue refused, and a late
// ack is harmless.
//
// It goes through the lifecycle lane, like LoginStarted: the two must share one FIFO
// (see LoginStarted). The acks are bounded by the saves, so they cannot flood the lane.
func (w *World) Saved(characterID int64, seq uint64) game.Command {
	return game.LifecycleFunc(func(*game.TickContext) {
		if s, ok := w.unsaved[characterID]; ok && s.Seq <= seq && w.loading[characterID] == 0 {
			delete(w.unsaved, characterID)
		}
		w.confirmed(characterID, seq)
		w.stashSaved(characterID, seq)
	})
}

// LoginStarted returns the command the gateway enqueues before it reads a character
// from the database. It must be followed by Join or LoginAborted for the same
// character. LoginStarted and Saved both go through the lifecycle lane, which is FIFO:
// the gateway enqueues LoginStarted before it reads, so the ack of a save that the read
// may have missed is enqueued after it, runs after it and keeps the unsaved snapshot for
// the Join. (With Saved in the shared queue, an ack enqueued while that queue is being
// drained would run before a LoginStarted waiting in the lane for the next tick.)
//
// accountID is the character's account: while a login of it reads, the World keeps the
// account's stash in memory (stash.go), since the read may have missed a write of it.
func (w *World) LoginStarted(characterID, accountID int64) game.Command {
	return game.LifecycleFunc(func(*game.TickContext) {
		w.loading[characterID]++
		w.stashLoginStarted(accountID)
	})
}

// LoginAborted returns the command that ends a LoginStarted whose Join never comes.
func (w *World) LoginAborted(characterID, accountID int64) game.Command {
	return game.LifecycleFunc(func(*game.TickContext) {
		w.loginDone(characterID)
		w.stashLoginDone(accountID)
		w.releaseStash(accountID)
	})
}

func (w *World) loginDone(characterID int64) {
	if w.loading[characterID] <= 1 {
		delete(w.loading, characterID)
	} else {
		w.loading[characterID]--
	}
}

// accountFull reports whether the account already has Config.MaxCharactersPerAccount
// characters in the world (link-dead ones included). Loop goroutine only.
func (w *World) accountFull(accountID int64) bool {
	limit := w.cfg.MaxCharactersPerAccount
	if limit < 0 {
		return false
	}
	return w.byAccount[accountID] >= limit // O(1) per Join (review of lote 16)
}

func (w *World) join(ctx *game.TickContext, c Character, client Client) {
	w.sched = ctx.Sched
	w.loginDone(c.ID)
	account := c.AccountID
	joined := false
	defer func() {
		// Only now: until stashJoin ran, this login's read of the stash may be older than
		// the copy in memory, which must not leave it in between (replacing the character
		// below removes the account's only player: review of the stash, blocking 1).
		w.stashLoginDone(account)
		if !joined {
			w.releaseStash(account) // stash.go: a refused login no longer needs it
		}
	}()
	if old := w.byClient[client]; old != nil {
		return // one character per connection
	}
	if w.isBanned(c.AccountID, ctx.Now) {
		// Banned while this login was reading the database (the row it read had no ban).
		client.Close(pb.DisconnectReason_DISCONNECT_REASON_BANNED)
		return
	}
	if reason, ok := w.revokedLogin(c, ctx.Now); ok {
		// The account's sessions were revoked after this login spent its play token
		// (review of lote 17): the revocation's kick could not find it yet.
		client.Close(reason)
		return
	}
	if w.locked[c.ID] {
		// T5.3: a trade or market change of the character could not be saved; the database
		// is behind its last state in memory, which was dropped. Until a restart.
		client.Close(pb.DisconnectReason_DISCONNECT_REASON_CHARACTER_LOCKED)
		return
	}
	if w.byChar[c.ID] == nil && w.accountFull(c.AccountID) {
		// Audit lote 16: one account cannot fill the world with its characters. Taking
		// over a character already online (below) is not a new one.
		client.Close(pb.DisconnectReason_DISCONNECT_REASON_TOO_MANY_CHARACTERS)
		return
	}
	voc, ok := w.cfg.Vocations[c.Vocation]
	if !ok {
		w.log.Error("session: unknown vocation, login refused", "character", c.ID, "vocation", c.Vocation)
		client.Close(pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED)
		return
	}
	var carry *Player // the player this login replaces, for its fight and PvP locks
	if old := w.byChar[c.ID]; old != nil {
		carry = old
		// Logged in again while online: continue from the in-memory state.
		c = w.state(old, c)
		w.remove(ctx, old, pb.DisconnectReason_DISCONNECT_REASON_LOGGED_IN_ELSEWHERE, false)
		delete(w.unsaved, c.ID) // the new player carries the state; it saves it later
	} else if s, ok := w.unsaved[c.ID]; ok {
		// Left recently and the database may not have the final save yet.
		c.Level, c.Experience, c.Health, c.Mana = s.Level, s.Experience, s.Health, s.Mana
		c.Pos, c.HasPos = s.Pos, true
		c.Skills = s.Skills
		c.Inventory, c.InventoryLoaded = s.Inventory, true
		c.Storage = s.Storage
		c.Conditions = s.Conditions
		c.PvP = s.PvP
		c.Cosmetics = s.Cosmetics
		c.Look = s.Look
	}

	stats := voc.AtLevel(c.Level)
	w.nextID++
	p := &Player{
		id:         w.nextID,
		charID:     c.ID,
		accountID:  c.AccountID,
		name:       c.Name,
		town:       c.Town,
		vocation:   voc,
		client:     client,
		role:       c.Role,
		level:      max(c.Level, 1),
		experience: c.Experience,
		maxHealth:  stats.Health,
		maxMana:    stats.Mana,
		capacity:   stats.Capacity,
		speed:      max(stats.Speed, 1),
		baseSpeed:  max(stats.Speed, 1),
		dir:        world.South,
		stance:     pb.FightStance_FIGHT_STANCE_BALANCED,
		safe:       true, // T5.2: until the client says otherwise
		walkEpoch:  1,
	}
	p.pos = w.placement(c)
	w.loadSkills(p, c.Skills)
	// An equipable saved before attributes existed rolls its own while loading: the
	// character is saved at once with it (below), so a crash before its first autosave
	// does not roll another at the next login.
	rolled := slices.ContainsFunc(c.Inventory, w.needsRoll)
	w.loadInventory(p, c.Inventory, !c.HasPos && !c.InventoryLoaded)
	// After the equipment: its attributes may raise the maximums (attributes.go).
	p.health = min(max(c.Health, 0), p.maxHealth)
	if p.health == 0 {
		p.health = p.maxHealth // never spawn a dead character (death respawns with full health)
	}
	p.mana = min(max(c.Mana, 0), p.maxMana)
	p.storage = quest.NewLog(c.Storage)
	w.loadPvP(ctx, p, c.PvP) // before anyone is told about p (Creature.skull)
	if carry != nil {
		w.carryFight(carry, p) // a link-dead character taken over keeps its fight and locks
	}
	if w.guildOn {
		p.gm = w.guildMembers[p.charID] // before anyone is told about p (Creature.guild)
	}
	w.loadCosmetics(p, c)          // before anyone is told about p (Creature.cosmetics)
	w.loadLook(p, c)               // and Creature.look
	p.pos = w.houseLogin(p, p.pos) // T5.4: a house it may no longer enter (after the guild)

	w.players = append(w.players, p) // ids grow, so the slice stays ordered
	w.published.Store(int32(len(w.players)))
	w.byClient[client] = p
	w.byChar[c.ID] = p
	w.byAccount[p.accountID]++
	joined = true
	stashRolled := w.stashJoin(p, c) // stash.go: the one in memory, or else the one this login read
	w.index(p)

	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{
		CreatureId:     p.id,
		ServerTime:     uint64(max(ctx.Now.UnixMilli(), 0)),
		TickMs:         uint32(game.TickDuration.Milliseconds()),
		MaxQueuedSteps: uint32(w.mv.MaxQueuedSteps),
		ViewWidth:      ViewTilesW,
		ViewHeight:     ViewTilesH,
		AttackEvents:   true, // CreatureAttack and CreatureDisappear.reason (attack.go)
	}}})
	// Saved conditions first (T3.2): the first stats, and what observers get, already
	// carry their speed (and an invisible player is never shown).
	w.loadConditions(ctx, p, c.Conditions)
	w.sendFullView(p)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	w.sendInventory(p)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerSkills{PlayerSkills: &pb.PlayerSkills{Skills: w.skillList(p)}}})
	w.sendCosmetics(p) // T5.7
	// The quest log (questlog.go), empty too, goes at the flush of this tick: one QuestLog
	// even when checkReach below completes a step.
	p.questLogDirty = true
	w.tellDiedAway(p) // after its state: the death screen of a death while link-dead
	w.appearToObservers(p)
	w.startLedger(ctx.Tick, p)
	w.antibotJoin(ctx.Tick, p)
	p.joinedAt = ctx.Tick
	// After the ledger: resuming may end the tutorial and give its reward (T4.2).
	w.tutorialJoin(p)
	// Standing in the place of a reach step counts at login too (after the ledger: it may
	// give the quest's rewards).
	p.reachStale = true
	w.checkReach(p)
	w.sigilStep(p) // logging in on a plate is stepping on it
	w.guildJoin(p) // T5.1: its GuildUpdate, and the others see it online
	if w.houseOn {
		w.houseSeen(ctx.Now, p, true) // content audit M6: the account is not away
	}

	// Staggered autosave: first at a random point of the first interval.
	first := 1 + game.Tick(ctx.Rand.Uint64N(uint64(w.cfg.AutosaveEvery)))
	w.scheduleAutosave(ctx, p, first)
	w.scheduleRegen(ctx, p)
	if rolled {
		w.save(w.snapshot(p, false))
	}
	if stashRolled && !w.readOnly {
		// Like the inventory above: the stash is written at once with the attributes its
		// login rolled, so leaving and coming back never rolls them again. A read-only
		// World writes nothing: the next login rolls them again, which nobody can tell,
		// since a read-only World opens no stash window (useStash) to see them.
		w.stashWrite(p, w.stashes[p.accountID])
	}
}

// state returns c with the in-memory state of the online player p.
func (w *World) state(p *Player, c Character) Character {
	c.Level, c.Experience, c.Health, c.Mana = p.level, p.experience, p.health, p.mana
	c.Skills = p.skillStates(w.skillIDs)
	c.Inventory, c.InventoryLoaded = p.inventoryStates(), true
	c.Storage = p.storage.Values()
	c.Conditions = w.conditionStates(p)
	c.PvP = w.pvpState(p)
	c.Pos, c.HasPos = p.pos, true
	c.Cosmetics = p.cos
	c.Look = p.look
	if p.premSeq > c.PremiumSeq { // the online player heard of a newer shop change
		c.Owned, c.Premium, c.PremiumSeq = p.owned, p.premium, p.premSeq
	}
	return c
}

func (w *World) scheduleAutosave(ctx *game.TickContext, p *Player, delay game.Tick) {
	p.autosave = ctx.Sched.After(delay, func(ctx *game.TickContext) {
		if w.byChar[p.charID] != p {
			return
		}
		w.save(w.snapshot(p, false))
		w.scheduleAutosave(ctx, p, w.cfg.AutosaveEvery)
	})
}

// remove takes p out of the world, saves it and schedules its connection to close at
// flush with reason. A slow client (whose queue is full) gets no more batches.
func (w *World) remove(ctx *game.TickContext, p *Player, reason pb.DisconnectReason, slow bool) {
	if w.byClient[p.client] != p {
		return
	}
	w.reconcile(ctx.Tick, p) // a duplication right before leaving is caught too (T4.1)
	// T5.4: a house p changed this tick is written with p's snapshot while p is still
	// online, before its final save.
	w.flushHouses()
	w.disappearFromObservers(p, goneLogout)
	w.partyLeftWorld(p)               // T3.3: leaving the world leaves the party
	w.guildLeftWorld(p)               // T5.1: the guild sees it offline
	w.cancelTrade(p, tradeCancelLeft) // T5.3
	w.dropMarket(p)
	w.closeStash(p, false)
	p.house = nil
	if w.houseOn {
		w.houseSeen(ctx.Now, p, false) // M6: away counts from the last time it left
	}
	w.unindex(p)
	delete(w.byClient, p.client)
	if w.byChar[p.charID] == p {
		delete(w.byChar, p.charID)
	}
	if n := w.byAccount[p.accountID]; n > 1 {
		w.byAccount[p.accountID] = n - 1
	} else {
		delete(w.byAccount, p.accountID)
	}
	i := sort.Search(len(w.players), func(i int) bool { return w.players[i].id >= p.id })
	w.players = append(w.players[:i], w.players[i+1:]...)
	w.published.Store(int32(len(w.players)))
	ctx.Sched.Cancel(p.autosave)
	ctx.Sched.Cancel(p.regen)
	w.forgetContainers(p)
	w.forgetLinkDead(p)
	w.pvpLeftWorld(p)
	for _, m := range w.monsters {
		if m.target == p {
			m.setTarget(nil) // do not keep the gone player alive from a sleeping monster
		}
	}

	s := w.snapshot(p, true)
	w.clearConditions(ctx, holder{p: p}, true)
	w.unsaved[p.charID] = s
	w.save(s)
	w.releaseStash(p.accountID) // stash.go: kept until its last write is acked
	if p.dropped {
		p.out = nil // T5.2: its connection was closed when it went link-dead (disconnect)
		return
	}
	if slow {
		p.out = nil
	}
	w.flushPlayer(ctx.Tick, p) // its last batch, then the Disconnect
	p.client.Close(reason)
}

// save submits s to persistence, keeping it for a retry if the queue is full.
func (w *World) save(s Snapshot) { w.submitJob(Job{Snapshot: s}) }

// submitJob submits j to persistence in order: while older jobs wait for a retry, j
// waits behind them (a snapshot must never overtake the transfer before it, T5.3).
func (w *World) submitJob(j Job) {
	if len(w.retry) > 0 || !w.submitNow(j) {
		w.retry = append(w.retry, j)
	}
}

func (w *World) submitNow(j Job) bool {
	if j.Transfer != nil {
		return w.cfg.Transfer != nil && w.cfg.Transfer(*j.Transfer)
	}
	return w.cfg.Save(j.Snapshot)
}

func (w *World) retrySaves() {
	n := 0
	for n < len(w.retry) && w.submitNow(w.retry[n]) {
		n++
	}
	w.retry = append(w.retry[:0], w.retry[n:]...)
}

// SaveAll takes a final snapshot of every online player, for shutdown, and returns the
// jobs that Config.Save or Config.Transfer could not queue, in order (the caller writes
// them synchronously). Call it only after the loop stopped.
func (w *World) SaveAll() []Job {
	w.flushHouses()
	w.retrySaves()
	pending := append([]Job(nil), w.retry...)
	w.retry = w.retry[:0]
	for _, p := range w.players {
		j := Job{Snapshot: w.snapshot(p, true)}
		if len(pending) > 0 || !w.submitNow(j) {
			pending = append(pending, j)
		}
	}
	return pending
}

// ClientPlayer returns client's player, or nil. Loop goroutine only.
func (w *World) ClientPlayer(c Client) *Player { return w.byClient[c] }

// Clients returns the connection of every online player (for shutdown).
func (w *World) Clients() []Client {
	out := make([]Client, len(w.players))
	for i, p := range w.players {
		out[i] = p.client
	}
	return out
}

// placement chooses where a joining character appears: its saved position, or its
// temple, moved to the nearest free walkable tile where a player there could walk
// (freeNear). The saved position counts whenever a search from it finds somewhere a
// player there walks (searchFrom), even on a tile nobody may stand on now: a door shut
// since the logout (in its open doorway) puts the player beside it, on its outside if the
// door is locked, on either side if it is not; a house door, in its house or on the
// street of its exit. Only a tile of no area with no rule of its own (a wall, no tile:
// the map changed) sends the character to its temple.
func (w *World) placement(c Character) world.Pos {
	temple := w.temple(c.Town)
	want := temple
	if c.HasPos && w.searchFrom(c.Pos).n > 0 {
		want = c.Pos
	}
	if p, ok := w.freeNear(want, 3); ok {
		return p
	}
	if p, ok := w.freeNear(temple, 3); ok {
		return p
	}
	if w.tileArea(want) == 0 || !w.m.Walkable(want) {
		// A position saved on stairs (before the server loaded portals, or by a GM), on a
		// locked door or on a closed door: the temple rather than a tile nobody stands on.
		return temple
	}
	return want // crowded: share the tile rather than refuse the login
}

// lockedDoor reports whether a locked door stands on p (door.go), open or closed.
func (w *World) lockedDoor(p world.Pos) bool {
	d := w.doors[p]
	return d != nil && d.lock != ""
}

func (w *World) temple(town string) world.Pos {
	if is := w.m.Island(w.homeIsland(town)); is != nil {
		return is.Temple
	}
	return world.Pos{}
}

// homeIsland is the island a character of town lives on: town if it is an island of the
// map, else the start town, else the first island (a new character has no town yet).
func (w *World) homeIsland(town string) string {
	if w.m.Island(town) != nil {
		return town
	}
	if w.m.Island(w.cfg.StartTown) != nil {
		return w.cfg.StartTown
	}
	if islands := w.m.Islands(); len(islands) > 0 {
		return islands[0].ID
	}
	return ""
}

// freeNear returns the walkable, unoccupied tile closest to p (by rings) within radius,
// only where a player on p could walk (searchFrom, areaAllows, area.go): the rings do not
// follow walls, so a crowded tile next to a locked gate must not put anyone on its other
// side (in the room behind it), nor a crowded temple anyone in a pocket sealed by walls.
// From the area of p, only in it; from a house tile, in its house area or the street of
// its exit; from the entrance of stairs, a hole or a teleport, in the areas next to it;
// from a locked door, on its outside; from anything else, nowhere. Never one that stairs,
// a hole or a teleport leaves from (portal.go): nobody stands on those.
func (w *World) freeNear(p world.Pos, radius int) (world.Pos, bool) {
	return w.freeAround(p, radius, false)
}

// freeAround is freeNear, also without house tiles if noHouse. noHouse is a second guard
// that none of today's callers needs: each starts on no house tile (a portal end, a boat
// arrival, a dialog teleport or a house exit: world.NewMap, checkArrivals), so on a tile
// of a street area or on the entrance of stairs, a hole or a teleport (a boat arrival or
// a dialog teleport may lie on one), and a search from either looks only at street areas
// (searchFrom: a house area is negative, and the areas next to an entrance are clipped to
// street ones by areaOf). It keeps a caller that starts elsewhere out of every house.
func (w *World) freeAround(p world.Pos, radius int, noHouse bool) (world.Pos, bool) {
	skip := world.FlagBlocksMovement | world.FlagPortalStep
	if noHouse {
		skip |= world.FlagHouse
	}
	return w.searchRings(p, radius, skip, w.free)
}

// free reports whether no creature stands on q (freeAround's test).
func (w *World) free(q world.Pos) bool { return !w.occupied(q) }

// searchRings returns the tile closest to p (by rings) within radius whose flags have
// none of skip, that ok accepts, and that lies in the area of p (searchFrom, areaAllows:
// every search by rings goes through them, see freeNear).
func (w *World) searchRings(p world.Pos, radius int, skip world.Flags, ok func(world.Pos) bool) (world.Pos, bool) {
	return w.searchRingsIn(w.searchFrom(p), p, radius, skip, ok)
}

// searchRingsIn is searchRings with the areas it may land in given (from).
func (w *World) searchRingsIn(from searchFrom, p world.Pos, radius int, skip world.Flags, ok func(world.Pos) bool) (world.Pos, bool) {
	for r := 0; r <= radius; r++ {
		for dy := -r; dy <= r; dy++ {
			for dx := -r; dx <= r; dx++ {
				if max(abs(dx), abs(dy)) != r {
					continue
				}
				x, y := int(p.X)+dx, int(p.Y)+dy
				if x < 0 || y < 0 || x > 0xFFFF || y > 0xFFFF {
					continue
				}
				q := world.Pos{X: uint16(x), Y: uint16(y), Z: p.Z}
				// One read of the tile's flags (freeAround: walkable, no stairs, hole or
				// teleport, MovesOnStep, and if noHouse no house tile).
				if w.m.Flags(q)&skip == 0 && ok(q) && w.areaAllows(from, q) {
					return q, true
				}
			}
		}
	}
	return world.Pos{}, false
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// ---- messages about the player -------------------------------------------------

func (w *World) stats(p *Player) *pb.PlayerStats {
	return &pb.PlayerStats{
		Health:       uint32(p.health),
		MaxHealth:    uint32(p.maxHealth),
		Mana:         uint32(p.mana),
		MaxMana:      uint32(p.maxMana),
		Level:        uint32(p.level),
		Experience:   uint64(max(p.experience, 0)),
		LevelPercent: uint32(w.cfg.Balance.Experience.LevelPercent(p.level, p.experience)),
		Capacity:     uint32(max(p.capacity-p.carried(), 0)), // free capacity, grams
		MaxCapacity:  uint32(max(p.capacity, 0)),
		Speed:        uint32(p.speed),
	}
}

func (w *World) creatureMsg(p *Player) *pb.Creature {
	return &pb.Creature{
		Id:            p.id,
		Kind:          pb.CreatureKind_CREATURE_KIND_PLAYER,
		Name:          p.name,
		Pos:           posMsg(p.pos),
		Dir:           dirMsg(p.dir),
		HealthPercent: uint32(p.health * 100 / max(p.maxHealth, 1)),
		Speed:         uint32(p.speed),
		Guild:         guildName(p),
		Skull:         p.skull,
		Cosmetics:     cosmeticsMsg(p.cos),
		Look:          p.lookMsg,
		Equipment:     p.equipMsg,
	}
}

func posMsg(p world.Pos) *pb.Position {
	return &pb.Position{X: uint32(p.X), Y: uint32(p.Y), Z: uint32(p.Z)}
}

// dirMsg converts a world direction (0 = north) to the protocol's (1 = north).
func dirMsg(d world.Direction) pb.Direction { return pb.Direction(d&7) + 1 }

// dirFromMsg converts a protocol direction; ok is false for UNSPECIFIED or unknown values.
func dirFromMsg(d pb.Direction) (world.Direction, bool) {
	if d < pb.Direction_DIRECTION_NORTH || d > pb.Direction_DIRECTION_NORTH_WEST {
		return 0, false
	}
	return world.Direction(d - 1), true
}
