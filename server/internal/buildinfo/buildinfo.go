// Package buildinfo exposes version metadata injected at link time.
//
// Release builds set the values with:
//
//	go build -ldflags "-X github.com/GFenzoR/RPG_Project/server/internal/buildinfo.Version=v0.1.0 \
//	  -X github.com/GFenzoR/RPG_Project/server/internal/buildinfo.Commit=abc1234"
package buildinfo

import "fmt"

// Version is the semantic version of the build ("dev" for local builds).
var Version = "dev"

// Commit is the short git SHA of the build ("unknown" for local builds).
var Commit = "unknown"

// String returns a human-readable version line such as "v0.1.0 (abc1234)".
func String() string {
	return fmt.Sprintf("%s (%s)", Version, Commit)
}
