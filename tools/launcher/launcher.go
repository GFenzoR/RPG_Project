package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// userError is a failure told in plain Spanish: what failed and what to do next.
type userError struct {
	what string // "No pude ..." sentence
	next string // the next step for the owner
	err  error  // the technical cause, if any
}

func (e *userError) Error() string {
	if e.err != nil {
		return e.what + ": " + e.err.Error()
	}
	return e.what
}

func (e *userError) Unwrap() error { return e.err }

// report prints an error the way the owner reads it.
func report(w io.Writer, err error) {
	var ue *userError
	if errors.As(err, &ue) {
		fmt.Fprintf(w, "\n[!] %s.\n", ue.what)
		if ue.err != nil {
			fmt.Fprintf(w, "    Detalle técnico: %v\n", ue.err)
		}
		if ue.next != "" {
			fmt.Fprintf(w, "    Qué hacer: %s\n", ue.next)
		}
		return
	}
	fmt.Fprintf(w, "\n[!] Algo falló: %v\n", err)
}

// launcher holds what every step needs: the repo, the shell and where to print.
type launcher struct {
	root string    // repo root (Makefile + deploy/home.sh)
	bash string    // bash of Git for Windows, or the system bash elsewhere
	out  io.Writer // progress messages
}

// prepare finds the repo, fixes PATH for a double-clicked process and finds bash.
func prepare(out io.Writer) (*launcher, error) {
	root, err := locateRepo()
	if err != nil {
		return nil, err
	}
	e := currentEnv()
	gitRoot := findGitRoot(e, isFile)
	dirs := extraPathDirs(runtime.GOOS, e, gitRoot)
	if err := os.Setenv("PATH", prependPath(os.Getenv("PATH"), dirs, string(os.PathListSeparator), isDir)); err != nil {
		return nil, fmt.Errorf("set PATH: %w", err)
	}
	// Git Bash rewrites arguments that look like POSIX paths (/app/gameserver) when it
	// calls a Windows program such as docker.exe; the scripts need them as written.
	_ = os.Setenv("MSYS_NO_PATHCONV", "1")
	_ = os.Setenv("MSYS2_ARG_CONV_EXCL", "*")
	bash := findBash(runtime.GOOS, gitRoot, isFile, lookPath)
	if bash == "" {
		next := "instala bash y vuelve a intentarlo"
		if runtime.GOOS == "windows" {
			next = "instala Git para Windows (https://git-scm.com/download/win, o en PowerShell: winget install Git.Git) y vuelve a abrir el lanzador"
		}
		return nil, &userError{what: "No encontré bash (Git Bash)", next: next}
	}
	return &launcher{root: root, bash: bash, out: out}, nil
}

// script runs a bash script of the repo with its output on the console.
func (l *launcher) script(env []string, args ...string) error {
	c := exec.Command(l.bash, args...)
	c.Dir = l.root
	c.Env = append(os.Environ(), env...)
	c.Stdout, c.Stderr = os.Stdout, os.Stderr
	return c.Run()
}

// docker runs a docker command in the repo with its output on the console.
func (l *launcher) docker(args ...string) error {
	c := exec.Command("docker", args...)
	c.Dir = l.root
	c.Stdout, c.Stderr = os.Stdout, os.Stderr
	return c.Run()
}

func (l *launcher) envFile() string { return filepath.Join(l.root, "deploy", ".env.home") }

func (l *launcher) baseURL() string {
	b, _ := os.ReadFile(l.envFile()) // missing file: default port
	return "http://localhost:" + homePort(string(b))
}

func (l *launcher) statePath() string { return filepath.Join(l.root, "build", "launcher-state.json") }

// gitState reads HEAD and whether the tree has uncommitted changes. An empty Commit
// means git could not tell (the caller then rebuilds).
func (l *launcher) gitState() launchState {
	head, err := exec.Command("git", "-C", l.root, "rev-parse", "HEAD").Output()
	if err != nil {
		return launchState{}
	}
	st, err := exec.Command("git", "-C", l.root, "status", "--porcelain").Output()
	if err != nil {
		return launchState{}
	}
	return launchState{Commit: strings.TrimSpace(string(head)), Dirty: strings.TrimSpace(string(st)) != ""}
}

// up starts the home stack through deploy/home.sh and waits until it answers. stop, when
// not nil, is polled while waiting for Docker (the owner pressed Ctrl+C).
func (l *launcher) up(forceBuild bool, stop func() bool) (string, error) {
	if err := l.ensureDocker(stop); err != nil {
		return "", err
	}
	cur := l.gitState()
	prev, _ := loadState(l.statePath()) // unreadable state: like a first start
	rebuild, reason := needsRebuild(prev, cur)
	if forceBuild {
		rebuild, reason = true, "lo pediste con --rebuild"
	}
	build := "0"
	if rebuild {
		build = "1"
		fmt.Fprintf(l.out, "\n>> Construyendo el servidor (%s). La primera vez tarda varios minutos...\n\n", reason)
	} else {
		fmt.Fprintf(l.out, "\n>> Arrancando sin reconstruir (%s)...\n\n", reason)
	}
	if err := l.script([]string{"BUILD=" + build}, "deploy/home.sh", "up"); err != nil {
		return "", &userError{
			what: "El servidor no pudo arrancar",
			next: "lee los mensajes de arriba. Si dicen 'port is already allocated', otro programa usa el puerto 8080: " +
				"cámbialo con HOME_HTTP_PORT en deploy/.env.home. Si no, vuelve a abrir el lanzador; si sigue " +
				"fallando, mira docs/13-hosting-de-pruebas.md, \"Problemas comunes\"",
			err: err,
		}
	}
	url := l.baseURL()
	if err := waitHealthy(url, 90*time.Second); err != nil {
		return "", &userError{
			what: "El servidor arrancó pero no responde en " + url,
			next: "espera un minuto y elige \"Ver los registros\" en el menú, o vuelve a abrir el lanzador",
			err:  err,
		}
	}
	if err := saveState(l.statePath(), cur, time.Now()); err != nil {
		fmt.Fprintf(l.out, "(aviso: no pude guardar %s: %v)\n", l.statePath(), err)
	}
	fmt.Fprintf(l.out, "\n>> Listo: el juego está en %s\n", url)
	return url, nil
}

// down stops the home stack like `make home-down`: same compose files and profiles.
func (l *launcher) down() error {
	if !l.dockerRunning() {
		fmt.Fprintln(l.out, "Docker no está corriendo: el servidor ya está detenido.")
		return nil
	}
	if !isFile(l.envFile()) {
		fmt.Fprintln(l.out, "El servidor nunca se arrancó en este PC (no hay deploy/.env.home): nada que detener.")
		return nil
	}
	fmt.Fprintln(l.out, "\n>> Deteniendo el servidor (tus datos se conservan)...")
	if err := l.docker(composeArgs(true, "down")...); err != nil {
		return &userError{
			what: "No pude detener el servidor",
			next: "abre Docker Desktop, busca el grupo rpg-home y detenlo con el botón de stop",
			err:  err,
		}
	}
	fmt.Fprintln(l.out, ">> Servidor detenido.")
	return nil
}

// status prints whether Docker, the containers and the game answer; true when healthy.
func (l *launcher) status() bool {
	if !l.dockerRunning() {
		fmt.Fprintln(l.out, "Docker no está corriendo: el servidor está detenido.")
		return false
	}
	if !isFile(l.envFile()) {
		fmt.Fprintln(l.out, "El servidor nunca se arrancó en este PC (no hay deploy/.env.home).")
		return false
	}
	_ = l.docker(composeArgs(true, "ps")...) // informative only
	url := l.baseURL()
	if httpOK(url + "/healthz") {
		fmt.Fprintf(l.out, "\nEl servidor está corriendo y responde en %s\n", url)
		return true
	}
	fmt.Fprintf(l.out, "\nEl servidor no responde en %s\n", url)
	return false
}

// lookPath is exec.LookPath (a variable for the tests of findBash's callers).
var lookPath = exec.LookPath

var healthClient = &http.Client{Timeout: 5 * time.Second}

func httpOK(url string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	resp, err := healthClient.Do(req)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func waitHealthy(base string, limit time.Duration) error {
	deadline := time.Now().Add(limit)
	for {
		if httpOK(base + "/healthz") {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("GET %s/healthz did not answer 200 in %s", base, limit)
		}
		time.Sleep(2 * time.Second)
	}
}

// openBrowser opens url in the default browser; failures are only reported.
// LAUNCHER_NO_BROWSER=1 skips it (scripted runs of the interactive mode).
func openBrowser(url string) {
	if os.Getenv("LAUNCHER_NO_BROWSER") == "1" {
		fmt.Fprintf(os.Stdout, "(LAUNCHER_NO_BROWSER=1: no abro %s)\n", url)
		return
	}
	var c *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		c = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		c = exec.Command("open", url)
	default:
		c = exec.Command("xdg-open", url)
	}
	if err := c.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "No pude abrir el navegador (%v): abre %s a mano.\n", err, url)
		return
	}
	go func() { _ = c.Wait() }()
}

func isFile(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}
