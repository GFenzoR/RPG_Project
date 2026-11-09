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
	"sync/atomic"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
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
	// Role is the account's role (accounts.role); staff commands check it (T2.6).
	Role Role
	// Storage is the quest progress and flags (quest_state rows: key → value).
	Storage map[string]int64
	// Conditions are the saved conditions that survive a logout (T3.2).
	Conditions []ConditionState
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
	// Storage is every non-zero quest_state value (a copy).
	Storage map[string]int64
	// Conditions are the active conditions that persist (T3.2), with their time left.
	Conditions []ConditionState
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
	// StartTown is the island whose temple a character without a residence town wakes up
	// at. Empty means the first island of the map (the first one in world/world.yaml).
	StartTown string
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
	// NPCs and Quests come from data/ (T1.10). With NPCs set, the World places the
	// map's NPCs (world.Island.NPCs); every placed NPC must exist and every shop item
	// must be in Items. Without NPCs the world has none (tests, tools).
	NPCs   content.NPCs
	Quests content.Quests
	// Recipes come from data/recipes.yaml (T3.4): every station, input and output must
	// be in Items and every craft a skill of Balance.
	Recipes content.Recipes
	// BoatRoutes come from data/boat_routes.yaml (T3.5): every captain must be placed on
	// the map near the dock, and the dock and the arrival must be walkable.
	BoatRoutes content.BoatRoutes
	// Tutorial comes from data/tutorial.yaml (T4.2): its island must be on the map and
	// what its steps reference must exist. Nil means no tutorial.
	Tutorial *content.Tutorial
	// Balance.Conditions (T3.2) must hold every condition the spells and monsters apply.
	// Save submits a snapshot to the persistence goroutine without blocking. It returns
	// false if its queue is full; the World retries on the next ticks. Required.
	Save func(Snapshot) bool
	// Admin submits a staff command's audit entry, ban or unban to the admin goroutine
	// without blocking (T2.6). It returns false if its queue is full; the World keeps
	// the job and retries on the next ticks, so no audit entry is lost. Without Admin,
	// staff commands are disabled (they answer like an unknown command).
	Admin func(AdminJob) bool
	// Guilds are every guild, loaded from the database before the loop starts (T5.1).
	// Their changes are written through Admin (AdminGuild jobs). Nil, or no Admin,
	// turns guilds off (commands answer guild.unavailable).
	Guilds *GuildData
	// Economy submits an economy log entry to the persistence goroutine without blocking
	// (T4.1). It returns false if its queue is full; the World keeps the entry and
	// retries on the next ticks (up to a bound). Without Economy nothing is written, but
	// the ledgers are still reconciled.
	Economy func(EconomyEntry) bool
	// Alert is told about every economy alert (AlertMismatch...), for the metrics. It is
	// called on the loop and must not block. Optional.
	Alert func(kind string)
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

	nextID  uint32
	players []*Player // ordered by creature id: deterministic iteration
	// published is len(players), stored by the loop goroutine whenever it changes, so
	// other goroutines (GET /api/status) can read it without touching the world.
	published atomic.Int32
	byClient  map[Client]*Player
	byChar    map[int64]*Player
	sectors   map[uint64][]*Player

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

	// Death (T1.11): how long a player's corpse lasts and is reserved for its owner.
	playerCorpseFor game.Tick
	corpseOwnerFor  game.Tick

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

	// NPCs and quests (T1.10): NPCs never move, so they are indexed once.
	npcs     []*NPC
	npcByID  map[uint32]*NPC
	npcAt    map[world.Pos]*NPC
	nsectors map[uint64][]*NPC
	quests   *quest.Engine
	coins    []*content.Item // currency items, highest worth first

	// Gathering (T1.12): harvested tiles (charges left, refill event), the rate limit
	// and the anti-AFK delay in ticks (0 = off).
	resources      map[world.Pos]*resourceTile
	gatherFor      game.Tick
	gatherAFKAfter game.Tick
	// Crafting (T3.4): the station items of the recipes (numeric id) and the inputs of
	// their recipes, for StationOpen.
	stations map[uint16][]*content.Item

	// Chat (T1.13): balance.yaml chat converted to ticks.
	chatRefill game.Tick
	chatBurst  game.Tick // tolerance: refill × (burst − 1)
	chatMute   game.Tick
	chatGlobal game.Tick

	// Staff commands (T2.6): jobs not queued yet, bans and unbans waiting for the
	// database, and accounts banned while online (until; zero = permanent).
	adminRetry []AdminJob
	nextJob    uint64
	jobs       map[uint64]pendingJob
	banned     map[int64]time.Time
	// nextRoleCheck is the tick of the next check of the online staff's roles.
	nextRoleCheck game.Tick

	// Parties (T3.3): every party (creation order), pending invitations (expiry tick),
	// balance.yaml party in ticks and a scratch list of sharers.
	parties    []*party
	invites    map[inviteKey]game.Tick
	inviteFor  game.Tick
	partyEvery game.Tick
	contribFor game.Tick
	partyBuf   []*Player
	islandBuf  []string

	// Guilds (T5.1, guild.go): every guild by id and by name key, members by
	// character, the guilds that invited each character, the last guild id, and this
	// tick's GuildUpdates to send.
	guildOn      bool
	guilds       map[int64]*guildState
	guildByName  map[string]*guildState
	guildMembers map[int64]*guildMember
	guildInvited map[int64][]*guildState
	nextGuildID  int64
	guildDirty   []*guildState
	guildSend    []*Player

	// Travel (T3.5): routes by captain NPC id, balance travel in ticks and tiles.
	routes        map[string][]*route
	fightFor      game.Tick
	arrivalRadius int

	// Economy log (T4.1): this tick's entries, entries the queue did not take yet, how
	// many were dropped, and balance.yaml economy in ticks.
	econBuf      []EconomyEntry
	econRetry    []EconomyEntry
	econDropped  uint64
	econCheckFor game.Tick
	outlierFor   game.Tick
	// earnings are the outlier windows by character (kept across logins until they
	// expire) and earnPrune the tick of the next sweep of the expired ones.
	earnings  map[int64]*earning
	earnPrune game.Tick

	// Reports (T4.1): the per-account rate limit (GCRA tick), the last report of each
	// account and character, balance.yaml reports in ticks and the next prune.
	reportTAT    map[int64]game.Tick
	reportLast   map[reportKey]game.Tick
	reportRefill game.Tick
	reportBurst  game.Tick
	reportSame   game.Tick
	reportPrune  game.Tick

	// Bot detection (T4.1 2/2): balance.yaml antibot, the evaluation period in ticks,
	// the state by character, the last presence check id, and the income medians by
	// level band (experience and gold per hour) with the tick they are due again.
	abCfg        *content.AntiBot
	abEvalFor    game.Tick
	suspects     map[int64]*suspect
	nextCheck    uint32
	abMedians    map[int][2]float64
	abMedianNext game.Tick
	// abStats are the aggregate numbers for /metrics (atomics, read from any goroutine).
	abStats antibot.Stats

	// mapNote groups the GM notices of new map submissions (mapnotify.go).
	mapNote mapNotice

	// Idle (T4.1): balance.yaml idle in ticks (kickFor 0 = off) and a scratch list.
	idleKickFor game.Tick
	idleWarnFor game.Tick
	idleBuf     []*Player

	// sched is the loop's scheduler, kept at the first join to know the current tick
	// outside a TickContext (condition times in snapshots and at flush, T3.2).
	sched *game.Scheduler
}

// New validates cfg and builds an empty World.
func New(cfg Config) (*World, error) {
	if cfg.Map == nil {
		return nil, errors.New("session: Config.Map is required")
	}
	if cfg.StartTown != "" && cfg.Map.Island(cfg.StartTown) == nil {
		return nil, fmt.Errorf("session: start town %q is not an island of the map", cfg.StartTown)
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
		jobs:     map[uint64]pendingJob{},
		banned:   map[int64]time.Time{},
		pf:       world.NewPathfinder(cfg.Map, cfg.RerouteMaxNodes),
	}
	if err := w.initCombat(); err != nil {
		return nil, err
	}
	w.initProgress()
	w.initDeath()
	if err := w.initItems(); err != nil {
		return nil, err
	}
	if err := w.initMagic(); err != nil {
		return nil, err
	}
	if err := w.initNPCs(); err != nil {
		return nil, err
	}
	if err := w.initTravel(); err != nil {
		return nil, err
	}
	w.initChat()
	w.initEconomy()
	w.initReports()
	w.initIdle()
	w.initAntiBot()
	w.initParty()
	w.initGuilds()
	if err := w.initConditions(); err != nil {
		return nil, err
	}
	if err := w.initGathering(); err != nil {
		return nil, err
	}
	if err := w.initCrafting(); err != nil {
		return nil, err
	}
	if err := w.initTutorial(); err != nil {
		return nil, err
	}
	return w, nil
}

// Online returns how many players are in the world. Loop goroutine only.
func (w *World) Online() int { return len(w.players) }

// PublishedOnline returns how many players are in the world as of the last join or
// leave. Safe from any goroutine (T4.3, /api/status).
func (w *World) PublishedOnline() int { return int(w.published.Load()) }

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
