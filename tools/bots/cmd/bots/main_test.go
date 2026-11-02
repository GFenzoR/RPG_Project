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
	valid := regexp.MustCompile(`^Bot[a-z]{2,3}$`)
	seen := map[string]bool{}
	for i := range maxBots {
		n := name(i)
		if seen[n] || !valid.MatchString(n) {
			t.Fatalf("name(%d) = %q", i, n)
		}
		seen[n] = true
	}
	if name(0) != "Botaa" || name(27) != "Botbb" {
		t.Fatalf("name(0) = %q, name(27) = %q", name(0), name(27))
	}
}
