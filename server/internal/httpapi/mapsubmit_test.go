package httpapi_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// fakeSubmissions is an in-memory MapSubmissions with the store's rules that matter to
// the handlers (roles, ownership, pending only).
type fakeSubmissions struct {
	mu      sync.Mutex
	roles   map[int64]string
	subs    []store.MapSubmission
	patches map[int64][]byte
	audit   []store.AuditEntry
	created []store.NewMapSubmission
	// createErr, when set, is returned by CreateMapSubmission.
	createErr error
	// checkErr, when set, is returned by CheckSubmitter.
	checkErr error
}

func (f *fakeSubmissions) CheckSubmitter(context.Context, int64, time.Time, int, time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.checkErr
}

func newFakeSubmissions() *fakeSubmissions {
	return &fakeSubmissions{roles: map[int64]string{}, patches: map[int64][]byte{}}
}

func (f *fakeSubmissions) CreateMapSubmission(_ context.Context, n store.NewMapSubmission) (store.MapSubmission, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = append(f.created, n)
	if f.createErr != nil {
		return store.MapSubmission{}, f.createErr
	}
	m := store.MapSubmission{
		ID: int64(len(f.subs) + 1), CreatedAt: n.At, UpdatedAt: n.At, AccountID: n.AccountID,
		AuthorCharacterID: n.CharacterID, AuthorName: "Aria", Title: n.Title, Description: n.Description,
		License: n.License, Status: store.SubmissionPending, SHA256: n.SHA256, SizeBytes: len(n.Patch),
		BaseRef: n.BaseRef, Files: n.Files, HasPatch: len(n.Patch) > 0,
	}
	f.subs = append(f.subs, m)
	f.patches[m.ID] = n.Patch
	return m, nil
}

func (f *fakeSubmissions) AccountInfo(_ context.Context, id int64) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	email := "account" + strconv.FormatInt(id, 10) + "@example.com"
	if r, ok := f.roles[id]; ok {
		return r, email, nil
	}
	return store.RolePlayer, email, nil
}

func (f *fakeSubmissions) AccountMapSubmissions(_ context.Context, id int64, _ int) ([]store.MapSubmission, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.MapSubmission
	for _, m := range f.subs {
		if m.AccountID == id {
			out = append(out, m)
		}
	}
	return out, nil
}

// MapSubmissionsByStatus pages by id: pending oldest first, the rest newest first.
func (f *fakeSubmissions) MapSubmissionsByStatus(_ context.Context, status string, c store.SubmissionCursor, n int) ([]store.MapSubmission, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.MapSubmission
	for i := range f.subs {
		m := f.subs[i]
		if status != store.SubmissionPending {
			m = f.subs[len(f.subs)-1-i]
		}
		after := c.ID == 0 || (status == store.SubmissionPending && m.ID > c.ID) || (status != store.SubmissionPending && m.ID < c.ID)
		if m.Status == status && after && len(out) < n {
			out = append(out, m)
		}
	}
	return out, nil
}

func (f *fakeSubmissions) MapSubmission(_ context.Context, id int64) (store.MapSubmission, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id < 1 || int(id) > len(f.subs) {
		return store.MapSubmission{}, store.ErrNotFound
	}
	return f.subs[id-1], nil
}

func (f *fakeSubmissions) MapSubmissionPatch(_ context.Context, id int64) (int64, string, []byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id < 1 || int(id) > len(f.subs) {
		return 0, "", nil, store.ErrNotFound
	}
	m := f.subs[id-1]
	return m.AccountID, m.SHA256, f.patches[id], nil
}

func (f *fakeSubmissions) ReviewMapSubmission(_ context.Context, r store.ReviewRequest) (store.MapSubmission, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if store.RoleRank(f.roles[r.ActorAccountID]) < store.RoleRank(store.RoleGM) {
		return store.MapSubmission{}, store.ErrForbidden
	}
	if r.ID < 1 || int(r.ID) > len(f.subs) {
		return store.MapSubmission{}, store.ErrNotFound
	}
	m := &f.subs[r.ID-1]
	if m.AccountID == r.ActorAccountID {
		return store.MapSubmission{}, store.ErrOwnSubmission
	}
	if m.Status != store.SubmissionPending {
		return store.MapSubmission{}, store.ErrNotPending
	}
	m.Status, m.Reason, m.ReviewedAt, m.ReviewedBy = store.SubmissionRejected, r.Reason, r.At, r.ActorAccountID
	if r.Approve {
		m.Status = store.SubmissionApproved
	}
	return *m, nil
}

func (f *fakeSubmissions) AppendAudit(_ context.Context, e store.AuditEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.audit = append(f.audit, e)
	return nil
}

var _ httpapi.MapSubmissions = (*fakeSubmissions)(nil)

type portal struct {
	*harness
	subs *fakeSubmissions
}

func newPortal(t *testing.T, mutate func(*httpapi.Config)) *portal {
	t.Helper()
	subs := newFakeSubmissions()
	h := newHarness(t, func(c *httpapi.Config) {
		c.MapSubmissions = subs
		if mutate != nil {
			mutate(c)
		}
	})
	return &portal{harness: h, subs: subs}
}

// account registers and logs in; it returns the account id and its token.
func (p *portal) account(email, role string) (int64, string) {
	p.t.Helper()
	w := p.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"` + email + `","password":"long-password-1"}`})
	expect(p.t, w, http.StatusCreated, "")
	var b struct {
		AccountID int64 `json:"account_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
		p.t.Fatal(err)
	}
	if role != "" {
		p.subs.roles[b.AccountID] = role
	}
	return b.AccountID, p.login(email, "long-password-1")
}

const testChunk = "world/islands/puerto/chunks/z07/c0100_0196.json"

func validPatch(t *testing.T) string {
	t.Helper()
	base := "{\"z\":7}\n"
	sum := sha256.Sum256([]byte(base))
	b, err := json.Marshal(map[string]any{
		"format": 2, "kind": "rpg-map-patch", "base_ref": "editor",
		"files": []map[string]any{{"path": testChunk, "base": "sha256:" + hex.EncodeToString(sum[:]), "base_text": base, "content": "{\"z\":8}\n"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func submitBody(t *testing.T, fields map[string]any) string {
	t.Helper()
	body := map[string]any{
		"title": "Muelle norte", "description": "Arena nueva\ncerca del muelle.", "character_id": 7,
		"license": httpapi.MapLicense, "patch": validPatch(t),
	}
	for k, v := range fields {
		if v == nil {
			delete(body, k)
		} else {
			body[k] = v
		}
	}
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

type submissionResp struct {
	Submission struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
		Author string `json:"author"`
		Files  []struct {
			Path, Action string
		} `json:"files"`
		SHA256 string `json:"sha256"`
		Reason string `json:"reason"`
	} `json:"submission"`
}

func decodeJSON[T any](t *testing.T, raw []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return v
}

func TestSubmitMap(t *testing.T) {
	p := newPortal(t, nil)
	acc, tok := p.account("aria@example.com", "")
	body := submitBody(t, nil)
	w := p.do(req{method: "POST", path: "/api/maps/submissions", token: tok, body: body})
	expect(t, w, http.StatusCreated, "")
	got := decodeJSON[submissionResp](t, w.Body.Bytes())
	if !strings.Contains(w.Body.String(), `"has_patch":true`) {
		t.Errorf("created without has_patch: %s", w.Body.String())
	}
	if got.Submission.Status != "pending" || len(got.Submission.Files) != 1 ||
		got.Submission.Files[0].Path != testChunk || got.Submission.Files[0].Action != "modify" {
		t.Fatalf("submission = %+v", got.Submission)
	}
	patch := validPatch(t)
	sum := sha256.Sum256([]byte(patch))
	n := p.subs.created[0]
	if n.AccountID != acc || n.CharacterID != 7 || n.SHA256 != hex.EncodeToString(sum[:]) ||
		string(n.Patch) != patch || n.Title != "Muelle norte" || n.Description != "Arena nueva\ncerca del muelle." ||
		n.License != httpapi.MapLicense || n.BaseRef != "editor" {
		t.Errorf("stored %+v", n)
	}
	d := httpapi.DefaultMapSubmitLimits
	if n.PerDay != d.PerDay || n.MinAccountAge != 0 {
		t.Errorf("limits passed: %d %v", n.PerDay, n.MinAccountAge)
	}
	if !n.At.Equal(p.clock.Now()) {
		t.Errorf("at = %v", n.At)
	}
}

func TestSubmitMapRejects(t *testing.T) {
	p := newPortal(t, func(c *httpapi.Config) {
		c.MapSubmitLimits = httpapi.MapSubmitLimits{MaxBytes: 4096}
		c.MapSubmitRateLimit = httpapi.RateLimit{Burst: 1000, Every: time.Second}
	})
	_, tok := p.account("aria@example.com", "")
	big := `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[{"path":"world/world.yaml","base":null,"content":"` + strings.Repeat("a", 5000) + `"}]}`
	cases := []struct {
		name   string
		body   string
		ct     string
		status int
		code   string
	}{
		{"no license", submitBody(t, map[string]any{"license": nil}), "", 400, "license_required"},
		{"other license", submitBody(t, map[string]any{"license": "all-rights-reserved"}), "", 400, "license_required"},
		{"empty title", submitBody(t, map[string]any{"title": "  "}), "", 400, "invalid_title"},
		{"long title", submitBody(t, map[string]any{"title": strings.Repeat("x", 81)}), "", 400, "invalid_title"},
		{"title newline", submitBody(t, map[string]any{"title": "a\nb"}), "", 400, "invalid_title"},
		{"title bidi", submitBody(t, map[string]any{"title": "abc\u202edef"}), "", 400, "invalid_title"},
		{"description control", submitBody(t, map[string]any{"description": "a\x1b[2J"}), "", 400, "invalid_description"},
		{"long description", submitBody(t, map[string]any{"description": strings.Repeat("ñ", 2001)}), "", 400, "invalid_description"},
		{"unknown field", submitBody(t, map[string]any{"role": "admin"}), "", 400, "bad_request"},
		{"form post", "title=x", "application/x-www-form-urlencoded", 415, "unsupported_media_type"},
		{"multipart", submitBody(t, nil), "multipart/form-data; boundary=x", 415, "unsupported_media_type"},
		{"too large", submitBody(t, map[string]any{"patch": big}), "", 413, "patch_too_large"},
		{"body too large", `{"patch":"` + strings.Repeat("\\\\", 20000) + `"}`, "", 413, "patch_too_large"},
		{"two objects", submitBody(t, nil) + "{}", "", 400, "bad_request"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			expect(t, p.do(req{method: "POST", path: "/api/maps/submissions", token: tok, body: c.body, contentType: c.ct}), c.status, c.code)
		})
	}
	if len(p.subs.created) != 0 {
		t.Errorf("stored %d submissions", len(p.subs.created))
	}
}

func TestSubmitMapInvalidPatch(t *testing.T) {
	p := newPortal(t, nil)
	_, tok := p.account("aria@example.com", "")
	evil := `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[{"path":"world/x.yaml","base":null,"content":"ok"},{"path":".github/workflows/<script>.yml","base":null,"content":"run: curl evil"}]}`
	w := p.do(req{method: "POST", path: "/api/maps/submissions", token: tok, body: submitBody(t, map[string]any{"patch": evil})})
	expect(t, w, http.StatusBadRequest, "invalid_patch")
	b := decodeJSON[struct {
		Error struct {
			Detail string `json:"detail"`
			File   *int   `json:"file"`
		} `json:"error"`
	}](t, w.Body.Bytes())
	if b.Error.Detail != "path" || b.Error.File == nil || *b.Error.File != 0 {
		t.Errorf("error = %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "script") || strings.Contains(w.Body.String(), "x.yaml") {
		t.Errorf("error echoes the patch: %s", w.Body.String())
	}
	w = p.do(req{method: "POST", path: "/api/maps/submissions", token: tok, body: submitBody(t, map[string]any{"patch": "not json"})})
	expect(t, w, http.StatusBadRequest, "invalid_patch")
}

func TestSubmitMapStoreErrors(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{store.ErrSubmitLimit, 429, "submit_limit"},
		{store.ErrAccountTooNew, 403, "account_too_new"},
		{store.ErrDuplicateSubmission, 409, "duplicate_submission"},
		{store.ErrForbidden, 403, "account_blocked"},
		{store.ErrNotFound, 404, "character_not_found"},
	}
	for _, c := range cases {
		t.Run(c.code, func(t *testing.T) {
			p := newPortal(t, nil)
			p.subs.createErr = c.err
			_, tok := p.account("aria@example.com", "")
			expect(t, p.do(req{method: "POST", path: "/api/maps/submissions", token: tok, body: submitBody(t, nil)}), c.status, c.code)
		})
	}
}

// An account that would be refused is refused before the body is read: the answer comes
// even for a body far over the limit.
func TestSubmitMapChecksTheAccountFirst(t *testing.T) {
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{store.ErrSubmitLimit, 429, "submit_limit"},
		{store.ErrAccountTooNew, 403, "account_too_new"},
		{store.ErrForbidden, 403, "account_blocked"},
		{store.ErrNotFound, 401, "unauthorized"},
	} {
		t.Run(c.code, func(t *testing.T) {
			p := newPortal(t, func(cfg *httpapi.Config) { cfg.MapSubmitLimits = httpapi.MapSubmitLimits{MaxBytes: 1024} })
			p.subs.checkErr = c.err
			_, tok := p.account("aria@example.com", "")
			huge := `{"patch":"` + strings.Repeat("a", 1<<20) + `"}`
			expect(t, p.do(req{method: "POST", path: "/api/maps/submissions", token: tok, body: huge}), c.status, c.code)
			if len(p.subs.created) != 0 {
				t.Error("stored")
			}
		})
	}
}

func TestModeratorCannotReviewOwnSubmission(t *testing.T) {
	p := newPortal(t, nil)
	_, gm := p.account("gm@example.com", store.RoleGM)
	expect(t, p.do(req{method: "POST", path: "/api/maps/submissions", token: gm, body: submitBody(t, nil)}), 201, "")
	expect(t, p.do(req{method: "POST", path: "/api/maps/submissions/1/review", token: gm, body: `{"decision":"approve"}`}), 403, "own_submission")
	if p.subs.subs[0].Status != store.SubmissionPending {
		t.Fatal("approved its own")
	}
}

func TestSubmitMapNeedsSessionAndRateLimit(t *testing.T) {
	p := newPortal(t, func(c *httpapi.Config) {
		c.MapSubmitRateLimit = httpapi.RateLimit{Burst: 2, Every: time.Hour}
	})
	expect(t, p.do(req{method: "POST", path: "/api/maps/submissions", body: submitBody(t, nil)}), 401, "unauthorized")
	_, tok := p.account("aria@example.com", "")
	for range 2 {
		p.do(req{method: "POST", path: "/api/maps/submissions", token: tok, body: `{}`})
	}
	expect(t, p.do(req{method: "POST", path: "/api/maps/submissions", token: tok, body: submitBody(t, nil)}), 429, "rate_limited")
	// Another account has its own budget.
	_, other := p.account("bo@example.com", "")
	expect(t, p.do(req{method: "POST", path: "/api/maps/submissions", token: other, body: submitBody(t, nil)}), 201, "")
}

func TestModerationNeedsStaff(t *testing.T) {
	p := newPortal(t, nil)
	_, author := p.account("aria@example.com", "")
	_, player := p.account("bo@example.com", "")
	_, gm := p.account("gm@example.com", store.RoleGM)
	_, admin := p.account("admin@example.com", store.RoleAdmin)
	expect(t, p.do(req{method: "POST", path: "/api/maps/submissions", token: author, body: submitBody(t, nil)}), 201, "")

	// A player who knows the URLs gets nothing.
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions", token: player}), 403, "forbidden")
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions", token: author}), 403, "forbidden")
	expect(t, p.do(req{method: "POST", path: "/api/maps/submissions/1/review", token: author, body: `{"decision":"approve"}`}), 403, "forbidden")
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions/1", token: player}), 404, "not_found")
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions/1/patch", token: player}), 404, "not_found")
	if p.subs.subs[0].Status != store.SubmissionPending {
		t.Fatal("a player changed the status")
	}

	// The author sees their own.
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions/1", token: author}), 200, "")
	w := p.do(req{method: "GET", path: "/api/maps/submissions/mine", token: author})
	expect(t, w, 200, "")
	mine := decodeJSON[struct {
		Submissions []json.RawMessage `json:"submissions"`
		CanReview   bool              `json:"can_review"`
		License     string            `json:"license"`
	}](t, w.Body.Bytes())
	if len(mine.Submissions) != 1 || mine.CanReview || mine.License != httpapi.MapLicense {
		t.Errorf("mine = %s", w.Body.String())
	}
	w = p.do(req{method: "GET", path: "/api/maps/submissions/mine", token: gm})
	if !decodeJSON[struct {
		CanReview bool `json:"can_review"`
	}](t, w.Body.Bytes()).CanReview {
		t.Error("gm: can_review false")
	}

	// Staff list, read and download (audited).
	for _, tok := range []string{gm, admin} {
		w = p.do(req{method: "GET", path: "/api/maps/submissions?status=pending", token: tok})
		expect(t, w, 200, "")
		if !strings.Contains(w.Body.String(), `"title":"Muelle norte"`) {
			t.Errorf("queue = %s", w.Body.String())
		}
	}
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions?status=bogus", token: gm}), 400, "bad_request")
	w = p.do(req{method: "GET", path: "/api/maps/submissions/1/patch", token: gm})
	expect(t, w, 200, "")
	if w.Body.String() != validPatch(t) {
		t.Errorf("patch = %s", w.Body.String())
	}
	h := w.Header()
	if h.Get("Content-Disposition") != `attachment; filename="submission-1.rpgpatch.json"` ||
		h.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(h.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("headers = %v", h)
	}
	if len(p.subs.audit) != 1 || p.subs.audit[0].Action != "map_download" || p.subs.audit[0].Source != store.AuditWeb {
		t.Errorf("audit = %+v", p.subs.audit)
	}
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions/1/patch", token: author}), 200, "")
	if len(p.subs.audit) != 1 {
		t.Error("the author's own download was audited")
	}
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions/99", token: gm}), 404, "not_found")
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions/abc", token: gm}), 404, "not_found")
}

func TestReviewSubmission(t *testing.T) {
	p := newPortal(t, nil)
	_, author := p.account("aria@example.com", "")
	_, gm := p.account("gm@example.com", store.RoleGM)
	for range 2 {
		body := submitBody(t, map[string]any{"title": "t" + strings.Repeat("x", len(p.subs.subs))})
		expect(t, p.do(req{method: "POST", path: "/api/maps/submissions", token: author, body: body}), 201, "")
	}
	review := func(id, body string) *httptest.ResponseRecorder {
		return p.do(req{method: "POST", path: "/api/maps/submissions/" + id + "/review", token: gm, body: body})
	}
	expect(t, review("1", `{"decision":"reject"}`), 400, "invalid_reason")
	expect(t, review("1", `{"decision":"reject","reason":"  "}`), 400, "invalid_reason")
	expect(t, review("1", `{"decision":"maybe"}`), 400, "bad_request")
	expect(t, review("1", `{"decision":"reject","reason":"`+strings.Repeat("x", 501)+`"}`), 400, "invalid_reason")
	w := review("1", `{"decision":"reject","reason":"Tapa el camino al muelle."}`)
	expect(t, w, 200, "")
	got := decodeJSON[submissionResp](t, w.Body.Bytes())
	if got.Submission.Status != "rejected" || got.Submission.Reason != "Tapa el camino al muelle." {
		t.Errorf("rejected = %s", w.Body.String())
	}
	expect(t, review("1", `{"decision":"approve"}`), 409, "not_pending")
	w = review("2", `{"decision":"approve"}`)
	expect(t, w, 200, "")
	if decodeJSON[submissionResp](t, w.Body.Bytes()).Submission.Status != "approved" {
		t.Errorf("approved = %s", w.Body.String())
	}
	expect(t, review("9", `{"decision":"approve"}`), 404, "not_found")
	// The author sees the reason.
	w = p.do(req{method: "GET", path: "/api/maps/submissions/mine", token: author})
	if !strings.Contains(w.Body.String(), "Tapa el camino al muelle.") {
		t.Errorf("mine = %s", w.Body.String())
	}
}

func TestMapRoutesNeedTheStore(t *testing.T) {
	h := newHarness(t, nil)
	expect(t, h.do(req{method: "GET", path: "/api/maps/submissions/mine"}), 404, "not_found")
}

// Uploads in flight are bounded before their bodies are read: with every slot held by a
// stalled upload, the next one answers 503 busy at once, without reading its body.
func TestStalledUploadsGetBusy(t *testing.T) {
	subs := newFakeSubmissions()
	h := newHarness(t, func(c *httpapi.Config) {
		c.MapSubmissions = subs
		c.MapUploadSlots = 2
		c.MapSubmitRateLimit = httpapi.RateLimit{Burst: 100, Every: time.Second}
	})
	srv := httptest.NewServer(h.h)
	defer srv.Close()
	p := &portal{harness: h, subs: subs}
	_, tok := p.account("aria@example.com", "")

	post := func(body io.Reader, length int64) (*http.Response, error) {
		req, _ := http.NewRequest("POST", srv.URL+"/api/maps/submissions", body)
		req.ContentLength = length
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		return http.DefaultClient.Do(req)
	}
	// Slots in use, as the handlers take and free them (no racing the handlers).
	var mu sync.Mutex
	inUse := 0
	changed := make(chan struct{}, 64)
	defer httpapi.SetUploadSlotHook(func(d int) {
		mu.Lock()
		inUse += d
		mu.Unlock()
		changed <- struct{}{}
	})()
	waitSlots := func(n int) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for {
			mu.Lock()
			got := inUse
			mu.Unlock()
			if got == n {
				return
			}
			select {
			case <-changed:
			case <-ctx.Done():
				t.Fatalf("slots in use = %d, want %d", got, n)
			}
		}
	}

	// Two uploads that send their first bytes and stall, each holding a slot.
	var writers []*io.PipeWriter
	done := make(chan *http.Response, 2)
	for range 2 {
		pr, pw := io.Pipe()
		writers = append(writers, pw)
		go func() {
			resp, err := post(pr, 1<<20)
			if err == nil {
				resp.Body.Close()
			}
			done <- resp
		}()
		if _, err := pw.Write([]byte(`{"patch":"`)); err != nil {
			t.Fatal(err)
		}
	}
	waitSlots(2)

	// The third: a body that is never sent. It must be answered anyway, at once. (The
	// deadline only keeps a broken server from hanging the test.)
	pr, pw := io.Pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() {
		<-ctx.Done()
		_ = pw.CloseWithError(ctx.Err())
	}()
	req, _ := http.NewRequestWithContext(ctx, "POST", srv.URL+"/api/maps/submissions", pr)
	req.ContentLength = 1 << 20
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	third, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(third.Body)
	third.Body.Close()
	if third.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(b), `"busy"`) {
		t.Fatalf("third upload = %d %s, want 503 busy", third.StatusCode, b)
	}

	// Once the stalled ones end (and their handlers free their slots), uploads work again.
	for _, w := range writers {
		_ = w.CloseWithError(io.ErrUnexpectedEOF)
	}
	for range 2 {
		<-done
	}
	waitSlots(0)
	body := submitBody(t, nil)
	resp, err := post(strings.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("after the stall = %d", resp.StatusCode)
	}
	// Its handler frees the slot after answering: wait, so the hook is restored after it.
	waitSlots(0)
}

func TestUploadContentLengthOverTheCap(t *testing.T) {
	p := newPortal(t, func(c *httpapi.Config) { c.MapSubmitLimits = httpapi.MapSubmitLimits{MaxBytes: 1024} })
	_, tok := p.account("aria@example.com", "")
	hr := httptest.NewRequest("POST", "/api/maps/submissions", strings.NewReader("{}"))
	hr.ContentLength = 1 << 30
	hr.Header.Set("Content-Type", "application/json")
	hr.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	p.h.ServeHTTP(w, hr)
	expect(t, w, http.StatusRequestEntityTooLarge, "patch_too_large")
}

func TestPatchDownloadLimitsAndRetention(t *testing.T) {
	p := newPortal(t, func(c *httpapi.Config) {
		c.MapDownloadRateLimit = httpapi.RateLimit{Burst: 3, Every: time.Hour}
	})
	_, author := p.account("aria@example.com", "")
	expect(t, p.do(req{method: "POST", path: "/api/maps/submissions", token: author, body: submitBody(t, nil)}), 201, "")
	for range 3 {
		expect(t, p.do(req{method: "GET", path: "/api/maps/submissions/1/patch", token: author}), 200, "")
	}
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions/1/patch", token: author}), 429, "rate_limited")

	_, other := p.account("bo@example.com", "")
	p.subs.subs[0].AccountID = 0 // now the submission is nobody's: 404 for a player
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions/1/patch", token: other}), 404, "not_found")

	_, gm := p.account("gm@example.com", store.RoleGM)
	p.subs.subs[0].HasPatch = false
	p.subs.patches[1] = nil
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions/1/patch", token: gm}), 410, "patch_gone")
	w := p.do(req{method: "GET", path: "/api/maps/submissions/1", token: gm})
	if !strings.Contains(w.Body.String(), `"has_patch":false`) {
		t.Errorf("detail = %s", w.Body.String())
	}
}

func TestQueuePagesAndHistoryOrder(t *testing.T) {
	p := newPortal(t, func(c *httpapi.Config) {
		c.MapSubmitRateLimit = httpapi.RateLimit{Burst: 1000, Every: time.Second}
	})
	acc, _ := p.account("aria@example.com", "")
	_, gm := p.account("gm@example.com", store.RoleGM)
	for i := range 55 {
		status := store.SubmissionPending
		if i%2 == 1 {
			status = store.SubmissionRejected
		}
		p.subs.subs = append(p.subs.subs, store.MapSubmission{ID: int64(i + 1), AccountID: acc, Status: status, HasPatch: true,
			Files: []store.MapSubmissionFile{{Path: testChunk, Action: "modify"}}, UpdatedAt: p.clock.Now()})
	}
	type page struct {
		Submissions []struct{ ID int64 } `json:"submissions"`
		Next        string               `json:"next"`
	}
	get := func(path string) page {
		t.Helper()
		w := p.do(req{method: "GET", path: path, token: gm})
		expect(t, w, 200, "")
		return decodeJSON[page](t, w.Body.Bytes())
	}
	// 28 pending (ids 1, 3, ..., 55), oldest first: one page.
	pend := get("/api/maps/submissions")
	if len(pend.Submissions) != 28 || pend.Submissions[0].ID != 1 || pend.Next != "" {
		t.Fatalf("pending = %+v", pend)
	}
	// 27 rejected, newest first.
	rej := get("/api/maps/submissions?status=rejected")
	if len(rej.Submissions) != 27 || rej.Submissions[0].ID != 54 {
		t.Fatalf("rejected = %+v", rej)
	}
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions?cursor=x", token: gm}), 400, "bad_request")
	expect(t, p.do(req{method: "GET", path: "/api/maps/submissions?cursor=1-0", token: gm}), 400, "bad_request")
	// A full page has a next cursor that continues after its last row.
	for i := range 60 {
		p.subs.subs = append(p.subs.subs, store.MapSubmission{ID: int64(56 + i), AccountID: acc, Status: store.SubmissionApproved,
			HasPatch: true, Files: []store.MapSubmissionFile{}, UpdatedAt: p.clock.Now()})
	}
	first := get("/api/maps/submissions?status=approved")
	if len(first.Submissions) != 50 || first.Submissions[0].ID != 115 || first.Next == "" {
		t.Fatalf("approved page 1: %d rows, first %d, next %q", len(first.Submissions), first.Submissions[0].ID, first.Next)
	}
	second := get("/api/maps/submissions?status=approved&cursor=" + first.Next)
	if len(second.Submissions) != 10 || second.Submissions[0].ID != 65 || second.Next != "" {
		t.Fatalf("approved page 2: %+v", second)
	}
}

func TestMineSaysWhoIsSignedIn(t *testing.T) {
	p := newPortal(t, func(c *httpapi.Config) { c.MapPRWorker = true })
	acc, tok := p.account("aria@example.com", "")
	w := p.do(req{method: "GET", path: "/api/maps/submissions/mine", token: tok})
	expect(t, w, 200, "")
	if !strings.Contains(w.Body.String(), `"email":"account`+strconv.FormatInt(acc, 10)+`@example.com"`) ||
		!strings.Contains(w.Body.String(), `"pr_worker":true`) {
		t.Errorf("mine = %s", w.Body.String())
	}
}
