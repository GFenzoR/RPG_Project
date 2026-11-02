package session

import (
	"sort"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Player is a player character in the world. Loop goroutine only.
type Player struct {
	id        uint32
	charID    int64
	accountID int64
	name      string
	vocation  content.Vocation
	client    Client

	level      int
	experience int64
	health     int
	maxHealth  int
	mana       int
	maxMana    int
	capacity   int
	speed      int

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
}

// Health returns the player's current and maximum health.
func (p *Player) Health() (cur, maxHealth int) { return p.health, p.maxHealth }

// Experience returns the player's total experience.
func (p *Player) Experience() int64 { return p.experience }

// Target returns the creature id the player attacks, or 0.
func (p *Player) Target() uint32 {
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

func (p *Player) snapshot(final bool) Snapshot {
	p.saveSeq++
	return Snapshot{
		CharacterID: p.charID,
		Seq:         p.saveSeq,
		Level:       p.level,
		Experience:  p.experience,
		Health:      p.health,
		Mana:        p.mana,
		Pos:         p.pos,
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
		if p := w.byClient[client]; p != nil {
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
	w.loginDone(c.ID)
	if old := w.byClient[client]; old != nil {
		return // one character per connection
	}
	voc, ok := w.cfg.Vocations[c.Vocation]
	if !ok {
		w.log.Error("session: unknown vocation, login refused", "character", c.ID, "vocation", c.Vocation)
		client.Close(pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED)
		return
	}
	var seq uint64
	if old := w.byChar[c.ID]; old != nil {
		// Logged in again while online: continue from the in-memory state.
		c = old.state(c)
		w.remove(ctx, old, pb.DisconnectReason_DISCONNECT_REASON_LOGGED_IN_ELSEWHERE, false)
		seq = old.saveSeq       // after remove's final snapshot: later seqs must be greater
		delete(w.unsaved, c.ID) // the new player carries the state; it saves it later
	} else if s, ok := w.unsaved[c.ID]; ok {
		// Left recently and the database may not have the final save yet.
		c.Level, c.Experience, c.Health, c.Mana = s.Level, s.Experience, s.Health, s.Mana
		c.Pos, c.HasPos = s.Pos, true
		seq = s.Seq
	}

	stats := voc.AtLevel(c.Level)
	w.nextID++
	p := &Player{
		id:         w.nextID,
		charID:     c.ID,
		accountID:  c.AccountID,
		name:       c.Name,
		vocation:   voc,
		client:     client,
		level:      max(c.Level, 1),
		experience: c.Experience,
		maxHealth:  stats.Health,
		maxMana:    stats.Mana,
		capacity:   stats.Capacity,
		speed:      max(stats.Speed, 1),
		dir:        world.South,
		saveSeq:    seq,
		stance:     pb.FightStance_FIGHT_STANCE_BALANCED,
	}
	p.health = min(max(c.Health, 0), p.maxHealth)
	if p.health == 0 {
		p.health = p.maxHealth // death arrives in T1.11; never spawn a dead character
	}
	p.mana = min(max(c.Mana, 0), p.maxMana)
	p.pos = w.placement(c)

	w.players = append(w.players, p) // ids grow, so the slice stays ordered
	w.byClient[client] = p
	w.byChar[c.ID] = p
	w.index(p)

	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{
		CreatureId: p.id,
		ServerTime: uint64(max(ctx.Now.UnixMilli(), 0)),
		TickMs:     uint32(game.TickDuration.Milliseconds()),
	}}})
	w.sendFullView(p)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_Inventory{Inventory: &pb.Inventory{}}})
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerSkills{PlayerSkills: &pb.PlayerSkills{Skills: w.skillList()}}})
	w.appearToObservers(p)

	// Staggered autosave: first at a random point of the first interval.
	first := 1 + game.Tick(ctx.Rand.Uint64N(uint64(w.cfg.AutosaveEvery)))
	w.scheduleAutosave(ctx, p, first)
}

// state returns c with the in-memory state of the online player p.
func (p *Player) state(c Character) Character {
	c.Level, c.Experience, c.Health, c.Mana = p.level, p.experience, p.health, p.mana
	c.Pos, c.HasPos = p.pos, true
	return c
}

func (w *World) scheduleAutosave(ctx *game.TickContext, p *Player, delay game.Tick) {
	p.autosave = ctx.Sched.After(delay, func(ctx *game.TickContext) {
		if w.byChar[p.charID] != p {
			return
		}
		w.save(p.snapshot(false))
		w.scheduleAutosave(ctx, p, w.cfg.AutosaveEvery)
	})
}

// remove takes p out of the world, saves it and schedules its connection to close at
// flush with reason. A slow client (whose queue is full) gets no more batches.
func (w *World) remove(ctx *game.TickContext, p *Player, reason pb.DisconnectReason, slow bool) {
	if w.byClient[p.client] != p {
		return
	}
	w.disappearFromObservers(p)
	w.unindex(p)
	delete(w.byClient, p.client)
	if w.byChar[p.charID] == p {
		delete(w.byChar, p.charID)
	}
	i := sort.Search(len(w.players), func(i int) bool { return w.players[i].id >= p.id })
	w.players = append(w.players[:i], w.players[i+1:]...)
	ctx.Sched.Cancel(p.autosave)
	for _, m := range w.monsters {
		if m.target == p {
			m.target = nil // do not keep the gone player alive from a sleeping monster
		}
	}

	s := p.snapshot(true)
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
		s := p.snapshot(true)
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
	if is := w.m.Island(town); is != nil {
		return is.Temple
	}
	if islands := w.m.Islands(); len(islands) > 0 {
		return islands[0].Temple
	}
	return world.Pos{}
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
		Capacity:     uint32(max(p.capacity, 0)), // items arrive in T1.8: all capacity is free
		MaxCapacity:  uint32(max(p.capacity, 0)),
		Speed:        uint32(p.speed),
	}
}

// skillList returns fresh copies of the base skills (T1.7 brings real progress).
func (w *World) skillList() []*pb.SkillProgress {
	out := make([]*pb.SkillProgress, len(w.skills))
	for i, s := range w.skills {
		out[i] = &pb.SkillProgress{SkillId: s.SkillId, Level: s.Level}
	}
	return out
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
