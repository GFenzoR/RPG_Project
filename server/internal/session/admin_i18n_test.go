package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// Every message a staff command can send has its text in every language (i18n/).
func TestAdminMessagesTranslated(t *testing.T) {
	keys := []string{msgCommandUnknown, msgCommandTooFast, msgGMUsage, msgGMOffline, msgGMNotFound, msgGMBadPosition,
		msgGMTeleported, msgGMItemUnknown, msgGMItemCount, msgGMItemCreated, msgGMProtected, msgGMKicked,
		msgGMBanDuration, msgGMBanReason, msgGMBanned, msgGMUnbanned, msgGMNotBanned, msgGMFailed,
		msgGMMapSubmission, msgGMMapSubmissions,
		"gm.time_dawn", "gm.time_day", "gm.time_dusk", "gm.time_night", // daynight.go msgGMTime
		"client.chat.line.broadcast", "client.disconnect.banned", "error.account_banned"}
	for _, lang := range []string{"es", "en"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "i18n", lang, "client.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		texts := map[string]string{}
		if err := yaml.Unmarshal(raw, &texts); err != nil {
			t.Fatal(err)
		}
		for _, k := range keys {
			if texts[k] == "" {
				t.Errorf("%s: %s has no text", lang, k)
			}
		}
	}
}

// /time's usage names every word the clock takes (midnight and day too).
func TestTimeUsageListsEveryWord(t *testing.T) {
	usage := gmCommands["time"].usage
	for _, w := range append(DayNightWords(), "minute", "moon", "speed") {
		if !strings.Contains(usage, w) {
			t.Errorf("/time usage %q does not list %q", usage, w)
		}
	}
	for _, w := range DayNightWords() {
		if _, ok := (DayNightCycle{DayMinutes: 180, NightMinutes: 60}).PhaseStart(w); !ok {
			t.Errorf("the clock does not know %q", w)
		}
	}
}
