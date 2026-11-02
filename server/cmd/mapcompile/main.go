// Command mapcompile compiles world/ (chunk JSON + island YAML) and the item definitions in
// data/ into world.bin, the binary map the game server loads at startup
// (docs/03-world-and-maps.md). The same sources always produce the same bytes.
//
//	mapcompile -root . -out build/world.bin
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
)

func main() {
	root := flag.String("root", ".", "repository root (contains world/ and data/)")
	out := flag.String("out", "build/world.bin", "output file")
	flag.Parse()
	if err := run(*root, *out); err != nil {
		fmt.Fprintln(os.Stderr, "mapcompile:", err)
		os.Exit(1)
	}
}

func run(root, out string) error {
	m, err := compile.Compile(root)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	if err := world.Encode(&buf, m); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return fmt.Errorf("create output directory: %w", err)
	}
	tmp := out + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, out); err != nil {
		return fmt.Errorf("write %s: %w", out, err)
	}
	sectors := 0
	for _, is := range m.Islands() {
		sectors += len(is.Sectors())
	}
	fmt.Printf("mapcompile: %d islands, %d sectors, %d bytes → %s\n", len(m.Islands()), sectors, buf.Len(), out)
	return nil
}
