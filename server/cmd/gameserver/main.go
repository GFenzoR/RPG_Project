// Command gameserver runs the game loop, the WebSocket gateway and the HTTP API.
//
// T1.1: it only runs the empty game loop until SIGINT/SIGTERM. The world, the network
// gateway and the HTTP API arrive in T1.2–T1.4.
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
	"syscall"

	"github.com/GFenzoR/RPG_Project/server/internal/buildinfo"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
)

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	seed := flag.Uint64("seed", 0, "random seed for the game loop (0 = random)")
	flag.Parse()

	if *showVersion {
		fmt.Println(buildinfo.String())
		return
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger, *seed); err != nil {
		logger.Error("gameserver stopped", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger, seed uint64) error {
	if seed == 0 {
		var b [8]byte
		if _, err := crand.Read(b[:]); err != nil {
			return fmt.Errorf("seed: %w", err)
		}
		seed = binary.LittleEndian.Uint64(b[:])
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
