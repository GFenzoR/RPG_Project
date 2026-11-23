package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ---- repo discovery --------------------------------------------------------

// findRepoRoot walks up from start until a directory holds both Makefile and
// deploy/home.sh.
func findRepoRoot(start string, isFile func(string) bool) (string, bool) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", false
	}
	for {
		if isFile(filepath.Join(dir, "Makefile")) && isFile(filepath.Join(dir, "deploy", "home.sh")) {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

// locateRepo looks from the exe's folder first (double click), then the working dir
// (`go run`, a terminal in the repo).
func locateRepo() (string, error) {
	var starts []string
	if exe, err := os.Executable(); err == nil {
		if r, err := filepath.EvalSymlinks(exe); err == nil {
			exe = r
		}
		starts = append(starts, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	for _, s := range starts {
		if root, ok := findRepoRoot(s, isFile); ok {
			return root, nil
		}
	}
	return "", &userError{
		what: "No encontré la carpeta del juego (la que tiene el Makefile y deploy/home.sh)",
		next: "deja NequesRealm-Servidor.exe dentro de la carpeta del proyecto (por ejemplo " +
			"C:\\ProyectosVSCode\\RPG_Project) y ábrelo desde ahí; un acceso directo en el escritorio también sirve",
	}
}

// envValue is the value of KEY in an env file, like env_get of deploy/home.sh: the last
// active "KEY=" line wins; comments and CR are ignored.
func envValue(content, key string) string {
	val := ""
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimRight(line, "\r")
		if v, ok := strings.CutPrefix(line, key+"="); ok {
			val = v
		}
	}
	return val
}

// homePort is HOME_HTTP_PORT of deploy/.env.home, 8080 by default (as the compose file).
func homePort(envContent string) string {
	if p := strings.TrimSpace(envValue(envContent, "HOME_HTTP_PORT")); p != "" {
		return p
	}
	return "8080"
}

// ---- PATH and bash -----------------------------------------------------------

// winEnv holds the environment values that locate the usual Windows tools.
type winEnv struct {
	ProgramFiles    string
	ProgramFilesX86 string
	LocalAppData    string
	UserProfile     string
	GitExe          string // git found in PATH, if any
}

func currentEnv() winEnv {
	e := winEnv{
		ProgramFiles:    os.Getenv("ProgramFiles"),
		ProgramFilesX86: os.Getenv("ProgramFiles(x86)"),
		LocalAppData:    os.Getenv("LOCALAPPDATA"),
		UserProfile:     os.Getenv("USERPROFILE"),
	}
	if p, err := lookPath("git"); err == nil {
		e.GitExe = p
	}
	return e
}

// findGitRoot is the install folder of Git for Windows (the one with bin/bash.exe), or "".
// It tries the folder of the git in PATH (…\Git\cmd\git.exe, …\Git\mingw64\bin\git.exe),
// then the default install places.
func findGitRoot(e winEnv, isFile func(string) bool) string {
	var cands []string
	if e.GitExe != "" {
		d := filepath.Dir(e.GitExe)
		for range 3 {
			d = filepath.Dir(d)
			cands = append(cands, d)
		}
	}
	for _, base := range []string{e.ProgramFiles, e.ProgramFilesX86} {
		if base != "" {
			cands = append(cands, filepath.Join(base, "Git"))
		}
	}
	if e.LocalAppData != "" {
		cands = append(cands, filepath.Join(e.LocalAppData, "Programs", "Git"))
	}
	for _, c := range cands {
		if isFile(filepath.Join(c, "bin", "bash.exe")) {
			return c
		}
	}
	return ""
}

// extraPathDirs are the folders a double-clicked process needs in PATH: Git for Windows
// (bash, git and the coreutils of the scripts), Docker's CLI and Go. Nothing elsewhere:
// a terminal on Linux or macOS already has them.
func extraPathDirs(goos string, e winEnv, gitRoot string) []string {
	if goos != "windows" {
		return nil
	}
	var dirs []string
	if gitRoot != "" {
		for _, sub := range [][]string{{"cmd"}, {"bin"}, {"usr", "bin"}, {"mingw64", "bin"}, {"ucrt64", "bin"}} {
			dirs = append(dirs, filepath.Join(append([]string{gitRoot}, sub...)...))
		}
	}
	if e.ProgramFiles != "" {
		dirs = append(dirs,
			filepath.Join(e.ProgramFiles, "Docker", "Docker", "resources", "bin"),
			filepath.Join(e.ProgramFiles, "Go", "bin"))
	}
	if e.UserProfile != "" {
		dirs = append(dirs, filepath.Join(e.UserProfile, "go", "bin"))
	}
	return dirs
}

// prependPath puts the existing dirs first, in order, and keeps the rest of current
// without duplicates (compared without case: Windows paths). A dir already in current
// moves to the front, so Git's bash wins over C:\Windows\System32\bash.exe (WSL).
func prependPath(current string, dirs []string, sep string, exists func(string) bool) string {
	var out []string
	seen := map[string]bool{}
	add := func(d string) {
		k := strings.ToLower(strings.TrimRight(d, `\/`))
		if d == "" || seen[k] {
			return
		}
		seen[k] = true
		out = append(out, d)
	}
	for _, d := range dirs {
		if exists(d) {
			add(d)
		}
	}
	for _, d := range strings.Split(current, sep) {
		add(d)
	}
	return strings.Join(out, sep)
}

// isWSLBash tells the bash.exe of WSL (System32, WindowsApps) from Git's: WSL's runs the
// script inside Linux, without Docker Desktop's CLI or the repo's Windows paths.
func isWSLBash(p string) bool {
	l := strings.ToLower(strings.ReplaceAll(p, "/", `\`))
	return strings.Contains(l, `\windows\system32\`) || strings.Contains(l, `\windows\sysnative\`) ||
		strings.Contains(l, `\windowsapps\`)
}

// findBash is Git for Windows' bash on Windows (never WSL's), the PATH bash elsewhere.
func findBash(goos, gitRoot string, isFile func(string) bool, look func(string) (string, error)) string {
	if goos == "windows" {
		if gitRoot != "" {
			for _, p := range []string{filepath.Join(gitRoot, "bin", "bash.exe"), filepath.Join(gitRoot, "usr", "bin", "bash.exe")} {
				if isFile(p) {
					return p
				}
			}
		}
		if p, err := look("bash"); err == nil && !isWSLBash(p) {
			return p
		}
		return ""
	}
	if p, err := look("bash"); err == nil {
		return p
	}
	return ""
}

// ---- rebuild decision ------------------------------------------------------

// launchState is what the last successful start ran (build/launcher-state.json).
type launchState struct {
	Commit    string `json:"commit"`
	Dirty     bool   `json:"dirty"`
	StartedAt string `json:"started_at,omitempty"`
}

// needsRebuild decides whether `home.sh up` builds the images (BUILD=1) and says why in
// Spanish. Without a reliable answer it rebuilds: a stale image is worse than a slow start.
func needsRebuild(prev *launchState, cur launchState) (bool, string) {
	switch {
	case prev == nil:
		return true, "primer arranque con este lanzador"
	case cur.Commit == "":
		return true, "no pude leer la versión del código con git"
	case cur.Dirty:
		return true, "hay cambios sin commitear en el código"
	case prev.Dirty:
		return true, "el arranque anterior tenía cambios sin commitear"
	case prev.Commit != cur.Commit:
		return true, "el código cambió desde el último arranque"
	default:
		return false, "el código no cambió desde el último arranque"
	}
}

// loadState reads the state file; (nil, nil) when it does not exist yet.
func loadState(path string) (*launchState, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var s launchState
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return &s, nil
}

func saveState(path string, s launchState, now time.Time) error {
	s.StartedAt = now.UTC().Format(time.RFC3339)
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("encode state: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// ---- compose ---------------------------------------------------------------

// homeProfiles are every optional profile of the home stack: HOME_PROFILES of the Makefile
// and ALL_PROFILES of deploy/home.sh (a test keeps the three equal). With --profile flags
// compose ignores COMPOSE_PROFILES, so down must name them all.
var homeProfiles = []string{"quick-tunnel", "tunnel", "monitoring", "map-pr", "mail"}

// composeFiles is COMPOSE_HOME of the Makefile without the leading "docker".
var composeFiles = []string{
	"compose", "-f", "deploy/docker-compose.yml", "-f", "deploy/docker-compose.home.yml",
	"--env-file", "deploy/.env.home",
}

// composeArgs are the docker arguments for a compose command on the home stack.
func composeArgs(allProfiles bool, args ...string) []string {
	out := append([]string{}, composeFiles...)
	if allProfiles {
		for _, p := range homeProfiles {
			out = append(out, "--profile", p)
		}
	}
	return append(out, args...)
}

// homeProject is the compose project name of the home stack (`name:` of
// deploy/docker-compose.home.yml; a test keeps them equal).
const homeProject = "rpg-home"

// splitContainers splits the lines "<name><TAB><compose project>" of docker ps into the
// containers of project and the rest.
func splitContainers(psOut, project string) (home, others []string) {
	for _, line := range strings.Split(psOut, "\n") {
		name, proj, _ := strings.Cut(strings.TrimRight(line, "\r"), "\t")
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if strings.TrimSpace(proj) == project {
			home = append(home, name)
		} else {
			others = append(others, name)
		}
	}
	return home, others
}

// composeCommandLine is the COMPOSE variable deploy/home-tunnel.sh expects.
func composeCommandLine() string {
	return "docker " + strings.Join(composeFiles, " ")
}

// ---- menu --------------------------------------------------------------------

type action int

const (
	actNone action = iota
	actOpen
	actAdmin
	actTunnel
	actLogs
	actResetPassword
	actStop
)

var menuItems = []struct {
	key   string
	act   action
	label string
}{
	{"1", actOpen, "Abrir el juego en el navegador"},
	{"2", actAdmin, "Hacerme admin (te pide tu email)"},
	{"3", actTunnel, "Link para invitar amigos por internet"},
	{"4", actLogs, "Ver los registros (logs) del servidor"},
	{"5", actResetPassword, "Enlace para recuperar una contraseña"},
	{"6", actStop, "Detener el servidor y salir"},
}

func menuText(url string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\n==================== Neque's Realm ====================\n")
	fmt.Fprintf(&b, "  El servidor está encendido en %s\n\n", url)
	for _, it := range menuItems {
		fmt.Fprintf(&b, "  %s) %s\n", it.key, it.label)
	}
	fmt.Fprintf(&b, "\n  (Ctrl+C también sale. Cerrar la ventana deja el servidor encendido.)\n")
	return b.String()
}

// parseChoice maps a menu answer to its action (actNone when it is not one).
func parseChoice(s string) action {
	s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), ")"))
	for _, it := range menuItems {
		if s == it.key {
			return it.act
		}
	}
	return actNone
}

// parseYesNo reads a yes/no answer; empty takes def. ok is false for anything else.
func parseYesNo(s string, def bool) (yes, ok bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "":
		return def, true
	case "s", "si", "sí", "y", "yes":
		return true, true
	case "n", "no":
		return false, true
	}
	return false, false
}

// validEmail is a sanity check before the email goes to the server's admin command,
// which looks the account up and gives the final answer.
func validEmail(s string) bool {
	// No glob or brace characters either: the MSYS runtime of bash expands them in the
	// arguments it gets from Windows, so the email could change on its way to the server.
	if len(s) > 254 || strings.ContainsAny(s, " \t\"'<>,;\\`$*?[]{}~") {
		return false
	}
	local, domain, ok := strings.Cut(s, "@")
	if !ok || local == "" || strings.Contains(domain, "@") {
		return false
	}
	dot := strings.LastIndex(domain, ".")
	return dot > 0 && dot < len(domain)-1
}
