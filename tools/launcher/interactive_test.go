package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// chunk is one Read result of scriptedReader.
type chunk struct {
	data string
	err  error
}

// scriptedReader returns the chunks sent on its channel one Read at a time, like a
// console: a Ctrl+C on Windows can end one read with EOF and the next read still works.
type scriptedReader struct{ ch chan chunk }

func (r *scriptedReader) Read(p []byte) (int, error) {
	c, ok := <-r.ch
	if !ok {
		return 0, io.EOF
	}
	return copy(p, c.data), c.err
}

func newTestPrompter() (*prompter, *scriptedReader, *interrupts) {
	r := &scriptedReader{ch: make(chan chunk)}
	intr := &interrupts{ch: make(chan struct{}, 1)}
	return newPrompter(r, io.Discard, intr), r, intr
}

type askResult struct {
	line string
	err  error
}

func askAsync(p *prompter, q string) chan askResult {
	ch := make(chan askResult, 1)
	go func() {
		line, err := p.ask(q)
		ch <- askResult{line, err}
	}()
	return ch
}

func wait(t *testing.T, ch chan askResult) askResult {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("ask did not return")
		return askResult{}
	}
}

func TestAskReadsALine(t *testing.T) {
	p, r, _ := newTestPrompter()
	res := askAsync(p, "? ")
	r.ch <- chunk{data: "6\r\n"}
	if got := wait(t, res); got.err != nil || got.line != "6" {
		t.Fatalf("got %q, %v", got.line, got.err)
	}
}

func TestCtrlCCutsAQuestionAndThePendingReadAnswersTheNext(t *testing.T) {
	p, r, intr := newTestPrompter()
	res := askAsync(p, "? ")
	intr.ch <- struct{}{}
	if got := wait(t, res); !errors.Is(got.err, errInterrupted) {
		t.Fatalf("Ctrl+C during ask: got %q, %v; want errInterrupted", got.line, got.err)
	}
	// The read started by the first question is still pending: the line typed next
	// answers the second question (no second read is queued in front of it).
	res = askAsync(p, "? ")
	r.ch <- chunk{data: "s\n"}
	if got := wait(t, res); got.err != nil || got.line != "s" {
		t.Fatalf("second question: got %q, %v", got.line, got.err)
	}
}

func TestStaleReadEndedByEOFReadsAgain(t *testing.T) {
	p, r, intr := newTestPrompter()
	res := askAsync(p, "? ")
	intr.ch <- struct{}{}
	if got := wait(t, res); !errors.Is(got.err, errInterrupted) {
		t.Fatalf("got %v", got.err)
	}
	// Windows ends the read the Ctrl+C cut with EOF; the next question must not take that
	// EOF as "stdin closed" but read again.
	res = askAsync(p, "? ")
	r.ch <- chunk{err: io.EOF}
	r.ch <- chunk{data: "n\n"}
	if got := wait(t, res); got.err != nil || got.line != "n" {
		t.Fatalf("got %q, %v", got.line, got.err)
	}
}

func TestEOFFollowedBySignalIsAnInterrupt(t *testing.T) {
	p, r, intr := newTestPrompter()
	res := askAsync(p, "? ")
	r.ch <- chunk{err: io.EOF}
	time.Sleep(eofSignalWindow / 6)
	intr.ch <- struct{}{}
	if got := wait(t, res); !errors.Is(got.err, errInterrupted) {
		t.Fatalf("EOF then Ctrl+C within %s: got %v, want errInterrupted", eofSignalWindow, got.err)
	}
}

func TestEOFAloneIsEOFAndYesNoTakesTheDefault(t *testing.T) {
	p, r, _ := newTestPrompter()
	res := askAsync(p, "? ")
	close(r.ch) // stdin closed for good
	if got := wait(t, res); !errors.Is(got.err, io.EOF) {
		t.Fatalf("got %q, %v; want io.EOF", got.line, got.err)
	}
	for _, def := range []bool{true, false} {
		yes, err := p.yesNo("?", def)
		if err != nil || yes != def {
			t.Errorf("yesNo on closed stdin, def %v: got %v, %v", def, yes, err)
		}
	}
}

func TestYesNoRepeatsUntilAnswerAndStopsOnSecondCtrlC(t *testing.T) {
	p, r, intr := newTestPrompter()
	done := make(chan struct {
		yes bool
		err error
	}, 1)
	go func() {
		yes, err := p.yesNo("?", true)
		done <- struct {
			yes bool
			err error
		}{yes, err}
	}()
	r.ch <- chunk{data: "quizás\n"}
	r.ch <- chunk{data: "n\n"}
	got := <-done
	if got.err != nil || got.yes {
		t.Fatalf("got %v, %v; want no", got.yes, got.err)
	}
	// A Ctrl+C while yesNo waits (the second one of onCtrlC) is an error, not a default.
	go func() {
		yes, err := p.yesNo("?", true)
		done <- struct {
			yes bool
			err error
		}{yes, err}
	}()
	intr.ch <- struct{}{}
	if got := <-done; !errors.Is(got.err, errInterrupted) {
		t.Fatalf("got %v, %v; want errInterrupted", got.yes, got.err)
	}
}

func TestSplitContainers(t *testing.T) {
	out := "rpg-home-gameserver-1\trpg-home\r\nrpg-home-postgres-1\trpg-home\nrpg-dev-postgres\trpg\nsolo\t\n\n"
	home, others := splitContainers(out, homeProject)
	if strings.Join(home, ",") != "rpg-home-gameserver-1,rpg-home-postgres-1" {
		t.Errorf("home = %v", home)
	}
	if strings.Join(others, ",") != "rpg-dev-postgres,solo" {
		t.Errorf("others = %v", others)
	}
	if h, o := splitContainers("", homeProject); h != nil || o != nil {
		t.Errorf("empty output: %v, %v", h, o)
	}
}

// homeProject must be the compose project of the home stack, or the launcher would take
// its own containers for someone else's.
func TestHomeProjectMatchesCompose(t *testing.T) {
	root, ok := findRepoRoot(".", isFile)
	if !ok {
		t.Skip("not inside the repo")
	}
	b, err := os.ReadFile(filepath.Join(root, "deploy", "docker-compose.home.yml"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^name:\s*(\S+)\s*$`).FindSubmatch(b)
	if m == nil || string(m[1]) != homeProject {
		t.Errorf("name: of deploy/docker-compose.home.yml is not %q", homeProject)
	}
}

func TestFreeQuestion(t *testing.T) {
	q, def := freeQuestion(nil, true)
	if !def || !strings.Contains(q, "todas las distros de WSL") {
		t.Errorf("only the game's containers: default yes and the WSL warning; got %v, %q", def, q)
	}
	q, def = freeQuestion([]string{"rpg-dev-postgres"}, true)
	if def || !strings.Contains(q, "rpg-dev-postgres") {
		t.Errorf("other containers: default no and their names; got %v, %q", def, q)
	}
	if _, def = freeQuestion(nil, false); def {
		t.Error("docker could not list the containers: default no")
	}
}

func TestWaitHealthyStopsOnCtrlC(t *testing.T) {
	start := time.Now()
	// Port 1 refuses at once; the stop must end the wait long before the limit.
	err := waitHealthy("http://127.0.0.1:1", time.Minute, func() bool { return true })
	if !errors.Is(err, errInterrupted) {
		t.Fatalf("got %v, want errInterrupted", err)
	}
	if time.Since(start) > 10*time.Second {
		t.Errorf("took %s", time.Since(start))
	}
}
