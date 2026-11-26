package gateway

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/pkg/bot"
)

// Saved options (owner decision 2026-11-26): the server enters a character with its saved
// stance, chase and safe mode, and tells them in Welcome.options. A client from before
// that (0.1.x; the desktop app carries its own build) ignores the field: it shows "safe"
// and balanced whatever the server holds, and only ever sends SetSafeMode(false). A
// player whose character saved the safe mode off would attack another one without
// meaning to. So the oldest client accepted is the first that reads the options, and
// the client of this repository and the bots are at least that.
func TestOldestClientReadsTheSavedOptions(t *testing.T) {
	first, _ := parseVersion("0.2.0")
	minVer, ok := parseVersion(DefaultMinClientVersion)
	if !ok || !minVer.compatible(first) {
		t.Fatalf("DefaultMinClientVersion %q accepts clients from before the saved options (0.2.0)", DefaultMinClientVersion)
	}
	raw, err := os.ReadFile("../../../../client/package.json")
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatal(err)
	}
	for name, v := range map[string]string{"client/package.json": pkg.Version, "bot.ClientVersion": bot.ClientVersion} {
		if p, ok := parseVersion(v); !ok || !p.compatible(minVer) {
			t.Errorf("%s is %q: the server (min %s) would refuse it", name, v, DefaultMinClientVersion)
		}
	}
}
