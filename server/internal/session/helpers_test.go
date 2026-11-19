package session_test

import (
	"slices"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// fakeClient records what the World sends. cap < 0 means unbounded.
type fakeClient struct {
	batches []*pb.ServerBatch
	closed  bool
	reason  pb.DisconnectReason
	closes  int  // calls to Close (the loop makes at most one)
	full    bool // Send fails (slow client)
	// known is the creatures the client knows by what it got (follow), and strangers
	// every CreatureAttack it got that names another one (A9: the AOI never tells a
	// client about a creature it does not know). The harness fails the test on any
	// (newHarness), for every client of every test.
	known     map[uint32]bool
	strangers []*pb.CreatureAttack
}

func (c *fakeClient) Send(b *pb.ServerBatch) bool {
	if c.full {
		return false
	}
	c.follow(b.Events)
	c.batches = append(c.batches, b)
	return true
}

// follow replays what a client knows from its events, in order (a FullMapView replaces
// it, a MapSlice adds its creatures, CreatureAppear and CreatureDisappear add and remove
// one), and keeps the CreatureAttacks whose attacker or target is not among them.
func (c *fakeClient) follow(evs []*pb.ServerMessage) {
	if c.known == nil {
		c.known = map[uint32]bool{}
	}
	learn := func(a *pb.MapArea) {
		for _, cr := range a.GetCreatures() {
			c.known[cr.GetId()] = true
		}
	}
	for _, e := range evs {
		switch m := e.GetMessage().(type) {
		case *pb.ServerMessage_FullMapView:
			clear(c.known)
			learn(m.FullMapView.GetArea())
		case *pb.ServerMessage_MapSlice:
			learn(m.MapSlice.GetArea())
		case *pb.ServerMessage_CreatureAppear:
			c.known[m.CreatureAppear.GetCreature().GetId()] = true
		case *pb.ServerMessage_CreatureDisappear:
			delete(c.known, m.CreatureDisappear.GetId())
		case *pb.ServerMessage_CreatureAttack:
			a := m.CreatureAttack
			if !c.known[a.GetId()] || a.GetTargetId() != 0 && !c.known[a.GetTargetId()] {
				c.strangers = append(c.strangers, a)
			}
		}
	}
}

func (c *fakeClient) Close(r pb.DisconnectReason) { c.closed, c.reason, c.closes = true, r, c.closes+1 }

// events returns every event received so far and forgets them.
func (c *fakeClient) take() []*pb.ServerMessage {
	var out []*pb.ServerMessage
	for _, b := range c.batches {
		out = append(out, b.Events...)
	}
	c.batches = nil
	return out
}

func testBalance() content.Balance {
	var b content.Balance
	b.Movement = content.Movement{BaseStepMs: 1000, DiagonalCost: 1.5, MaxPathTiles: 100, MaxQueuedSteps: 4}
	b.Experience.Curve.A, b.Experience.Curve.B, b.Experience.Curve.C = 12, -24, 12
	b.Experience.Pace = []content.PaceAnchor{{Level: 8, Hours: 1}, {Level: 20, Hours: 8}, {Level: 50, Hours: 80}}
	b.Skills.Base = map[string]content.SkillBase{"sword": {StartLevel: 10, BaseTries: 45}, "fist": {StartLevel: 10, BaseTries: 45},
		"shield": {StartLevel: 10, BaseTries: 85}}
	b.Skills.ShieldMaxTriesPerRound = 2
	b.Skills.AFK.AfterMs, b.Skills.AFK.Factor = 600000, 0.25
	b.Death = content.Death{XPLossPct: 10, SkillLossPct: 10, EquipmentDropPct: 10, BackpackDropPct: 100, MaxBlessings: 5,
		XPLossPctAllBlessings: 3, NoviceMaxLevel: 8, CorpseMs: 600000, CorpseOwnerOnlyMs: 120000}
	b.Combat = content.Combat{AttackIntervalMs: 2000, FistAttack: 7, SkillAttackDivisor: 10, LevelDivisor: 4,
		ShieldBlockDivisor: 4, MonsterCorpseMs: 60000, MonsterPathRetryMs: 1000, MonsterStuckMs: 2000, MonsterShunMs: 30000,
		Modes: map[string]content.CombatMode{
			"offensive": {Attack: 1.25, Defense: 0.55}, "balanced": {Attack: 1, Defense: 1}, "defensive": {Attack: 0.65, Defense: 1.5}}}
	b.Chat.MaxLength = 255
	b.Chat.Ranges.Whisper = content.ChatRange{X: 1, Y: 1}
	b.Chat.Ranges.Say = content.ChatRange{X: 7, Y: 5}
	b.Chat.Ranges.Yell = content.ChatRange{X: 18, Y: 14}
	b.Chat.Flood.Burst, b.Chat.Flood.RefillMs, b.Chat.Flood.MuteMs = 5, 2000, 10000
	b.Chat.GlobalIntervalMs = 10000
	b.Party = content.Party{MaxMembers: 3, InviteMs: 5000, UpdateMs: 1000, ShareDistance: 10, ContributionMs: 60000,
		LevelRangePct: 70, LevelGapAlways: 3, BonusPctPerMember: 6, MaxBonusPct: 24}
	// T4.1: reconcile every ledger every tick (newHarness fails the test on a
	// mismatch), so every test of the package checks the economy log too.
	b.Economy.CheckEveryMs = 50
	b.Economy.Outlier.WindowMs = 3600000
	b.Economy.Outlier.GoldPerHour.Base, b.Economy.Outlier.ItemsPerHour.Base = 1<<40, 1<<40
	b.Reports = content.Reports{Burst: 2, RefillMs: 60000, SameTargetMs: 600000, MaxReason: 200, Events: 20}
	b.Inventory.DoorCooldownMs = doorWait
	b.Inventory.PocketSlots = pocketSlots
	return b
}

// doorWait is the inventory.door_cooldown_ms of the tests (500 in data/balance.yaml).
const doorWait = 500

// pocketSlots is the inventory.pocket_slots of the tests (as data/balance.yaml).
const pocketSlots = 4

var testVocations = content.Vocations{
	"guardian": {ID: "guardian",
		Start:        content.VocationStats{Health: 145, Mana: 20, Capacity: 420000, Speed: 200},
		PerLevel:     content.VocationStats{Health: 14, Mana: 4, Capacity: 23000, Speed: 2},
		Regen:        content.Regen{Health: 3, Mana: 1, IntervalMs: 7000},
		SkillFactors: map[string]float64{"fist": 1.13, "sword": 1.11, "shield": 1.11}},
}

type harness struct {
	t     *testing.T
	sim   *sim.Sim
	w     *session.World
	saves []session.Snapshot
	full  bool // Save fails
	// economy is every economy log entry; alerts every economy alert but mismatches
	// (those fail the test unless allowMismatch).
	economy       []session.EconomyEntry
	alerts        []string
	allowMismatch bool
	// clients is every client that joined through the harness or sent it input (watch):
	// at the end of the test none may have got an attack naming a creature it does not
	// know (fakeClient.strangers).
	clients []*fakeClient
}

// watch adds cl to the clients checked at the end of the test (once; nil, a client the
// World does not know, is skipped).
func (h *harness) watch(cl *fakeClient) {
	if cl != nil && !slices.Contains(h.clients, cl) {
		h.clients = append(h.clients, cl)
	}
}

// checkStrangers fails the test for every attack a client got about a creature it did
// not know (A9, session/attack.go).
func (h *harness) checkStrangers() {
	h.t.Helper()
	for i, cl := range h.clients {
		for _, a := range cl.strangers {
			h.t.Errorf("client %d got an attack naming a creature it does not know: %v", i, a)
		}
	}
}

type option func(*session.Config)

func newHarness(t *testing.T, m *world.Map, opts ...option) *harness {
	t.Helper()
	h := &harness{t: t}
	cfg := session.Config{
		Map:       m,
		Balance:   testBalance(),
		Vocations: testVocations,
		Save: func(s session.Snapshot) bool {
			if h.full {
				return false
			}
			h.saves = append(h.saves, s)
			return true
		},
	}
	h.wireEconomy(&cfg)
	for _, o := range opts {
		o(&cfg)
	}
	w, err := session.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.checkStrangers)
	h.w = w
	mv, fight, flush := w.Systems()
	h.sim = sim.New(t, sim.WithSeed(7), sim.WithSystems(mv, fight, flush))
	return h
}

// wireEconomy records the economy log and its alerts in h; a mismatch fails the test.
func (h *harness) wireEconomy(cfg *session.Config) {
	cfg.Economy = func(e session.EconomyEntry) bool {
		h.economy = append(h.economy, e)
		return true
	}
	cfg.Alert = func(kind string) {
		if kind == session.AlertMismatch && !h.allowMismatch {
			h.t.Errorf("tick %d: economy mismatch (see the log)", h.sim.Tick())
		}
		h.alerts = append(h.alerts, kind)
	}
}

var nextChar int64

// join logs a character in at pos (or the temple if pos is nil) and runs one tick.
func (h *harness) join(name string, pos *world.Pos) (*fakeClient, *session.Player) {
	h.t.Helper()
	nextChar++
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: name, Vocation: "guardian", Level: 1, Health: 145, Mana: 20}
	if pos != nil {
		c.Pos, c.HasPos = *pos, true
	}
	return h.joinChar(c)
}

// joinCmd is w.Join with cl watched: a test that logs a client in by hand (a relogin,
// a second session) goes through it, so the end-of-test check covers that client too.
func (h *harness) joinCmd(c session.Character, cl *fakeClient) game.Command {
	h.watch(cl)
	return h.w.Join(c, cl)
}

func (h *harness) joinChar(c session.Character) (*fakeClient, *session.Player) {
	h.t.Helper()
	cl := &fakeClient{}
	h.sim.Command(h.joinCmd(c, cl))
	h.sim.Step()
	p := h.w.PlayerByCharacter(c.ID)
	if p == nil {
		h.t.Fatalf("%s did not join", c.Name)
	}
	return cl, p
}

func (h *harness) input(cl *fakeClient, m *pb.ClientMessage) {
	h.watch(cl)
	h.sim.Command(h.w.Input(cl, m))
}

func walk(d pb.Direction) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_Walk{Walk: &pb.Walk{Dir: d}}}
}

func walkPath(steps ...pb.Direction) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_WalkPath{WalkPath: &pb.WalkPath{Steps: steps}}}
}

func at(x, y int) *world.Pos { p := world.Pos{X: uint16(x), Y: uint16(y), Z: 7}; return &p }

func pos(x, y int) world.Pos { return *at(x, y) }

const (
	N  = pb.Direction_DIRECTION_NORTH
	NE = pb.Direction_DIRECTION_NORTH_EAST
	E  = pb.Direction_DIRECTION_EAST
	SE = pb.Direction_DIRECTION_SOUTH_EAST
	S  = pb.Direction_DIRECTION_SOUTH
	W  = pb.Direction_DIRECTION_WEST
)

// checkInvariants verifies the AOI bookkeeping: every player's client knows exactly the
// creatures it sees, and no two players share a tile.
func (h *harness) checkInvariants() {
	h.t.Helper()
	ps := h.w.Players()
	tiles := map[world.Pos]uint32{}
	for _, p := range ps {
		if other, dup := tiles[p.Pos()]; dup {
			h.t.Fatalf("tick %d: players %d and %d share %v", h.sim.Tick(), other, p.ID(), p.Pos())
		}
		tiles[p.Pos()] = p.ID()
		for _, q := range ps {
			want := p == q || session.Sees(p.Pos(), q.Pos()) && !q.Invisible()
			if got := p.Knows(q.ID()); got != want {
				h.t.Fatalf("tick %d: player %d at %v knows %d at %v = %v, sees = %v",
					h.sim.Tick(), p.ID(), p.Pos(), q.ID(), q.Pos(), got, want)
			}
		}
		if len(p.Known()) > len(ps) {
			h.t.Fatalf("player %d knows %d creatures, only %d online", p.ID(), len(p.Known()), len(ps))
		}
	}
}

func kinds(evs []*pb.ServerMessage) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = string(e.ProtoReflect().WhichOneof(e.ProtoReflect().Descriptor().Oneofs().Get(0)).Name())
	}
	return out
}

func find[T proto.Message](evs []*pb.ServerMessage, get func(*pb.ServerMessage) T) []T {
	var out []T
	for _, e := range evs {
		if v := get(e); !isNil(v) {
			out = append(out, v)
		}
	}
	return out
}

func isNil[T proto.Message](v T) bool { return !v.ProtoReflect().IsValid() }

var _ = game.Tick(0)

// gameFunc wraps a test closure as a command (it runs on the loop, inside a tick).
type gameFunc func()

func (f gameFunc) Execute(*game.TickContext) { f() }
