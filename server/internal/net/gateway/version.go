package gateway

import (
	"strconv"
	"strings"
)

// version is a parsed MAJOR.MINOR.PATCH client version.
type version [3]int

// parseVersion accepts "MAJOR.MINOR.PATCH" with an optional "-prerelease" or "+build"
// suffix, which is ignored.
func parseVersion(s string) (version, bool) {
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return version{}, false
	}
	var v version
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 1_000_000 || (len(p) > 1 && p[0] == '0') {
			return version{}, false
		}
		v[i] = n
	}
	return v, true
}

// compatible reports whether a client of version v may play with a server that
// requires at least min: same major version and not older.
func (v version) compatible(min version) bool {
	if v[0] != min[0] {
		return false
	}
	if v[1] != min[1] {
		return v[1] > min[1]
	}
	return v[2] >= min[2]
}
