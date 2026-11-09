package session

import (
	"os"
	"path/filepath"
	"testing"

	"go.yaml.in/yaml/v3"
)

// Every message a staff command can send has its text in every language (i18n/).
func TestAdminMessagesTranslated(t *testing.T) {
	keys := []string{msgCommandUnknown, msgCommandTooFast, msgGMUsage, msgGMOffline, msgGMNotFound, msgGMBadPosition,
		msgGMTeleported, msgGMItemUnknown, msgGMItemCount, msgGMItemCreated, msgGMProtected, msgGMKicked,
		msgGMBanDuration, msgGMBanReason, msgGMBanned, msgGMUnbanned, msgGMNotBanned, msgGMFailed,
		msgGMMapSubmission, msgGMMapSubmissions,
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
