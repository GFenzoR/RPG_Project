// Package session is the game-side half of a connected player: the creatures in the
// world, walking, the area of interest (AOI) and the events each player receives
// (docs/01-architecture.md, docs/05-network-protocol.md).
//
// Everything in World runs on the game loop goroutine: network goroutines only build the
// commands returned by World.Join, World.Input and World.Leave and enqueue them, and they
// receive finished *pb.ServerBatch values through Client.Send. Snapshots for the
// database leave the loop as copies through Config.Save.
package session

import (
	"errors"
	"fmt"
	"log/slog"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Client is the network side of a player as the loop sees it. Implementations must
// never block: the loop calls them while a tick runs.
type Client interface {
	// Send hands a finished batch to the connection. It returns false when the
	// connection's outgoing queue is full (slow client): the loop then drops the player
	// and calls Close(DISCONNECT_REASON_SLOW_CLIENT).
	Send(b *pb.ServerBatch) bool
	// Close ends the connection after the batches already sent, followed by a
	// Disconnect with reason (none if reason is UNSPECIFIED). It is called at most once
	// per player, after the player left the world.
	Close(reason pb.DisconnectReason)
}

// Character is a character as loaded from the database for a login.
type Character struct {
	ID         int64
	AccountID  int64
	Name       string
	Vocation   string
	Level      int
	Experience int64
	Health     int
	Mana       int
	// Skills holds the saved skills; the ones missing start at their base level.
	Skills []SkillState
	// Inventory holds the equipped items with their content. InventoryLoaded marks an
	// inventory taken from memory (a quick re-login), which may be empty on purpose.
	Inventory       []ItemState
	InventoryLoaded bool
	// HasPos is false for a character that never played: it starts at the temple.
	HasPos bool
	Pos    world.Pos
	Town   string
}

// Snapshot is an immutable copy of the persisted state of a character, built on the
// loop and written to the database by the persistence goroutine.
type Snapshot struct {
	CharacterID int64
	// Seq grows with every snapshot of the same login; World.Saved acknowledges one.
	Seq        uint64
	Level      int
	Experience int64
	Health     int
	Mana       int
	Pos        world.Pos
	// Skills is every skill of the character (World skill order).
	Skills []SkillState
	// Inventory is every equipped item with its content (a deep copy).
	Inventory []ItemState
	// Final marks the snapshot taken when the player left the world.
	Final bool
}

// Defaults for Config.
const (
	// DefaultAutosaveEvery is the autosave interval of an online player (5 minutes).
	DefaultAutosaveEvery = game.Tick(5 * 60 * 1000 / 50)
	// DefaultRerouteMaxNodes bounds one reroute search (A* around creatures).
	DefaultRerouteMaxNodes = 1500
	// DefaultPathNodesPerTick is the pathfinding quota of one tick, in expanded tiles.
	// A search starts only if a worst-case search still fits, so a tick never expands
	// more than this (≈ 3 ms in world.BenchmarkFindPathUnreachable terms).
	DefaultPathNodesPerTick = 12000
)

// Config configures a World.
type Config struct {
	// Map is the loaded world. Required.
	Map *world.Map
	// Balance and Vocations come from data/. Balance.Movement is required.
	Balance   content.Balance
	Vocations content.Vocations
	// Monsters and Items come from data/. With Monsters set, the World keeps the map's
	// spawns (world.Island.Spawns) populated; Items must then hold every loot item and
	// CorpseItem. Without Monsters the world has no monsters (tests, tools).
	Monsters content.Monsters
	Items    content.Items
	// Spells come from data/spells.yaml (T1.9). Every rune item must name one of them
	// and every conjured item must exist in Items.
	Spells content.Spells
	// Save submits a snapshot to the persistence goroutine without blocking. It returns
	// false if its queue is full; the World retries on the next ticks. Required.
	Save func(Snapshot) bool
	// AutosaveEvery is the autosave interval (default DefaultAutosaveEvery). The first
	// autosave of a player is at a random point of the first interval, so players that
	// joined together (after a restart) do not all save on the same tick.
	AutosaveEvery game.Tick
	// RerouteMaxNodes and PathNodesPerTick tune the pathfinding quota.
	RerouteMaxNodes  int
	PathNodesPerTick int
	Logger           *slog.Logger
}

// World is the state of every player in the game. It is owned by the game loop
// goroutine; only the commands and systems it returns may touch it.
type World struct {
	cfg  Config
	m    *world.Map
	mv   content.Movement
	diag int64 // diagonal_cost in thousandths
	log  *slog.Logger

	nextID   uint32
	players  []*Player // ordered by creature id: deterministic iteration
	byClient map[Client]*Player
	byChar   map[int64]*Player
	sectors  map[uint64][]*Player

	// unsaved holds the final snapshot of characters that left until the database
	// acknowledges it: a quick re-login must not load an older row.
	unsaved map[int64]Snapshot
	// loading counts logins whose database read is in flight (LoginStarted, not yet
	// Join or LoginAborted). While a character has one, Saved keeps its unsaved
	// snapshot: the read may have seen the row from before that save.
	loading map[int64]int
	// retry holds snapshots that Config.Save could not queue yet.
	retry []Snapshot
	// slow collects players whose Send failed during flush.
	slow []*Player

	pf         *world.Pathfinder
	pathBudget int
	pathTick   game.Tick
	pathBuf    []world.Direction

	// Progress (T1.7): skill ids in balance.yaml order (sorted), their index, and the
	// anti-AFK delay in ticks (0 = off).
	skillIDs []string
	skillIdx map[string]int
	afkAfter game.Tick

	// Monsters (T1.6), owned by the loop like everything else.
	monsters   []*Monster // ordered by creature id: deterministic iteration
	monByID    map[uint32]*Monster
	msectors   map[uint64][]*Monster
	kinds      map[string]*monsterKind
	slots      []*spawnSlot
	spawned    bool
	active     map[uint64]struct{}
	activeKeys []uint64
	thinkBuf   []*Monster
	ground     map[world.Pos][]*Item // items on tiles at runtime, above world.bin's
	corpses    map[world.Pos][]*Corpse
	corpseItem *content.Item
	corpseFor  game.Tick
	attackFor  game.Tick

	// Items (T1.8): definitions by numeric id, the container of new characters and the
	// inventory rules of balance.yaml.
	byNum          map[uint16]*content.Item
	startContainer *content.Item
	useFor         game.Tick
	reach          int
	maxOpen        int

	// Magic (T1.9): spells by normalized words, and the index of the magic skill.
	spellWords map[string]*content.Spell
	magicIdx   int
}

// New validates cfg and builds an empty World.
func New(cfg Config) (*World, error) {
	if cfg.Map == nil {
		return nil, errors.New("session: Config.Map is required")
	}
	if cfg.Save == nil {
		return nil, errors.New("session: Config.Save is required")
	}
	mv := cfg.Balance.Movement
	if mv.BaseStepMs <= 0 || mv.DiagonalCost < 1 || mv.MaxPathTiles <= 0 || mv.MaxPathTiles > world.MaxPathLength {
		return nil, fmt.Errorf("session: invalid movement balance %+v", mv)
	}
	if len(cfg.Vocations) == 0 {
		return nil, errors.New("session: no vocations")
	}
	if cfg.AutosaveEvery <= 0 {
		cfg.AutosaveEvery = DefaultAutosaveEvery
	}
	if cfg.RerouteMaxNodes <= 0 {
		cfg.RerouteMaxNodes = DefaultRerouteMaxNodes
	}
	if cfg.PathNodesPerTick <= 0 {
		cfg.PathNodesPerTick = DefaultPathNodesPerTick
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	w := &World{
		cfg:      cfg,
		m:        cfg.Map,
		mv:       mv,
		diag:     int64(mv.DiagonalCost*1000 + 0.5),
		log:      cfg.Logger,
		byClient: map[Client]*Player{},
		byChar:   map[int64]*Player{},
		sectors:  map[uint64][]*Player{},
		unsaved:  map[int64]Snapshot{},
		loading:  map[int64]int{},
		pf:       world.NewPathfinder(cfg.Map, cfg.RerouteMaxNodes),
	}
	if err := w.initCombat(); err != nil {
		return nil, err
	}
	w.initProgress()
	if err := w.initItems(); err != nil {
		return nil, err
	}
	if err := w.initMagic(); err != nil {
		return nil, err
	}
	return w, nil
}

// Online returns how many players are in the world.
func (w *World) Online() int { return len(w.players) }

// Players returns the online players ordered by creature id. Loop goroutine only.
func (w *World) Players() []*Player { return w.players }

// PlayerByCharacter returns the online player of a character, or nil.
func (w *World) PlayerByCharacter(id int64) *Player { return w.byChar[id] }

// Systems returns the per-tick systems of the World, in order: walking, combat (player
// attacks, monster AI in active sectors, spawns) and the flush that sends each player
// its batch.
func (w *World) Systems() (movement, combat, flush game.System) {
	return game.SystemFunc(w.moveSystem), game.SystemFunc(w.combatSystem), game.SystemFunc(w.flushSystem)
}
