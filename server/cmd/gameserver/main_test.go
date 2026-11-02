package main

import (
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultWorldPath(t *testing.T) {
	t.Setenv("RPG_WORLD", "/srv/rpg/world.bin")
	if got := defaultWorldPath(); got != "/srv/rpg/world.bin" {
		t.Errorf("with RPG_WORLD: %q", got)
	}
	t.Setenv("RPG_WORLD", "")
	if got := defaultWorldPath(); got != filepath.Join("build", "world.bin") {
		t.Errorf("without RPG_WORLD: %q", got)
	}
}

// A missing world.bin names the absolute path that was tried, so running from the wrong
// directory is obvious.
func TestRunReportsAbsoluteWorldPath(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := run(logger, 1, filepath.Join("no", "such", "world.bin"))
	want, _ := filepath.Abs(filepath.Join("no", "such", "world.bin"))
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want it to mention %s", err, want)
	}
}
