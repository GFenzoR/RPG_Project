package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

func fileSet(paths ...string) func(string) bool {
	m := map[string]bool{}
	for _, p := range paths {
		m[filepath.Clean(p)] = true
	}
	return func(p string) bool { return m[filepath.Clean(p)] }
}

func TestFindRepoRoot(t *testing.T) {
	base := t.TempDir() // an absolute path on every OS
	root := filepath.Join(base, "repo")
	files := fileSet(filepath.Join(root, "Makefile"), filepath.Join(root, "deploy", "home.sh"),
		// A Makefile alone (tools/launcher has none, but server/ could) is not the root.
		filepath.Join(root, "server", "Makefile"))
	for _, start := range []string{root, filepath.Join(root, "server"), filepath.Join(root, "tools", "launcher")} {
		got, ok := findRepoRoot(start, files)
		if !ok || got != root {
			t.Errorf("findRepoRoot(%q) = %q, %v; want %q", start, got, ok, root)
		}
	}
	if got, ok := findRepoRoot(filepath.Join(base, "elsewhere", "dir"), files); ok {
		t.Errorf("found %q outside the repo", got)
	}
}

func TestFindRepoRootOnThisCheckout(t *testing.T) {
	got, ok := findRepoRoot(".", isFile)
	if !ok {
		t.Fatal("the launcher's own checkout was not found from tools/launcher")
	}
	if !isFile(filepath.Join(got, "deploy", "home-tunnel.sh")) {
		t.Errorf("root %q has no deploy/home-tunnel.sh", got)
	}
}

func TestHomePort(t *testing.T) {
	cases := map[string]string{
		"":                        "8080",
		"# HOME_HTTP_PORT=9000\n": "8080",
		"HOME_HTTP_PORT=9000\n":   "9000",
		"HOME_HTTP_PORT=9000\r\nHOME_HTTP_PORT=9100\r\n": "9100",
		"HOME_HTTP_PORT=\n":   "8080",
		"XHOME_HTTP_PORT=1\n": "8080",
	}
	for in, want := range cases {
		if got := homePort(in); got != want {
			t.Errorf("homePort(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPrependPath(t *testing.T) {
	exists := func(d string) bool { return !strings.Contains(d, "missing") }
	got := prependPath(`C:\Windows\System32;C:\Program Files\Git\bin;C:\tools`,
		[]string{`C:\Program Files\Git\bin`, `C:\missing\bin`, `C:\Program Files\Docker\Docker\resources\bin`}, ";", exists)
	want := `C:\Program Files\Git\bin;C:\Program Files\Docker\Docker\resources\bin;C:\Windows\System32;C:\tools`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
	// Case and a trailing slash do not make a second entry; empty entries go away.
	got = prependPath("/usr/bin::/BIN/", []string{"/bin"}, ":", exists)
	if got != "/bin:/usr/bin" {
		t.Errorf("got %q", got)
	}
}

func TestExtraPathDirs(t *testing.T) {
	if d := extraPathDirs("linux", winEnv{ProgramFiles: "x"}, "g"); d != nil {
		t.Errorf("linux: %v", d)
	}
	e := winEnv{ProgramFiles: "PF", UserProfile: "U"}
	got := extraPathDirs("windows", e, "G")
	want := []string{
		filepath.Join("G", "cmd"), filepath.Join("G", "bin"), filepath.Join("G", "usr", "bin"),
		filepath.Join("G", "mingw64", "bin"), filepath.Join("G", "ucrt64", "bin"),
		filepath.Join("PF", "Docker", "Docker", "resources", "bin"), filepath.Join("PF", "Go", "bin"),
		filepath.Join("U", "go", "bin"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v\nwant %v", got, want)
	}
}

func TestFindGitRoot(t *testing.T) {
	pf := filepath.Join("C", "Program Files")
	git := filepath.Join(pf, "Git")
	bash := filepath.Join(git, "bin", "bash.exe")
	// From the git in PATH, wherever it is inside the install.
	for _, exe := range []string{filepath.Join(git, "cmd", "git.exe"), filepath.Join(git, "mingw64", "bin", "git.exe")} {
		if got := findGitRoot(winEnv{GitExe: exe}, fileSet(bash)); got != git {
			t.Errorf("from %s: %q", exe, got)
		}
	}
	// Without git in PATH: the default places.
	local := filepath.Join("L", "Programs", "Git")
	if got := findGitRoot(winEnv{ProgramFiles: pf, LocalAppData: "L"}, fileSet(filepath.Join(local, "bin", "bash.exe"))); got != local {
		t.Errorf("per-user install: %q", got)
	}
	if got := findGitRoot(winEnv{ProgramFiles: pf}, fileSet()); got != "" {
		t.Errorf("no git: %q", got)
	}
}

func TestFindBashNeverWSL(t *testing.T) {
	wsl := func(string) (string, error) { return `C:\Windows\System32\bash.exe`, nil }
	none := func(string) (string, error) { return "", errors.New("not found") }
	git := filepath.Join("G", "bin", "bash.exe")
	if got := findBash("windows", "G", fileSet(git), wsl); got != git {
		t.Errorf("git install: %q", got)
	}
	if got := findBash("windows", "", fileSet(), wsl); got != "" {
		t.Errorf("only WSL's bash: %q, want none", got)
	}
	if got := findBash("windows", "", fileSet(), none); got != "" {
		t.Errorf("no bash: %q", got)
	}
	ok := func(string) (string, error) { return "/usr/bin/bash", nil }
	if got := findBash("linux", "", fileSet(), ok); got != "/usr/bin/bash" {
		t.Errorf("linux: %q", got)
	}
	for p, want := range map[string]bool{
		`C:\Windows\System32\bash.exe`:                            true,
		`c:/windows/system32/bash.exe`:                            true,
		`C:\Users\a\AppData\Local\Microsoft\WindowsApps\bash.exe`: true,
		`C:\Program Files\Git\bin\bash.exe`:                       false,
	} {
		if isWSLBash(p) != want {
			t.Errorf("isWSLBash(%q) != %v", p, want)
		}
	}
}

func TestNeedsRebuild(t *testing.T) {
	clean := launchState{Commit: "abc"}
	cases := []struct {
		name string
		prev *launchState
		cur  launchState
		want bool
	}{
		{"first start", nil, clean, true},
		{"same commit, clean", &launchState{Commit: "abc"}, clean, false},
		{"new commit", &launchState{Commit: "old"}, clean, true},
		{"dirty now", &launchState{Commit: "abc"}, launchState{Commit: "abc", Dirty: true}, true},
		{"dirty before", &launchState{Commit: "abc", Dirty: true}, clean, true},
		{"git unreadable", &launchState{Commit: "abc"}, launchState{}, true},
	}
	for _, c := range cases {
		got, reason := needsRebuild(c.prev, c.cur)
		if got != c.want || reason == "" {
			t.Errorf("%s: got %v (%q), want %v", c.name, got, reason, c.want)
		}
	}
}

func TestStateRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "build", "launcher-state.json")
	if s, err := loadState(path); s != nil || err != nil {
		t.Fatalf("missing file: %v, %v", s, err)
	}
	when := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	if err := saveState(path, launchState{Commit: "abc", Dirty: true}, when); err != nil {
		t.Fatal(err)
	}
	s, err := loadState(path)
	if err != nil || s == nil || s.Commit != "abc" || !s.Dirty || s.StartedAt != "2026-11-23T12:00:00Z" {
		t.Fatalf("got %+v, %v", s, err)
	}
	if err := os.WriteFile(path, []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadState(path); err == nil {
		t.Error("a broken state file must be an error (the caller then rebuilds)")
	}
}

func TestComposeArgs(t *testing.T) {
	got := composeArgs(true, "down")
	want := "compose -f deploy/docker-compose.yml -f deploy/docker-compose.home.yml --env-file deploy/.env.home " +
		"--profile quick-tunnel --profile tunnel --profile monitoring --profile map-pr --profile mail down"
	if strings.Join(got, " ") != want {
		t.Errorf("got  %s\nwant %s", strings.Join(got, " "), want)
	}
	if strings.Join(composeArgs(false, "ps"), " ") != strings.Join(composeFiles, " ")+" ps" {
		t.Errorf("without profiles: %v", composeArgs(false, "ps"))
	}
	// composeArgs must not write into composeFiles' backing array.
	_ = composeArgs(false, "x")
	if composeFiles[len(composeFiles)-1] != "deploy/.env.home" {
		t.Error("composeFiles was modified")
	}
}

// The launcher stops the stack like `make home-down`: the same files and profiles as the
// Makefile and deploy/home.sh, or a worker or tunnel would be left running.
func TestComposeMatchesMakefileAndHomeSh(t *testing.T) {
	root, ok := findRepoRoot(".", isFile)
	if !ok {
		t.Skip("not inside the repo")
	}
	mk, err := os.ReadFile(filepath.Join(root, "Makefile"))
	if err != nil {
		t.Fatal(err)
	}
	if m := regexp.MustCompile(`(?m)^COMPOSE_HOME := (.*)$`).FindSubmatch(mk); m == nil || strings.TrimSpace(string(m[1])) != composeCommandLine() {
		t.Errorf("COMPOSE_HOME of the Makefile differs from %q", composeCommandLine())
	}
	want := profileFlags(homeProfiles)
	if m := regexp.MustCompile(`(?m)^HOME_PROFILES := (.*)$`).FindSubmatch(mk); m == nil || strings.TrimSpace(string(m[1])) != want {
		t.Errorf("HOME_PROFILES of the Makefile differs from %q", want)
	}
	sh, err := os.ReadFile(filepath.Join(root, "deploy", "home.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if m := regexp.MustCompile(`(?m)^ALL_PROFILES=\((.*)\)$`).FindSubmatch(sh); m == nil || strings.TrimSpace(string(m[1])) != want {
		t.Errorf("ALL_PROFILES of deploy/home.sh differs from %q", want)
	}
}

func profileFlags(ps []string) string {
	var b []string
	for _, p := range ps {
		b = append(b, "--profile "+p)
	}
	return strings.Join(b, " ")
}

func TestParseChoice(t *testing.T) {
	cases := []struct {
		in   string
		want action
	}{
		{"1", actOpen}, {" 2 ", actAdmin}, {"3\r", actTunnel}, {"4)", actLogs}, {"5", actResetPassword}, {"6", actStop},
		{"", actNone}, {"7", actNone}, {"0", actNone}, {"abc", actNone}, {"11", actNone},
	}
	for _, c := range cases {
		if got := parseChoice(c.in); got != c.want {
			t.Errorf("parseChoice(%q) = %v, want %v", c.in, got, c.want)
		}
	}
	// Every menu line has its own key and action.
	keys, acts := map[string]bool{}, map[action]bool{}
	for _, it := range menuItems {
		if keys[it.key] || acts[it.act] || it.act == actNone {
			t.Errorf("duplicate or empty menu item %+v", it)
		}
		keys[it.key], acts[it.act] = true, true
		if !strings.Contains(menuText("http://localhost:8080"), it.key+") "+it.label) {
			t.Errorf("menu text lacks %q", it.label)
		}
	}
}

func TestParseYesNo(t *testing.T) {
	type r struct{ yes, ok bool }
	cases := []struct {
		in   string
		def  bool
		want r
	}{
		{"", true, r{true, true}}, {"", false, r{false, true}},
		{"s", false, r{true, true}}, {"Sí", false, r{true, true}}, {"SI", false, r{true, true}}, {"yes", false, r{true, true}},
		{"n", true, r{false, true}}, {" No ", true, r{false, true}},
		{"quizás", true, r{false, false}},
	}
	for _, c := range cases {
		yes, ok := parseYesNo(c.in, c.def)
		if (r{yes, ok}) != c.want {
			t.Errorf("parseYesNo(%q, %v) = %v, %v; want %+v", c.in, c.def, yes, ok, c.want)
		}
	}
}

func TestValidEmail(t *testing.T) {
	for in, want := range map[string]bool{
		"tu@email.com": true, "a.b+c@sub.example.org": true,
		"": false, "sin-arroba": false, "@x.com": false, "a@": false, "a@b": false, "a@b.": false,
		"a@@b.com": false, "a b@c.com": false, "a@b.com; rm": false, "a$(x)@b.com": false,
	} {
		if validEmail(in) != want {
			t.Errorf("validEmail(%q) != %v", in, want)
		}
	}
}

func TestUserErrorReport(t *testing.T) {
	var b strings.Builder
	report(&b, &userError{what: "No pude X", next: "haz Y", err: errors.New("exit status 1")})
	out := b.String()
	for _, want := range []string{"No pude X.", "Detalle técnico: exit status 1", "Qué hacer: haz Y"} {
		if !strings.Contains(out, want) {
			t.Errorf("report lacks %q:\n%s", want, out)
		}
	}
}
