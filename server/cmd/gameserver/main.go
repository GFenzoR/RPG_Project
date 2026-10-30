// Command gameserver runs the game loop, the WebSocket gateway and the HTTP API.
//
// This is the T0.1 skeleton: it only reports its version. The game loop arrives in T1.1.
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"

	"github.com/GFenzoR/RPG_Project/server/internal/buildinfo"
)

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(buildinfo.String())
		return
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	logger.Info("gameserver skeleton: nothing to run yet", "version", buildinfo.Version, "commit", buildinfo.Commit)
}
