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
	// retry holds snapshots that Config.Save could not queue yet.
	retry []Snapshot
	// slow collects players whose Send failed during flush.
	slow []*Player

	pf         *world.Pathfinder
	pathBudget int
	pathTick   game.Tick
	pathBuf    []world.Direction

	skills []*pb.SkillProgress
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
		pf:       world.NewPathfinder(cfg.Map, cfg.RerouteMaxNodes),
	}
	for _, id := range cfg.Balance.SkillIDs() {
		w.skills = append(w.skills, &pb.SkillProgress{SkillId: id, Level: uint32(max(cfg.Balance.Skills.Base[id].StartLevel, 0))})
	}
	return w, nil
}

// Online returns how many players are in the world.
func (w *World) Online() int { return len(w.players) }

// Players returns the online players ordered by creature id. Loop goroutine only.
func (w *World) Players() []*Player { return w.players }

// PlayerByCharacter returns the online player of a character, or nil.
func (w *World) PlayerByCharacter(id int64) *Player { return w.byChar[id] }

// Systems returns the per-tick systems of the World, in order: walking, then the flush
// that sends each player its batch. Later systems (AI, combat) go between the two.
func (w *World) Systems() (movement, flush game.System) {
	return game.SystemFunc(w.moveSystem), game.SystemFunc(w.flushSystem)
}
