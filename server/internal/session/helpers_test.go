package session_test

import (
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
	full    bool // Send fails (slow client)
}

func (c *fakeClient) Send(b *pb.ServerBatch) bool {
	if c.full {
		return false
	}
	c.batches = append(c.batches, b)
	return true
}

func (c *fakeClient) Close(r pb.DisconnectReason) { c.closed, c.reason = true, r }

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
	b.Movement = content.Movement{BaseStepMs: 1000, DiagonalCost: 1.5, MaxPathTiles: 100}
	b.Experience.Curve.A, b.Experience.Curve.B, b.Experience.Curve.C = 12, -24, 12
	b.Skills.Base = map[string]content.SkillBase{"sword": {StartLevel: 10, BaseTries: 45}, "fist": {StartLevel: 10, BaseTries: 45},
		"shield": {StartLevel: 10, BaseTries: 85}}
	b.Skills.ShieldMaxTriesPerRound = 2
	b.Skills.AFK.AfterMs, b.Skills.AFK.Factor = 600000, 0.25
	b.Death = content.Death{XPLossPct: 10, SkillLossPct: 10, EquipmentDropPct: 10, BackpackDropPct: 100, MaxBlessings: 5,
		XPLossPctAllBlessings: 3, NoviceMaxLevel: 8, CorpseMs: 600000, CorpseOwnerOnlyMs: 120000}
	b.Combat = content.Combat{AttackIntervalMs: 2000, FistAttack: 7, SkillAttackDivisor: 10, LevelDivisor: 4,
		ShieldBlockDivisor: 4, MonsterCorpseMs: 60000, Modes: map[string]content.CombatMode{
			"offensive": {Attack: 1.25, Defense: 0.55}, "balanced": {Attack: 1, Defense: 1}, "defensive": {Attack: 0.65, Defense: 1.5}}}
	return b
}

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
	for _, o := range opts {
		o(&cfg)
	}
	w, err := session.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	h.w = w
	mv, fight, flush := w.Systems()
	h.sim = sim.New(t, sim.WithSeed(7), sim.WithSystems(mv, fight, flush))
	return h
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

func (h *harness) joinChar(c session.Character) (*fakeClient, *session.Player) {
	h.t.Helper()
	cl := &fakeClient{}
	h.sim.Command(h.w.Join(c, cl))
	h.sim.Step()
	p := h.w.PlayerByCharacter(c.ID)
	if p == nil {
		h.t.Fatalf("%s did not join", c.Name)
	}
	return cl, p
}

func (h *harness) input(cl *fakeClient, m *pb.ClientMessage) { h.sim.Command(h.w.Input(cl, m)) }

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
			want := p == q || session.Sees(p.Pos(), q.Pos())
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
