package bot

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/presence"
)

// The load-test bot answers like a person: the option named after the swatch's color.
func TestPresenceAnswer(t *testing.T) {
	for c, name := range presence.Colors {
		pr := &Presence{Swatch: presence.Swatch(c, 0.3, 0.6, 0.9),
			Options: map[uint32]string{3: "presence.option.white", 5: "presence.option.blue", 7: "presence.option.black", 9: "presence.option.yellow"}}
		if id := pr.Answer(); pr.Options[id] != "presence.option."+name {
			t.Fatalf("%s: answered %d (%s)", name, id, pr.Options[id])
		}
	}
}
