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
	RoleCandidate(ctx context.Context, email string) (store.RoleCandidate, error)
	SetRole(ctx context.Context, email, role string, audit store.AuditEntry) (int64, string, error)
	ListAudit(ctx context.Context, n int) ([]store.AuditEntry, error)
	OpenReports(ctx context.Context, n int) ([]store.Report, error)
	auth.ResetLinkRepo
	AppendAudit(ctx context.Context, e store.AuditEntry) error
	Close()
}

const adminUsage = `usage: gameserver admin <command> [flags]   (DATABASE_URL must be set)

commands:
  set-role -email <email> -role player|gm|admin -note <why> [-allow-unverified]
      Sets an account's role (T2.6), revokes its tokens and records it in the audit log.
      A role taken away reaches the account's online characters within ~5 s; a new or
      higher role applies from the next login. It first prints the account (id, created,
      email verification, verified Google/Discord, last login, characters). Raising an
      account above player needs a verified email or a verified OAuth identity, so
      whoever registered someone else's address first cannot be made staff; check the
      printed account is the right person and pass -allow-unverified to override
      (exit code 3 when refused for this).
  audit [-n 50]
      Prints the newest audit log entries.
  reset-link -email <email> [-public-url https://example.com]
      Prints a single-use password reset link (valid 1 hour) for the account, for when
      the server has no SMTP (T2.1). Hand it to the owner by a channel you trust: whoever
      has it can take the account. The link is not logged; issuing it is audited.
      -public-url defaults to $PUBLIC_URL (the website's address).
  reports [-n 20]
      Prints the oldest open player reports (T4.1) with the context the server attached
      (positions and the reported character's recent events). GMs close them in the
      game with /closereport.
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
		if errors.Is(err, errUnverified) {
			return exitUnverified
		}
		return 1
	}
	return 0
}

var errUsage = errors.New("invalid arguments")

// errUnverified: set-role refused to raise an account that never proved its email.
var errUnverified = errors.New("refused: this account never proved it owns its email")

// exitUnverified is the exit code for errUnverified, so scripts (deploy/home.sh, the
// launcher) can show the account and ask before retrying with -allow-unverified.
const exitUnverified = 3

// adminCommand parses and runs one operator command against the store open returns.
func adminCommand(ctx context.Context, args []string, open func() (adminStore, error), out io.Writer, operator string, now func() time.Time) error {
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	switch args[0] {
	case "set-role":
		email := fs.String("email", "", "account email")
		role := fs.String("role", "", "player, gm or admin")
		note := fs.String("note", "", "why (kept in the audit log)")
		allowUnverified := fs.Bool("allow-unverified", false, "raise an account without a verified email or OAuth identity")
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
		c, err := st.RoleCandidate(ctx, norm)
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("no account with email %s", norm)
		}
		if err != nil {
			return err
		}
		printCandidate(out, norm, c)
		if store.RoleRank(*role) > store.RoleRank(store.RolePlayer) && !c.Proven() {
			if !*allowUnverified {
				return fmt.Errorf("%w: anyone can register an address that is not theirs. Ask the owner to confirm the "+
					"email (needs SMTP) or link Google/Discord, or, if the account above (created date, characters) "+
					"is surely theirs, run again with -allow-unverified", errUnverified)
			}
			fmt.Fprintln(out, "warning: unverified account raised with -allow-unverified")
		}
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
		if store.RoleRank(*role) < store.RoleRank(old) {
			fmt.Fprintln(out, "online characters of this account lose the role within ~5 s")
		} else if *role != old {
			fmt.Fprintln(out, "the new role applies from the character's next login")
		}
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
	case "reset-link":
		email := fs.String("email", "", "account email")
		public := fs.String("public-url", os.Getenv("PUBLIC_URL"), "website base URL")
		if err := fs.Parse(args[1:]); err != nil || fs.NArg() > 0 {
			return errUsage
		}
		if _, ok := auth.NormalizeEmail(*email); !ok {
			return fmt.Errorf("%w: -email is required", errUsage)
		}
		if _, err := auth.CheckPublicURL(*public); err != nil {
			return fmt.Errorf("%w: set -public-url or PUBLIC_URL to the website's address (%w)", errUsage, err)
		}
		st, err := open()
		if err != nil {
			return err
		}
		defer st.Close()
		link, p, err := auth.IssueResetLink(ctx, st, now(), *public, *email)
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("no account with that email")
		}
		if err != nil {
			return err
		}
		if err := st.AppendAudit(ctx, store.AuditEntry{
			At: now(), Source: store.AuditCLI, ActorName: operator,
			Action: store.AuditResetLinkIssue, TargetAccountID: p.ID, Result: store.ResultOK,
		}); err != nil {
			return err
		}
		fmt.Fprintf(out, "account %d (%s): password reset link, valid for 1 hour and one use:\n%s\n", p.ID, p.Email, link)
		if !p.EmailVerified {
			fmt.Fprintln(out, "note: this account has not verified its email")
		}
		return nil
	case "reports":
		n := fs.Int("n", 20, "reports")
		if err := fs.Parse(args[1:]); err != nil || fs.NArg() > 0 {
			return errUsage
		}
		st, err := open()
		if err != nil {
			return err
		}
		defer st.Close()
		rs, err := st.OpenReports(ctx, *n)
		if err != nil {
			return err
		}
		for _, r := range rs {
			fmt.Fprintf(out, "#%d %s %s reported %s: %q\n    %s\n", r.ID, r.At.UTC().Format(time.RFC3339),
				r.ReporterName, r.TargetName, r.Reason, r.Context)
		}
		if len(rs) == 0 {
			fmt.Fprintln(out, "no open reports")
		}
		return nil
	default:
		return fmt.Errorf("%w: unknown command %q", errUsage, args[0])
	}
}

// printCandidate shows who the account behind the email is before set-role writes.
func printCandidate(out io.Writer, email string, c store.RoleCandidate) {
	when := func(t time.Time) string {
		if t.IsZero() {
			return "never"
		}
		return t.UTC().Format(time.RFC3339)
	}
	oauth := "none"
	if len(c.VerifiedProviders) > 0 {
		oauth = strings.Join(c.VerifiedProviders, ", ")
	}
	chars := "none"
	if len(c.Characters) > 0 {
		chars = strings.Join(c.Characters, ", ")
	}
	fmt.Fprintf(out, "account %d (%s), role %s\n", c.ID, email, c.Role)
	fmt.Fprintf(out, "  created:         %s\n", when(c.CreatedAt))
	fmt.Fprintf(out, "  email verified:  %s\n", when(c.EmailVerifiedAt))
	fmt.Fprintf(out, "  verified OAuth:  %s\n", oauth)
	fmt.Fprintf(out, "  last login:      %s\n", when(c.LastLoginAt))
	fmt.Fprintf(out, "  characters:      %s\n", chars)
	if c.Disabled {
		fmt.Fprintln(out, "  DISABLED account")
	}
}

// operatorName names the operator in the audit log: the OS user running the tool.
func operatorName() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return "cli:" + u.Username
	}
	return "cli:unknown"
}
