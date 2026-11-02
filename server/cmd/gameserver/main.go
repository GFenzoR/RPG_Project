// Command gameserver runs the game loop, the WebSocket gateway and the HTTP API.
//
// It loads the compiled map (world.bin, built by cmd/mapcompile) and runs the game loop
// until SIGINT/SIGTERM. The network gateway and the HTTP API arrive in T1.3–T1.4.
package main

import (
	"context"
	crand "crypto/rand"
	"encoding/binary"
	"flag"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/GFenzoR/RPG_Project/server/internal/buildinfo"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	seed := flag.Uint64("seed", 0, "random seed for the game loop (0 = random)")
	worldPath := flag.String("world", defaultWorldPath(), "compiled map from mapcompile; default $RPG_WORLD or build/world.bin (empty = run without a world)")
	flag.Parse()

	if *showVersion {
		fmt.Println(buildinfo.String())
		return
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger, *seed, *worldPath); err != nil {
		logger.Error("gameserver stopped", "err", err)
		os.Exit(1)
	}
}

// defaultWorldPath is $RPG_WORLD, or build/world.bin relative to the working directory.
func defaultWorldPath() string {
	if p := os.Getenv("RPG_WORLD"); p != "" {
		return p
	}
	return filepath.Join("build", "world.bin")
}

func run(logger *slog.Logger, seed uint64, worldPath string) error {
	if seed == 0 {
		var b [8]byte
		if _, err := crand.Read(b[:]); err != nil {
			return fmt.Errorf("seed: %w", err)
		}
		seed = binary.LittleEndian.Uint64(b[:])
	}

	if worldPath != "" {
		m, err := world.Load(worldPath)
		if err != nil {
			abs, absErr := filepath.Abs(worldPath)
			if absErr != nil {
				abs = worldPath
			}
			return fmt.Errorf("%w (looked for %s; build it with `make mapcompile`, or use `make run-server`)", err, abs)
		}
		sectors := 0
		for _, is := range m.Islands() {
			sectors += len(is.Sectors())
		}
		logger.Info("world loaded", "path", worldPath, "islands", len(m.Islands()), "sectors", sectors)
		// The map is handed to the game loop's systems with T1.4 (walking).
		_ = m
	}

	loop, err := game.New(game.Config{
		Clock:  clock.Real{},
		Rand:   rand.New(rand.NewPCG(seed, seed)),
		Logger: logger,
	})
	if err != nil {
		return fmt.Errorf("game loop: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logger.Info("gameserver started",
		"version", buildinfo.Version, "commit", buildinfo.Commit,
		"tick_ms", game.TickDuration.Milliseconds(), "seed", seed)
	if err := loop.Run(ctx); err != nil {
		return fmt.Errorf("game loop: %w", err)
	}
	logger.Info("gameserver stopped", "ticks", uint64(loop.Tick()))
	return nil
}
