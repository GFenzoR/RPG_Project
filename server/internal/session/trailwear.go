package session

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"

	"github.com/GFenzoR/RPG_Project/livingworld/server/trail"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Glue to the living world's trail wear (livingworld/README.md "Desgaste de senderos"):
// the one place of the server that imports livingworld/server/trail. The game loop owns
// the wear map (docs/01): every player step onto a ground whose surface wears counts
// (monsters with data/livingworld/wear.yaml's monster_step, 0 by default; NPCs never),
// the decay runs on the tick, the level changes go to the players who see the tile, and
// a copy leaves the loop every save_every_ms for the database (Config.SaveTrail). Nothing
// here writes the authored map: wear is a layer the client draws over the ground.

// TrailConfig is data/livingworld/wear.yaml.
type TrailConfig = trail.Config

// TrailSnapshot is a copy of the wear, taken on the loop; Encode (off the loop) gives the
// bytes of the trail_wear row.
type TrailSnapshot = trail.Snapshot

// LoadTrailWear reads <dataDir>/livingworld/wear.yaml; nil, nil when there is none (the
// trail wear is then off).
func LoadTrailWear(dataDir string) (*TrailConfig, error) {
	c, err := trail.LoadConfig(filepath.Join(dataDir, "livingworld", "wear.yaml"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("living world: %w", err)
	}
	return &c, nil
}

// trailWear is the World's part of the trail wear.
type trailWear struct {
	m *trail.Map
	// ground is the surface of each ground item that wears, by numeric id.
	ground map[uint16]string
	// savePending is a snapshot persistence could not take: retried every tick.
	savePending bool
	changes     []trail.Change
	out         map[*Player][]*pb.TrailWear
}

func (w *World) initTrail() {
	c := w.cfg.Trail
	if c == nil {
		return
	}
	t := &w.trail
	t.m = trail.New(*c, int(game.TickDuration.Milliseconds()))
	t.ground = map[uint16]string{}
	for _, it := range w.cfg.Items {
		if it.Ground != nil && c.Wears(it.Ground.Surface) {
			t.ground[it.Numeric] = it.Ground.Surface
		}
	}
	t.out = map[*Player][]*pb.TrailWear{}
	if err := t.m.Restore(w.cfg.TrailData, w.cfg.TrailDowntimeMs); err != nil {
		// A row the server cannot read costs the paths, never the start.
		w.log.Error("session: trail wear not restored, starting without it", "err", err)
	}
}

// trailStep counts a step of walker onto p (move.go, monster.go).
func (w *World) trailStep(p world.Pos, walker trail.Walker) {
	t := &w.trail
	if t.m == nil {
		return
	}
	ground, _, ok := w.m.Tile(p)
	if !ok {
		return
	}
	if s := t.ground[ground]; s != "" {
		t.m.OnStep(trail.Pos{X: p.X, Y: p.Y, Z: p.Z}, s, walker)
	}
}

func (w *World) trailPlayerStep(p world.Pos)  { w.trailStep(p, trail.WalkerPlayer) }
func (w *World) trailMonsterStep(p world.Pos) { w.trailStep(p, trail.WalkerMonster) }

// flushTrail runs the decay, hands persistence a snapshot when one is due, and sends every
// player the level changes of the tiles it sees this tick (flushSystem, before the batches).
func (w *World) flushTrail(tick game.Tick) {
	t := &w.trail
	if t.m == nil {
		return
	}
	if t.m.OnTick(int64(tick)) {
		t.savePending = true
	}
	if t.savePending && w.cfg.SaveTrail != nil {
		t.savePending = !w.cfg.SaveTrail(t.m.Snapshot())
	}
	t.changes = t.m.TakeChanges(t.changes[:0])
	if len(t.changes) == 0 {
		return
	}
	for _, c := range t.changes {
		p := world.Pos{X: c.Pos.X, Y: c.Pos.Y, Z: c.Pos.Z}
		w.eachObserver(nil, p, func(o *Player) {
			t.out[o] = appendWear(t.out[o], p, c.Level)
		})
	}
	// In the players' order: the same batches on every run (determinism).
	for _, p := range w.players {
		for _, m := range t.out[p] {
			p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_TrailWear{TrailWear: m}})
		}
	}
	clear(t.out)
}

// appendWear adds tile p at level to the TrailWear of its floor in list.
func appendWear(list []*pb.TrailWear, p world.Pos, level uint8) []*pb.TrailWear {
	var m *pb.TrailWear
	for _, e := range list {
		if e.Z == uint32(p.Z) {
			m = e
			break
		}
	}
	if m == nil {
		m = &pb.TrailWear{Z: uint32(p.Z)}
		list = append(list, m)
	}
	m.Tiles = append(m.Tiles, uint32(p.X)<<16|uint32(p.Y))
	m.Levels = append(m.Levels, level)
	return list
}

// areaWear adds to area the worn tiles of [x0, x1] x [y0, y1] on floor z (mapArea).
func (w *World) areaWear(area *pb.MapArea, x0, y0, x1, y1 int, z uint8) {
	if w.trail.m == nil {
		return
	}
	var m *pb.TrailWear
	w.trail.m.EachInRect(x0, y0, x1, y1, z, func(p trail.Pos, level uint8) {
		if m == nil {
			m = &pb.TrailWear{Z: uint32(z)}
			area.Wear = append(area.Wear, m)
		}
		m.Tiles = append(m.Tiles, uint32(p.X)<<16|uint32(p.Y))
		m.Levels = append(m.Levels, level)
	})
}

// TrailSnapshot returns a copy of the trail wear for the shutdown's last write; false when
// the trail wear is off. Only once the loop has stopped (App.Run) or on the loop.
func (w *World) TrailSnapshot() (TrailSnapshot, bool) {
	if w.trail.m == nil {
		return TrailSnapshot{}, false
	}
	return w.trail.m.Snapshot(), true
}

// TrailLevel is the wear level of p (0..3; tests and staff tools).
func (w *World) TrailLevel(p world.Pos) uint8 {
	if w.trail.m == nil {
		return 0
	}
	return w.trail.m.Level(trail.Pos{X: p.X, Y: p.Y, Z: p.Z})
}
