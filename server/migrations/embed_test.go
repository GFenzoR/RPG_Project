package migrations

import (
	"io/fs"
	"strconv"
	"strings"
	"testing"
)

// knownGaps lists versions that were never used on purpose. 00024 was the idle-session
// migration while lote 17 was in review; the account stash (00025) reached development
// databases first, so the sessions one moved to 00026 and 00024 stays empty: filling it
// now would be a missing (out-of-order) migration for every database already at 00025.
var knownGaps = map[int]bool{24: true}

// TestVersionsAreContiguousAndUnique guards against two branches picking the same goose
// version (goose refuses duplicates and the server would not start) or leaving a gap
// that a later branch fills behind databases that already moved past it.
func TestVersionsAreContiguousAndUnique(t *testing.T) {
	entries, err := fs.ReadDir(FS, ".")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}
	seen := map[int]string{}
	maxVersion := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		prefix, _, ok := strings.Cut(name, "_")
		if !ok {
			t.Fatalf("migration %q has no version prefix", name)
		}
		v, err := strconv.Atoi(prefix)
		if err != nil {
			t.Fatalf("migration %q: bad version: %v", name, err)
		}
		if other, dup := seen[v]; dup {
			t.Fatalf("migrations %q and %q share version %d", other, name, v)
		}
		seen[v] = name
		if v > maxVersion {
			maxVersion = v
		}
	}
	for v := 1; v <= maxVersion; v++ {
		if _, ok := seen[v]; !ok && !knownGaps[v] {
			t.Errorf("migration version %05d is missing (versions must be contiguous)", v)
		}
	}
	for v := range knownGaps {
		if name, ok := seen[v]; ok {
			t.Errorf("version %05d is a known gap but %q uses it: databases past it would refuse it", v, name)
		}
	}
}
