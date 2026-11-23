package content

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

// NPCDisplayNames reads npc.<id>.name of every language directory of i18nDir
// (i18n/<lang>/npcs.yaml): the names players see over the NPCs, which new characters
// may not copy (auth.NPCReservedNames). A language without npcs.yaml is skipped.
func NPCDisplayNames(i18nDir string) ([]string, error) {
	entries, err := os.ReadDir(i18nDir)
	if err != nil {
		return nil, fmt.Errorf("npc names: %w", err)
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(i18nDir, e.Name(), "npcs.yaml"))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("npc names: %w", err)
		}
		texts := map[string]string{}
		if err := yaml.Unmarshal(raw, &texts); err != nil {
			return nil, fmt.Errorf("npc names %s: %w", e.Name(), err)
		}
		for k, v := range texts {
			if strings.HasPrefix(k, "npc.") && strings.HasSuffix(k, ".name") && strings.Count(k, ".") == 2 && v != "" {
				out = append(out, v)
			}
		}
	}
	sort.Strings(out)
	return out, nil
}
