package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/user"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// adminStore is what the operator's commands need. *store.Store implements it.
type adminStore interface {
	SetRole(ctx context.Context, email, role string, audit store.AuditEntry) (int64, string, error)
	ListAudit(ctx context.Context, n int) ([]store.AuditEntry, error)
	Close()
}

const adminUsage = `usage: gameserver admin <command> [flags]   (DATABASE_URL must be set)

commands:
  set-role -email <email> -role player|gm|admin -note <why>
      Sets an account's role (T2.6). Recorded in the audit log. Takes effect on the
      character's next login: to remove powers right away, kick it from the game too.
  audit [-n 50]
      Prints the newest audit log entries.
`

// runAdmin runs "gameserver admin ..." and returns the exit code.
func runAdmin(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, adminUsage)
		return 2
	}
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		fmt.Fprintln(stderr, "DATABASE_URL is required")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	open := func() (adminStore, error) { return store.Open(ctx, url) }
	if err := adminCommand(ctx, args, open, stdout, operatorName(), clock.Real{}.Now); err != nil {
		fmt.Fprintln(stderr, err)
		if errors.Is(err, errUsage) {
			fmt.Fprint(stderr, adminUsage)
			return 2
		}
		return 1
	}
	return 0
}

var errUsage = errors.New("invalid arguments")

// adminCommand parses and runs one operator command against the store open returns.
func adminCommand(ctx context.Context, args []string, open func() (adminStore, error), out io.Writer, operator string, now func() time.Time) error {
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	switch args[0] {
	case "set-role":
		email := fs.String("email", "", "account email")
		role := fs.String("role", "", "player, gm or admin")
		note := fs.String("note", "", "why (kept in the audit log)")
		if err := fs.Parse(args[1:]); err != nil || fs.NArg() > 0 {
			return errUsage
		}
		norm, ok := auth.NormalizeEmail(*email)
		if !ok || !store.ValidRole(*role) || strings.TrimSpace(*note) == "" {
			return fmt.Errorf("%w: -email, -role (player, gm, admin) and -note are required", errUsage)
		}
		st, err := open()
		if err != nil {
			return err
		}
		defer st.Close()
		id, old, err := st.SetRole(ctx, norm, *role, store.AuditEntry{
			At:        now(),
			Source:    store.AuditCLI,
			ActorName: operator,
			Args:      map[string]string{"note": strings.TrimSpace(*note)},
			Result:    store.ResultOK,
		})
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("no account with email %s", norm)
		}
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "account %d (%s): role %s -> %s\n", id, norm, old, *role)
		return nil
	case "audit":
		n := fs.Int("n", 50, "entries")
		if err := fs.Parse(args[1:]); err != nil || fs.NArg() > 0 {
			return errUsage
		}
		st, err := open()
		if err != nil {
			return err
		}
		defer st.Close()
		es, err := st.ListAudit(ctx, *n)
		if err != nil {
			return err
		}
		for _, e := range es {
			fmt.Fprintf(out, "%s %-4s %-20s %-12s %-20s %-10s %v\n", e.At.UTC().Format(time.RFC3339),
				e.Source, e.ActorName, e.Action, e.TargetName, e.Result, e.Args)
		}
		return nil
	default:
		return fmt.Errorf("%w: unknown command %q", errUsage, args[0])
	}
}

// operatorName names the operator in the audit log: the OS user running the tool.
func operatorName() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return "cli:" + u.Username
	}
	return "cli:unknown"
}
