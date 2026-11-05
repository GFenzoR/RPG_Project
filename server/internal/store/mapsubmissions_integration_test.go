//go:build integration

package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// Map submissions (T4.5): limits, roles, the moderation decision and its audit.
func TestMapSubmissions(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_map_submissions"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)

	account := func(email, role string, age time.Duration) (int64, int64) {
		t.Helper()
		var acc, char int64
		err := conn.QueryRow(ctx, `INSERT INTO accounts (email, role, created_at) VALUES ($1, $2, $3) RETURNING id`,
			email, role, now.Add(-age)).Scan(&acc)
		if err != nil {
			t.Fatal(err)
		}
		err = conn.QueryRow(ctx, `INSERT INTO characters (account_id, name, vocation, health, mana)
			VALUES ($1, $2, 'druid', 100, 10) RETURNING id`, acc, "Char "+strings.Split(email, "@")[0]).Scan(&char)
		if err != nil {
			t.Fatal(err)
		}
		return acc, char
	}
	author, authorChar := account("aria@example.com", "player", 48*time.Hour)
	_, otherChar := account("bo@example.com", "player", 48*time.Hour)
	young, youngChar := account("new@example.com", "player", time.Hour)
	gm, _ := account("gm@example.com", "gm", 48*time.Hour)
	player, _ := account("pl@example.com", "player", 48*time.Hour)

	files := []store.MapSubmissionFile{{Path: "world/islands/puerto/chunks/z07/c0100_0196.json", Action: "modify"}}
	sub := func(acc, char int64, sha string, at time.Time) (store.MapSubmission, error) {
		return st.CreateMapSubmission(ctx, store.NewMapSubmission{
			At: at, AccountID: acc, CharacterID: char, Title: "Muelle", Description: "Arena",
			License: "cc-by-4.0", SHA256: strings.Repeat(sha, 64), BaseRef: "editor", Files: files,
			Patch: []byte(`{"format":2}`), PerDay: 2, MinAccountAge: 24 * time.Hour,
		})
	}

	m, err := sub(author, authorChar, "a", now)
	if err != nil {
		t.Fatal(err)
	}
	if m.ID <= 0 || m.AuthorName != "Char aria" || m.Status != store.SubmissionPending {
		t.Fatalf("created %+v", m)
	}
	if _, err := sub(author, authorChar, "a", now); !errors.Is(err, store.ErrDuplicateSubmission) {
		t.Fatalf("same patch twice: %v", err)
	}
	if _, err := sub(author, otherChar, "b", now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another account's character: %v", err)
	}
	if _, err := sub(young, youngChar, "c", now); !errors.Is(err, store.ErrAccountTooNew) {
		t.Fatalf("young account: %v", err)
	}
	if _, err := sub(author, authorChar, "b", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := sub(author, authorChar, "c", now.Add(2*time.Minute)); !errors.Is(err, store.ErrSubmitLimit) {
		t.Fatalf("third in a day: %v", err)
	}
	if _, err := sub(author, authorChar, "c", now.Add(25*time.Hour)); err != nil {
		t.Fatalf("a day later: %v", err)
	}
	// A banned account cannot submit.
	if _, err := conn.Exec(ctx, `INSERT INTO account_bans (account_id, reason, created_at) VALUES ($1, 'x', $2)`, author, now); err != nil {
		t.Fatal(err)
	}
	if _, err := sub(author, authorChar, "d", now.Add(26*time.Hour)); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("banned: %v", err)
	}

	got, err := st.MapSubmission(ctx, m.ID)
	if err != nil || len(got.Files) != 1 || got.Files[0] != files[0] || got.SizeBytes != len(`{"format":2}`) ||
		!got.CreatedAt.Equal(now) || !got.ReviewedAt.IsZero() {
		t.Fatalf("MapSubmission = %+v, %v", got, err)
	}
	mine, err := st.AccountMapSubmissions(ctx, author, 10)
	if err != nil || len(mine) != 3 || mine[0].SHA256 != strings.Repeat("c", 64) {
		t.Fatalf("mine = %+v, %v", mine, err)
	}
	queue, err := st.MapSubmissionsByStatus(ctx, store.SubmissionPending, 10)
	if err != nil || len(queue) != 3 || queue[0].ID != m.ID {
		t.Fatalf("queue = %+v, %v", queue, err)
	}
	acc, sha, patch, err := st.MapSubmissionPatch(ctx, m.ID)
	if err != nil || acc != author || sha != strings.Repeat("a", 64) || string(patch) != `{"format":2}` {
		t.Fatalf("patch = %d %s %q %v", acc, sha, patch, err)
	}

	// Only staff decide, and only once.
	at := now.Add(time.Hour)
	if _, err := st.ReviewMapSubmission(ctx, store.ReviewRequest{At: at, ID: m.ID, ActorAccountID: player, Approve: true}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("player review: %v", err)
	}
	r, err := st.ReviewMapSubmission(ctx, store.ReviewRequest{At: at, ID: m.ID, ActorAccountID: gm, Reason: "Tapa el muelle"})
	if err != nil || r.Status != store.SubmissionRejected || r.Reason != "Tapa el muelle" || r.ReviewedBy != gm || !r.ReviewedAt.Equal(at) {
		t.Fatalf("reject = %+v, %v", r, err)
	}
	if _, err := st.ReviewMapSubmission(ctx, store.ReviewRequest{At: at, ID: m.ID, ActorAccountID: gm, Approve: true}); !errors.Is(err, store.ErrNotPending) {
		t.Fatalf("second decision: %v", err)
	}
	if _, err := st.ReviewMapSubmission(ctx, store.ReviewRequest{At: at, ID: 999999, ActorAccountID: gm, Approve: true}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	// Identities skip the ids of rolled-back inserts: take the second one from the queue.
	second := queue[1].ID
	if _, err := st.ReviewMapSubmission(ctx, store.ReviewRequest{At: at, ID: second, ActorAccountID: gm, Approve: true}); err != nil {
		t.Fatal(err)
	}
	approved, err := st.MapSubmissionsByStatus(ctx, store.SubmissionApproved, 10)
	if err != nil || len(approved) != 1 || approved[0].ID != second {
		t.Fatalf("approved = %+v, %v", approved, err)
	}
	// The table refuses a rejection without a reason and a pr_opened without its PR.
	if _, err := conn.Exec(ctx, `UPDATE map_submissions SET status = 'pr_opened' WHERE id = $1`, second); err == nil {
		t.Fatal("pr_opened without pr_url accepted")
	}
	if _, err := conn.Exec(ctx, `UPDATE map_submissions SET status = 'failed' WHERE id = $1`, second); err == nil {
		t.Fatal("failed without failure accepted")
	}

	audit, err := st.ListAudit(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	actions := map[string]int{}
	for _, e := range audit {
		actions[e.Action]++
		if e.Source != store.AuditWeb {
			t.Errorf("audit source %q", e.Source)
		}
		if e.Action == "map_reject" && (e.ActorAccountID != gm || e.TargetAccountID != author ||
			e.Args["reason"] != "Tapa el muelle" || e.ActorName != store.StaffName(gm)) {
			t.Errorf("reject audit %+v", e)
		}
	}
	if actions["map_submit"] != 3 || actions["map_reject"] != 1 || actions["map_approve"] != 1 || len(actions) != 3 {
		t.Errorf("audit actions = %v", actions)
	}
	role, err := st.AccountRole(ctx, gm)
	if err != nil || role != "gm" {
		t.Errorf("AccountRole = %q, %v", role, err)
	}
}
