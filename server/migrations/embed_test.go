package migrations

import (
	"io/fs"
	"strconv"
	"strings"
	"testing"
)

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
		if _, ok := seen[v]; !ok {
			t.Errorf("migration version %05d is missing (versions must be contiguous)", v)
		}
	}
}
