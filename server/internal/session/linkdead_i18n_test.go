package session

import (
	"os"
	"path/filepath"
	"testing"

	"go.yaml.in/yaml/v3"
)

// The refusals of a Logout in a fight have their text in every language (i18n/).
func TestLogoutBlockTranslated(t *testing.T) {
	for _, lang := range []string{"es", "en"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "i18n", lang, "client.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		texts := map[string]string{}
		if err := yaml.Unmarshal(raw, &texts); err != nil {
			t.Fatal(err)
		}
		for _, k := range []string{msgLogoutLocked, msgPvPLogoutLocked} {
			if texts[k] == "" {
				t.Errorf("%s: %s has no text", lang, k)
			}
		}
	}
}
