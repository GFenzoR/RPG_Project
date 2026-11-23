package main

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"testing"
)

// The test binary doubles as a child process that exits with LAUNCHER_HELPER_EXIT.
func TestMain(m *testing.M) {
	if code := os.Getenv("LAUNCHER_HELPER_EXIT"); code != "" {
		n, _ := strconv.Atoi(code)
		os.Exit(n)
	}
	os.Exit(m.Run())
}

func helperExit(t *testing.T, code int) error {
	t.Helper()
	c := exec.Command(os.Args[0], "-test.run=^$")
	c.Env = append(os.Environ(), "LAUNCHER_HELPER_EXIT="+strconv.Itoa(code))
	return c.Run()
}

// "Hacerme admin" asks the owner and retries only on set-role's "unverified" refusal.
func TestExitCode(t *testing.T) {
	if got := exitCode(nil); got != 0 {
		t.Errorf("nil: %d", got)
	}
	if got := exitCode(helperExit(t, exitUnverified)); got != exitUnverified {
		t.Errorf("unverified refusal: %d", got)
	}
	if got := exitCode(helperExit(t, 1)); got != 1 {
		t.Errorf("other failure: %d", got)
	}
	if got := exitCode(errors.New("bash not found")); got != -1 {
		t.Errorf("not run: %d", got)
	}
}
