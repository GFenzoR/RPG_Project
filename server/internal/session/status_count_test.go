package session

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
)

// TestStatusCountMatchesAppend: count sizes the PlayerConditions list, so it must equal
// the entries appendStatuses adds for every combination of live statuses.
func TestStatusCountMatchesAppend(t *testing.T) {
	const now game.Tick = 100
	for _, fight := range []game.Tick{0, now + 40} {
		for _, lock := range []game.Tick{0, now + 80} {
			for _, zone := range []bool{false, true} {
				s := statusView{fight: fight, lock: lock, zone: zone}
				if got, want := s.count(), len(appendStatuses(nil, s, now)); got != want {
					t.Errorf("%+v: count %d, appendStatuses adds %d", s, got, want)
				}
			}
		}
	}
}
