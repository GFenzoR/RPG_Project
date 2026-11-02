// Package migrations embeds the goose SQL migrations so the server binary can apply
// them on start without the files on disk.
package migrations

import "embed"

// FS holds every *.sql migration in this directory.
//
//go:embed *.sql
var FS embed.FS
