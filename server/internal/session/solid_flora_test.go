package session_test

import (
	"path/filepath"
	"slices"
	"testing"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
)

// Bushes are solid (docs/06 "Qué bloquea el paso") on the real map: a step onto one is
// refused, and a character that logged out standing on one, when they were walkable, does
// not wake up inside it. Its tile is in no area now (a tile the map changed, placement):
// it logs in at its temple, on the nearest free walkable tile.
func TestBushesAreSolidOnTheMap(t *testing.T) {
	m, err := compile.Compile(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	h := dataHarnessWith(t, func(cfg *session.Config) {
		cfg.Map, cfg.Quests = m, realQuests(t)
		for _, is := range m.Islands() {
			is.Spawns = nil // no monsters: this is about where players stand
		}
	})
	bush := h.w.ItemForTest("bush").Numeric
	id := int64(9700)
	for _, is := range m.Islands() {
		// The first bush of the island with open ground to its west.
		var on, west world.Pos
		found := false
		for _, s := range is.Sectors() {
			for _, st := range s.Stacks {
				if found || !slices.Contains(st.Items, bush) {
					continue
				}
				p := world.Pos{
					X: s.CX*world.SectorSize + st.Index%world.SectorSize,
					Y: s.CY*world.SectorSize + st.Index/world.SectorSize,
					Z: s.Z,
				}
				if q, ok := p.Step(world.West); ok && m.Walkable(q) && !m.MovesOnStep(q) {
					on, west, found = p, q, true
				}
			}
		}
		if !found {
			t.Fatalf("%s: no bush with open ground to its west", is.ID)
		}
		if m.Walkable(on) || !m.LineOfSight(west, world.Pos{X: on.X + 1, Y: on.Y, Z: on.Z}) {
			t.Fatalf("%s: the bush at %v is walkable or hides what is behind it", is.ID, on)
		}

		id++
		saved := session.Character{ID: id, AccountID: id, Name: "Sleeper" + is.ID, Vocation: "guardian", Level: 1,
			Health: 145, Town: is.ID, HasPos: true, Pos: on}
		_, p := h.joinChar(saved)
		if got := p.Pos(); got == on || !m.Walkable(got) || m.MovesOnStep(got) ||
			max(dist(got.X, is.Temple.X), dist(got.Y, is.Temple.Y)) > 3 || got.Z != is.Temple.Z {
			t.Fatalf("%s: saved on the bush at %v, logged in at %v (temple %v)", is.ID, on, got, is.Temple)
		}

		id++
		beside := saved
		beside.ID, beside.AccountID, beside.Name, beside.Pos = id, id, "Walker"+is.ID, west
		cl, q := h.joinChar(beside)
		if q.Pos() != west {
			t.Fatalf("%s: saved beside the bush at %v, logged in at %v", is.ID, west, q.Pos())
		}
		cl.take()
		h.input(cl, walk(E))
		h.sim.RunTicks(30)
		if rej := find(cl.take(), (*pb.ServerMessage).GetWalkRejected); len(rej) != 1 || q.Pos() != west {
			t.Fatalf("%s: a step onto the bush at %v: %d rejections, now at %v", is.ID, on, len(rej), q.Pos())
		}
	}
}

func dist(a, b uint16) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}
