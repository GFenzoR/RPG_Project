package session_test

import (
	"path/filepath"
	"sort"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
)

// A boss keeps one room on purpose: whoever waits inside it holds its respawn back, and
// has to wait out of its sight (docs/02 "Respawns", "Sin tope"). Those are listed here, so
// that a new one is a decision and not an oversight.
var oneRoomBosses = map[string]bool{"slagbound_warden": true}

// Nothing respawns on a tile a player sees, without a cap (docs/02 "Respawns"): one player
// standing where it sees a whole spawn area keeps it empty. So a quest must never ask for
// kills of a monster that one standing player can hold back everywhere: on the real map,
// the spawn areas of every monster a quest step asks to kill do not fit together in one
// player's view. A second player (or the same one, walking) always finds a spawn that
// goes on respawning out of the first one's sight.
func TestRepoQuestKillsCannotBeHeldBackByOneWatcher(t *testing.T) {
	m, err := compile.Compile(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	type box struct {
		x0, y0, x1, y1 int
		floors         map[uint8]bool
		spawns         int
	}
	areas := map[string]*box{}
	for _, is := range m.Islands() {
		for _, sp := range is.Spawns {
			x, y, r := int(sp.Center.X), int(sp.Center.Y), int(sp.Radius)
			for _, sm := range sp.Monsters {
				b := areas[sm.Monster]
				if b == nil {
					b = &box{x0: x - r, y0: y - r, x1: x + r, y1: y + r, floors: map[uint8]bool{}}
					areas[sm.Monster] = b
				}
				b.x0, b.y0 = min(b.x0, x-r), min(b.y0, y-r)
				b.x1, b.y1 = max(b.x1, x+r), max(b.y1, y+r)
				b.floors[sp.Center.Z] = true
				b.spawns++
			}
		}
	}
	quests := realQuests(t)
	ids := make([]string, 0, len(quests))
	for id := range quests {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	checked := 0
	for _, id := range ids {
		for _, st := range quests[id].Steps {
			k := st.CompleteWhen.Kill
			if k == nil {
				continue
			}
			b := areas[k.Monster]
			if b == nil || oneRoomBosses[k.Monster] {
				continue
			}
			checked++
			// One viewer sees 2*ViewHalfW+1 by 2*ViewHalfH+1 tiles, on the floors seen
			// together: surface floors with each other, an underground floor alone.
			together := true
			under := 0
			for z := range b.floors {
				if z > session.SeaLevel {
					under++
				}
			}
			if under > 1 || (under == 1 && len(b.floors) > 1) {
				together = false
			}
			if together && b.x1-b.x0 <= 2*session.ViewHalfW && b.y1-b.y0 <= 2*session.ViewHalfH {
				t.Errorf("quest %s, step %s: one player standing still sees every spawn area of %s (%d spawn(s), x %d..%d, y %d..%d) "+
					"and nothing respawns in sight: add a spawn out of that view", id, st.ID, k.Monster, b.spawns, b.x0, b.x1, b.y0, b.y1)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no quest of data/ asks for kills of a spawned monster: the test checks nothing")
	}
}
