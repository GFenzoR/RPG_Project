package main

import (
	"context"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"regexp"
	"strconv"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/pkg/bot"
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
	valid := regexp.MustCompile(`^Duo[a-z]{2,3} [A-Z][a-z]{1,9}$`)
	for _, prefix := range []string{"load", "ci", "tunnel", "stress", "abcdefghi"} {
		if err := checkPrefix(prefix, maxBots); err != nil {
			t.Fatalf("checkPrefix(%q): %v", prefix, err)
		}
		seen := map[string]bool{}
		for i := range maxBots {
			n := name(prefix, i)
			if seen[n] || !valid.MatchString(n) || len(n) > maxNameLen {
				t.Fatalf("name(%q, %d) = %q", prefix, i, n)
			}
			seen[n] = true
		}
	}
	if name("load", 0) != "Duoaa Load" || name("ci", 27) != "Duobb Ci" {
		t.Fatalf("name: %q %q", name("load", 0), name("ci", 27))
	}
}

func TestCheckPrefixRejects(t *testing.T) {
	for _, tc := range []struct {
		prefix string
		n      int
	}{
		{"dev", 1},          // "Duoaa Dev": a reserved word
		{"mine", 10},        // bot 3 is "Duoad Mine": "duoadmine" contains "admin"
		{"load100", 1},      // digits: "load100" and "load300" would fold into "Load"
		{"load300", 1},      //
		{"Load", 1},         // not lowercase
		{"a", 1},            // too short
		{"abcdefghijk", 1},  // too long: "Duoaa Abcdefghijk" is 17 letters
		{"abcdefghij", 677}, // bot 676 is "Duobaa Abcdefghij": 17 letters
		{"lo-ad", 1},
		{"", 1},
	} {
		if err := checkPrefix(tc.prefix, tc.n); err == nil {
			t.Errorf("checkPrefix(%q, %d) accepted", tc.prefix, tc.n)
		}
	}
	// Ten letters fit while the first word has five ("Duozz Abcdefghij" is 16).
	if err := checkPrefix("abcdefghij", 676); err != nil {
		t.Errorf("checkPrefix(abcdefghij, 676): %v", err)
	}
	// "mine" is fine for the first 3 bots (the clash is at bot 3).
	if err := checkPrefix("mine", 3); err != nil {
		t.Errorf("checkPrefix(mine, 3): %v", err)
	}
}

func TestAccountEmails(t *testing.T) {
	email, password := account("load", 3)
	// Not the "load-3@bots.local" of the T1.4 bot nor the "load-3@load.bots.local" of 10
	// bots per account, whose accounts hold other bots' characters.
	if email != "load-3@pair.bots.local" || password == "" {
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

// A bot the server still kept in a fight when logoutWait ran out (a monster that keeps
// biting it without killing it) leaves link-dead: counted apart, not an error that fails
// the run. Any other failed logout still is one.
func TestLoggedOutInAFightIsNoFailure(t *testing.T) {
	f := &fleet{rep: &Report{}}
	f.loggedOut(0, nil)
	f.loggedOut(1, fmt.Errorf("logout: %w (%w)", bot.ErrLogoutLocked, context.DeadlineExceeded))
	f.loggedOut(2, errors.New(`logout: disconnected with "KICKED"`))
	f.loggedOut(3, fmt.Errorf("logout: %w", context.DeadlineExceeded))
	if f.rep.LeftLinkDead != 1 || f.rep.OtherErrors != 2 || f.rep.Disconnects != 0 || len(f.rep.Errors) != 2 {
		t.Fatalf("left link-dead %d, other errors %d, disconnects %d, errors %v",
			f.rep.LeftLinkDead, f.rep.OtherErrors, f.rep.Disconnects, f.rep.Errors)
	}
}

// serverCharsPerAccount is the server's default -max-chars-per-account
// (session.DefaultMaxCharactersPerAccount, which tools/bots cannot import): the CI stack
// and tunnel jobs run the bots against production defaults. Keep them in sync.
const serverCharsPerAccount = 2

// The bots of one account must fit the server's default cap of characters of one account
// in the world: with 10 per account the third bot of the CI stack job got
// Disconnect{TOO_MANY_CHARACTERS} and failed the run.
func TestPerAccountFitsServerCap(t *testing.T) {
	if perAccount < 1 || perAccount > serverCharsPerAccount {
		t.Fatalf("perAccount = %d, want 1..%d", perAccount, serverCharsPerAccount)
	}
}

// maxNameLen is a copy of the server's auth.MaxNameLen (another module): the two stay equal.
func TestMaxNameLenIsTheServers(t *testing.T) {
	got, err := intConst("../../../../server/internal/auth/validate.go", nil, "MaxNameLen")
	if err != nil {
		t.Fatal(err)
	}
	if got != maxNameLen {
		t.Errorf("auth.MaxNameLen = %d, maxNameLen = %d", got, maxNameLen)
	}
}

// intConst reads the integer literal a Go file (or `src`, when given) gives the constant
// `name`. It parses the file, so it does not care how the const block is laid out: a
// regexp over the text broke with a realigned block or a typed constant.
func intConst(path string, src any, name string) (int, error) {
	f, err := parser.ParseFile(token.NewFileSet(), path, src, 0)
	if err != nil {
		return 0, err
	}
	for _, decl := range f.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for i, id := range vs.Names {
				if id.Name != name || i >= len(vs.Values) {
					continue
				}
				lit, ok := vs.Values[i].(*ast.BasicLit)
				if !ok || lit.Kind != token.INT {
					return 0, fmt.Errorf("%s is not an integer literal", name)
				}
				return strconv.Atoi(lit.Value)
			}
		}
	}
	return 0, fmt.Errorf("constant %s not found in %s", name, path)
}

func TestIntConstReadsAnyLayout(t *testing.T) {
	for _, src := range []string{
		"package auth\nconst (\n\tMinNameLen = 3\n\tMaxNameLen = 16\n)\n",
		"package auth\nconst (\n\tMinNameLen      = 3\n\tMaxNameLen      = 16 // letters\n\tMaxKnownNameLen = 20\n)\n",
		"package auth\nconst MaxNameLen int = 16\n",
		"package auth\nconst MinNameLen, MaxNameLen = 3, 16\n",
	} {
		got, err := intConst("validate.go", src, "MaxNameLen")
		if err != nil || got != 16 {
			t.Errorf("intConst(%q) = %d, %v; want 16", src, got, err)
		}
	}
	if _, err := intConst("validate.go", "package auth\nconst MaxKnownNameLen = 20\n", "MaxNameLen"); err == nil {
		t.Error("a file without the constant gave no error")
	}
}
