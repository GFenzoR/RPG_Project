package main

import (
	"regexp"
	"testing"
)

func TestValidateCount(t *testing.T) {
	for _, tc := range []struct {
		n       int
		wantErr bool
	}{
		{0, true},
		{1, false},
		{100, false},
		{1000, false},
		{1001, true},
	} {
		if err := validateCount(tc.n); (err != nil) != tc.wantErr {
			t.Errorf("validateCount(%d) error = %v, wantErr %v", tc.n, err, tc.wantErr)
		}
	}
}

func TestNamesAreUniqueAndValid(t *testing.T) {
	valid := regexp.MustCompile(`^Bot[a-z]{2,3}( [A-Z][a-z]{1,11})?$`)
	for _, prefix := range []string{"load", "ci", "tunnel", "chk", "a-very-long-prefix-1", "1"} {
		seen := map[string]bool{}
		for i := range maxBots {
			n := name(prefix, i)
			if seen[n] || !valid.MatchString(n) || len(n) > 20 {
				t.Fatalf("name(%q, %d) = %q", prefix, i, n)
			}
			seen[n] = true
		}
	}
	if name("load", 0) != "Botaa Load" || name("ci", 27) != "Botbb Ci" || name("", 1) != "Botab" {
		t.Fatalf("name: %q %q %q", name("load", 0), name("ci", 27), name("", 1))
	}
}
