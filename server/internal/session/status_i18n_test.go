package session

import (
	"os"
	"path/filepath"
	"testing"

	"go.yaml.in/yaml/v3"
)

// Every status the server sends has its name and its description in every language, like
// the conditions (i18n/*/client.yaml condition.<id>.name and .desc): the status tray shows
// both.
func TestStatusesTranslated(t *testing.T) {
	for _, lang := range []string{"es", "en"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "i18n", lang, "client.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		texts := map[string]string{}
		if err := yaml.Unmarshal(raw, &texts); err != nil {
			t.Fatal(err)
		}
		for _, id := range statusIDs {
			for _, k := range []string{"condition." + id + ".name", "condition." + id + ".desc"} {
				if texts[k] == "" {
					t.Errorf("%s: %s has no text", lang, k)
				}
			}
		}
	}
}
