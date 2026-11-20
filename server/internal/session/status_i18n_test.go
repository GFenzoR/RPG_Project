package session

import (
	"os"
	"path/filepath"
	"testing"

	"go.yaml.in/yaml/v3"
)

// balanceConditionIDs is the ids of data/balance.yaml's conditions.
func balanceConditionIDs(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "data", "balance.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var balance struct {
		Conditions map[string]yaml.Node `yaml:"conditions"`
	}
	if err := yaml.Unmarshal(raw, &balance); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(balance.Conditions))
	for id := range balance.Conditions {
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		t.Fatal("balance.yaml has no conditions")
	}
	return ids
}

// Every condition of balance.yaml and every status the server sends has its name and its
// description in every language (i18n/*/client.yaml condition.<id>.name and .desc): the
// status tray shows both, and a missing one would show its raw key in the tooltip.
func TestConditionsAndStatusesTranslated(t *testing.T) {
	ids := append(balanceConditionIDs(t), statusIDs...)
	for _, lang := range []string{"es", "en"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "i18n", lang, "client.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		texts := map[string]string{}
		if err := yaml.Unmarshal(raw, &texts); err != nil {
			t.Fatal(err)
		}
		for _, id := range ids {
			for _, k := range []string{"condition." + id + ".name", "condition." + id + ".desc"} {
				if texts[k] == "" {
					t.Errorf("%s: %s has no text", lang, k)
				}
			}
		}
	}
}
