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
	valid := regexp.MustCompile(`^Bot[a-z]{2,3} [A-Z][a-z]{1,11}$`)
	for _, prefix := range []string{"load", "ci", "tunnel", "stress", "abcdefghijkl"} {
		if err := checkPrefix(prefix, maxBots); err != nil {
			t.Fatalf("checkPrefix(%q): %v", prefix, err)
		}
		seen := map[string]bool{}
		for i := range maxBots {
			n := name(prefix, i)
			if seen[n] || !valid.MatchString(n) || len(n) > 20 {
				t.Fatalf("name(%q, %d) = %q", prefix, i, n)
			}
			seen[n] = true
		}
	}
	if name("load", 0) != "Botaa Load" || name("ci", 27) != "Botbb Ci" {
		t.Fatalf("name: %q %q", name("load", 0), name("ci", 27))
	}
}

func TestCheckPrefixRejects(t *testing.T) {
	for _, tc := range []struct {
		prefix string
		n      int
	}{
		{"dev", 1},           // "Botaa Dev": a reserved word
		{"mine", 10},         // bot 3 is "Botad Mine": "botadmine" contains "admin"
		{"load100", 1},       // digits: "load100" and "load300" would fold into "Load"
		{"load300", 1},       //
		{"Load", 1},          // not lowercase
		{"a", 1},             // too short
		{"abcdefghijklm", 1}, // too long
		{"lo-ad", 1},
		{"", 1},
	} {
		if err := checkPrefix(tc.prefix, tc.n); err == nil {
			t.Errorf("checkPrefix(%q, %d) accepted", tc.prefix, tc.n)
		}
	}
	// "mine" is fine for the first 3 bots (the clash is at bot 3).
	if err := checkPrefix("mine", 3); err != nil {
		t.Errorf("checkPrefix(mine, 3): %v", err)
	}
}

func TestAccountEmails(t *testing.T) {
	email, password := account("load", 3)
	// Not the "load-3@bots.local" of the T1.4 bot, whose accounts are full of characters.
	if email != "load-3@load.bots.local" || password == "" {
		t.Fatalf("account = %q, %q", email, password)
	}
}

func TestIsLoopback(t *testing.T) {
	for u, want := range map[string]bool{
		"http://localhost:8080":       true,
		"http://127.0.0.1:8090":       true,
		"http://[::1]:8080":           true,
		"https://staging.example.org": false,
		"http://10.0.0.5:8080":        false,
		"::bad":                       false,
	} {
		if got := isLoopback(u); got != want {
			t.Errorf("isLoopback(%q) = %v, want %v", u, got, want)
		}
	}
}
