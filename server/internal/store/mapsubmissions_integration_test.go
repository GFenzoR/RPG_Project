//go:build integration

package store_test

import (
	"context"
	"errors"
	"strings"
	"sync"
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
	if m.ID <= 0 || m.AuthorName != "Char aria" || m.Status != store.SubmissionPending || !m.HasPatch {
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
	// The cheap check before reading an upload agrees.
	if err := st.CheckSubmitter(ctx, author, now.Add(3*time.Minute), 2, 24*time.Hour); !errors.Is(err, store.ErrSubmitLimit) {
		t.Fatalf("check, over the limit: %v", err)
	}
	if err := st.CheckSubmitter(ctx, young, now, 2, 24*time.Hour); !errors.Is(err, store.ErrAccountTooNew) {
		t.Fatalf("check, young: %v", err)
	}
	if err := st.CheckSubmitter(ctx, author, now.Add(26*time.Hour), 2, 24*time.Hour); err != nil {
		t.Fatalf("check: %v", err)
	}
	if err := st.CheckSubmitter(ctx, 999999, now, 2, 0); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("check, no account: %v", err)
	}
	// An expired and a lifted ban do not block; an active one does, also in the check.
	later := now.Add(26 * time.Hour)
	if _, err := conn.Exec(ctx, `INSERT INTO account_bans (account_id, reason, created_at, expires_at) VALUES ($1, 'x', $2, $3)`,
		author, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO account_bans (account_id, reason, created_at, lifted_at) VALUES ($1, 'x', $2, $2)`, author, now); err != nil {
		t.Fatal(err)
	}
	if err := st.CheckSubmitter(ctx, author, later, 2, 24*time.Hour); err != nil {
		t.Fatalf("expired or lifted ban: %v", err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO account_bans (account_id, reason, created_at) VALUES ($1, 'x', $2)`, author, now); err != nil {
		t.Fatal(err)
	}
	if _, err := sub(author, authorChar, "d", later); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("banned: %v", err)
	}
	if err := st.CheckSubmitter(ctx, author, later, 2, 24*time.Hour); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("check, banned: %v", err)
	}
	// A disabled account neither.
	disabled, disabledChar := account("off@example.com", "player", 48*time.Hour)
	if _, err := conn.Exec(ctx, `UPDATE accounts SET disabled_at = $2 WHERE id = $1`, disabled, now); err != nil {
		t.Fatal(err)
	}
	if _, err := sub(disabled, disabledChar, "e", now); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("disabled: %v", err)
	}
	// Uploads at once from one account cannot pass the daily limit together (the
	// account row is locked): with 2 a day and none yet, exactly 2 of 6 are stored.
	racer, racerChar := account("race@example.com", "player", 48*time.Hour)
	var wg sync.WaitGroup
	var mu sync.Mutex
	stored, limited := 0, 0
	for i := range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := sub(racer, racerChar, string(rune('a'+i)), now)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				stored++
			case errors.Is(err, store.ErrSubmitLimit):
				limited++
			default:
				t.Errorf("race: %v", err)
			}
		}()
	}
	wg.Wait()
	if stored != 2 || limited != 4 {
		t.Fatalf("concurrent uploads: %d stored, %d limited", stored, limited)
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
	queue, err := st.MapSubmissionsByStatus(ctx, store.SubmissionPending, store.SubmissionCursor{}, 10)
	var authorQueue []store.MapSubmission
	for _, q := range queue {
		if q.AccountID == author {
			authorQueue = append(authorQueue, q)
		}
	}
	if err != nil || len(queue) != 5 || len(authorQueue) != 3 || queue[0].ID != m.ID {
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
	// A moderator's own submission needs another moderator.
	gmChar := int64(0)
	if err := conn.QueryRow(ctx, `SELECT id FROM characters WHERE account_id = $1`, gm).Scan(&gmChar); err != nil {
		t.Fatal(err)
	}
	own, err := sub(gm, gmChar, "f", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.ReviewMapSubmission(ctx, store.ReviewRequest{At: at, ID: own.ID, ActorAccountID: gm, Approve: true}); !errors.Is(err, store.ErrOwnSubmission) {
		t.Fatalf("own review: %v", err)
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
	second := authorQueue[1].ID
	if _, err := st.ReviewMapSubmission(ctx, store.ReviewRequest{At: at, ID: second, ActorAccountID: gm, Approve: true}); err != nil {
		t.Fatal(err)
	}
	approved, err := st.MapSubmissionsByStatus(ctx, store.SubmissionApproved, store.SubmissionCursor{}, 10)
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
	if actions["map_submit"] != 6 || actions["map_reject"] != 1 || actions["map_approve"] != 1 || len(actions) != 3 {
		t.Errorf("audit actions = %v", actions)
	}
	role, email, err := st.AccountInfo(ctx, gm)
	if err != nil || role != "gm" || email != "gm@example.com" {
		t.Errorf("AccountInfo = %q %q, %v", role, email, err)
	}

	// Paging: pending oldest first after a cursor; the history newest first before one.
	page1, err := st.MapSubmissionsByStatus(ctx, store.SubmissionPending, store.SubmissionCursor{}, 2)
	if err != nil || len(page1) != 2 {
		t.Fatalf("pending page 1 = %d, %v", len(page1), err)
	}
	page2, err := st.MapSubmissionsByStatus(ctx, store.SubmissionPending, page1[1].Cursor(), 100)
	if err != nil || len(page2) == 0 || page2[0].ID == page1[1].ID || !page2[0].CreatedAt.After(page1[1].CreatedAt.Add(-time.Nanosecond)) {
		t.Fatalf("pending page 2 = %+v, %v", page2, err)
	}
	for _, m := range append(page1, page2...) {
		if m.Status != store.SubmissionPending {
			t.Fatalf("not pending: %+v", m)
		}
	}
	// A newer rejection comes before an older one.
	rejected2 := page2[len(page2)-1]
	if _, err := st.ReviewMapSubmission(ctx, store.ReviewRequest{At: at.Add(time.Hour), ID: rejected2.ID, ActorAccountID: gm, Reason: "otra"}); err != nil {
		t.Fatal(err)
	}
	hist, err := st.MapSubmissionsByStatus(ctx, store.SubmissionRejected, store.SubmissionCursor{}, 10)
	if err != nil || len(hist) != 2 || hist[0].ID != rejected2.ID || hist[1].ID != m.ID {
		t.Fatalf("rejected history = %+v, %v", hist, err)
	}
	rest, err := st.MapSubmissionsByStatus(ctx, store.SubmissionRejected, hist[0].Cursor(), 10)
	if err != nil || len(rest) != 1 || rest[0].ID != m.ID {
		t.Fatalf("rejected after cursor = %+v, %v", rest, err)
	}

	// Retention: only final statuses changed before the cutoff lose their bytes.
	n, err := st.PurgeMapPatches(ctx, at.Add(30*time.Minute))
	if err != nil || n != 1 {
		t.Fatalf("purge = %d, %v", n, err)
	}
	gone, err := st.MapSubmission(ctx, m.ID)
	if err != nil || gone.HasPatch || gone.SHA256 == "" {
		t.Fatalf("purged = %+v, %v", gone, err)
	}
	if _, _, patch, err := st.MapSubmissionPatch(ctx, m.ID); err != nil || patch != nil {
		t.Fatalf("purged patch = %q, %v", patch, err)
	}
	kept, err := st.MapSubmission(ctx, rejected2.ID)
	if err != nil || !kept.HasPatch {
		t.Fatalf("recent rejection lost its patch: %+v, %v", kept, err)
	}
	if ok, err := st.MapSubmission(ctx, second); err != nil || !ok.HasPatch {
		t.Fatalf("approved lost its patch: %+v, %v", ok, err)
	}
}
