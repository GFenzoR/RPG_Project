package session

import (
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

	// known is the sorted list of creature ids the client knows (has been sent).
	known []uint32
	out   []*pb.ServerMessage

	autosave game.EventID
	saveSeq  uint64

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
	// container windows (oldest first), the last window id and the first tick a
	// consumable can be used again.
	equip         [equipSlots]*Item
	armor         int
	open          []openContainer
	nextContainer uint32
	nextUse       game.Tick

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

	// Gathering (T1.12): the first tick p can gather again, the tile p has been
	// gathering from since gatherSince (anti-AFK, 0 = not gathering yet) and its last
	// counted attempt.
	nextGather  game.Tick
	gatherPos   world.Pos
	gatherSince game.Tick
	gatherLast  game.Tick

	// Conditions (T3.2): the active ones (few: at most one per condition id), whether
	// the client's list is stale, and whether p is hidden by invisibility.
	conds           []*condition
	conditionsDirty bool
	invisible       bool

	// Parties (T3.3): the party, what p's client last heard of it, the first tick of its
	// next periodic update, and the last tick p helped a fight (0 = never).
	party         *party
	partyView     []partyView
	partyState    pb.SharedExperience
	partyNext     game.Tick
	contributedAt game.Tick

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
	// linkDead: its connection closed during the lock; it stays until the lock ends.
	linkDead bool

	// Travel (T3.5): the last tick p fought (attacked, hurt or hitting a monster; 0 =
	// never), which blocks sailing for balance travel.combat_block_ms.
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
	p.qhead = 0
	p.hasDest = false
}

func (w *World) snapshot(p *Player, final bool) Snapshot {
	p.saveSeq++
	return Snapshot{
		CharacterID: p.charID,
		Seq:         p.saveSeq,
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
		Final:       final,
	}
}

// ---- join and leave -----------------------------------------------------------

// Join returns the command that puts a loaded character in the world for client. If the
// character is already online, the old connection is closed (LOGGED_IN_ELSEWHERE) and
// the new one takes over its in-memory state.
func (w *World) Join(c Character, client Client) game.Command {
	return game.CommandFunc(func(ctx *game.TickContext) { w.join(ctx, c, client) })
}

// Leave returns the command that removes client's player (connection closed). It is
// idempotent: a client that already left is ignored.
func (w *World) Leave(client Client) game.Command {
	return game.CommandFunc(func(ctx *game.TickContext) {
		if p := w.byClient[client]; p != nil && !w.linkDeadOnLeave(ctx.Tick, p) {
			w.remove(ctx, p, pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED, false)
		}
	})
}

// Saved returns the command the persistence goroutine enqueues after writing a
// snapshot: the final snapshot of a character is forgotten once it is in the database,
// unless a login of that character is reading the database right now.
func (w *World) Saved(characterID int64, seq uint64) game.Command {
	return game.CommandFunc(func(*game.TickContext) {
		if s, ok := w.unsaved[characterID]; ok && s.Seq == seq && w.loading[characterID] == 0 {
			delete(w.unsaved, characterID)
		}
	})
}

// LoginStarted returns the command the gateway enqueues before it reads a character
// from the database. It must be followed by Join or LoginAborted for the same
// character. Because the queue is FIFO, an ack of a save that the read may have missed
// runs after it and keeps the unsaved snapshot for the Join.
func (w *World) LoginStarted(characterID int64) game.Command {
	return game.CommandFunc(func(*game.TickContext) { w.loading[characterID]++ })
}

// LoginAborted returns the command that ends a LoginStarted whose Join never comes.
func (w *World) LoginAborted(characterID int64) game.Command {
	return game.CommandFunc(func(*game.TickContext) { w.loginDone(characterID) })
}

func (w *World) loginDone(characterID int64) {
	if w.loading[characterID] <= 1 {
		delete(w.loading, characterID)
	} else {
		w.loading[characterID]--
	}
}

func (w *World) join(ctx *game.TickContext, c Character, client Client) {
	w.sched = ctx.Sched
	w.loginDone(c.ID)
	if old := w.byClient[client]; old != nil {
		return // one character per connection
	}
	if w.isBanned(c.AccountID, ctx.Now) {
		// Banned while this login was reading the database (the row it read had no ban).
		client.Close(pb.DisconnectReason_DISCONNECT_REASON_BANNED)
		return
	}
	voc, ok := w.cfg.Vocations[c.Vocation]
	if !ok {
		w.log.Error("session: unknown vocation, login refused", "character", c.ID, "vocation", c.Vocation)
		client.Close(pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED)
		return
	}
	var seq uint64
	var carry *Player // T5.2: the player this login replaces, for its PvP locks
	if old := w.byChar[c.ID]; old != nil {
		carry = old
		// Logged in again while online: continue from the in-memory state.
		c = w.state(old, c)
		w.remove(ctx, old, pb.DisconnectReason_DISCONNECT_REASON_LOGGED_IN_ELSEWHERE, false)
		seq = old.saveSeq       // after remove's final snapshot: later seqs must be greater
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
		seq = s.Seq
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
		saveSeq:    seq,
		stance:     pb.FightStance_FIGHT_STANCE_BALANCED,
		safe:       true, // T5.2: until the client says otherwise
	}
	p.health = min(max(c.Health, 0), p.maxHealth)
	if p.health == 0 {
		p.health = p.maxHealth // never spawn a dead character (death respawns with full health)
	}
	p.mana = min(max(c.Mana, 0), p.maxMana)
	p.pos = w.placement(c)
	w.loadSkills(p, c.Skills)
	w.loadInventory(p, c.Inventory, !c.HasPos && !c.InventoryLoaded)
	p.storage = quest.NewLog(c.Storage)
	w.loadPvP(ctx, p, c.PvP) // before anyone is told about p (Creature.skull)
	if carry != nil {
		w.pvpCarry(carry, p) // a link-dead character taken over keeps its lock
	}
	if w.guildOn {
		p.gm = w.guildMembers[p.charID] // before anyone is told about p (Creature.guild)
	}

	w.players = append(w.players, p) // ids grow, so the slice stays ordered
	w.published.Store(int32(len(w.players)))
	w.byClient[client] = p
	w.byChar[c.ID] = p
	w.index(p)

	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{
		CreatureId: p.id,
		ServerTime: uint64(max(ctx.Now.UnixMilli(), 0)),
		TickMs:     uint32(game.TickDuration.Milliseconds()),
	}}})
	// Saved conditions first (T3.2): the first stats, and what observers get, already
	// carry their speed (and an invisible player is never shown).
	w.loadConditions(ctx, p, c.Conditions)
	w.sendFullView(p)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	w.sendInventory(p)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerSkills{PlayerSkills: &pb.PlayerSkills{Skills: w.skillList(p)}}})
	w.appearToObservers(p)
	w.startLedger(ctx.Tick, p)
	w.antibotJoin(ctx.Tick, p)
	p.joinedAt = ctx.Tick
	// After the ledger: resuming may end the tutorial and give its reward (T4.2).
	w.tutorialJoin(p)
	w.guildJoin(p) // T5.1: its GuildUpdate, and the others see it online

	// Staggered autosave: first at a random point of the first interval.
	first := 1 + game.Tick(ctx.Rand.Uint64N(uint64(w.cfg.AutosaveEvery)))
	w.scheduleAutosave(ctx, p, first)
	w.scheduleRegen(ctx, p)
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
	w.disappearFromObservers(p)
	w.partyLeftWorld(p) // T3.3: leaving the world leaves the party
	w.guildLeftWorld(p) // T5.1: the guild sees it offline
	w.unindex(p)
	delete(w.byClient, p.client)
	if w.byChar[p.charID] == p {
		delete(w.byChar, p.charID)
	}
	i := sort.Search(len(w.players), func(i int) bool { return w.players[i].id >= p.id })
	w.players = append(w.players[:i], w.players[i+1:]...)
	w.published.Store(int32(len(w.players)))
	ctx.Sched.Cancel(p.autosave)
	ctx.Sched.Cancel(p.regen)
	w.forgetContainers(p)
	w.pvpLeftWorld(p)
	for _, m := range w.monsters {
		if m.target == p {
			m.target = nil // do not keep the gone player alive from a sleeping monster
		}
	}

	s := w.snapshot(p, true)
	w.clearConditions(ctx, holder{p: p}, true)
	w.unsaved[p.charID] = s
	w.save(s)
	if slow {
		p.out = nil
	}
	w.flushPlayer(ctx.Tick, p) // its last batch, then the Disconnect
	p.client.Close(reason)
}

// save submits s to persistence, keeping it for a retry if the queue is full.
func (w *World) save(s Snapshot) {
	if len(w.retry) > 0 || !w.cfg.Save(s) {
		w.retry = append(w.retry, s)
	}
}

func (w *World) retrySaves() {
	n := 0
	for n < len(w.retry) && w.cfg.Save(w.retry[n]) {
		n++
	}
	w.retry = append(w.retry[:0], w.retry[n:]...)
}

// SaveAll takes a final snapshot of every online player, for shutdown, and returns the
// snapshots that Config.Save could not queue (the caller writes them synchronously).
// Call it only after the loop stopped.
func (w *World) SaveAll() []Snapshot {
	w.retrySaves()
	pending := append([]Snapshot(nil), w.retry...)
	w.retry = w.retry[:0]
	for _, p := range w.players {
		s := w.snapshot(p, true)
		if len(pending) > 0 || !w.cfg.Save(s) {
			pending = append(pending, s)
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
// temple, moved to the nearest free walkable tile.
func (w *World) placement(c Character) world.Pos {
	temple := w.temple(c.Town)
	want := temple
	if c.HasPos && w.m.Walkable(c.Pos) {
		want = c.Pos
	}
	if p, ok := w.freeNear(want, 3); ok {
		return p
	}
	if p, ok := w.freeNear(temple, 3); ok {
		return p
	}
	return want // crowded: share the tile rather than refuse the login
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

// freeNear returns the walkable, unoccupied tile closest to p (by rings) within radius.
func (w *World) freeNear(p world.Pos, radius int) (world.Pos, bool) {
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
				if w.m.Walkable(q) && !w.occupied(q) {
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
