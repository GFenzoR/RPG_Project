package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/mappatch"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Map submission portal (T4.5, docs/05-network-protocol.md "Envío de mapas"): a player
// uploads a map patch from the website, gm and admin accounts review it, and an approved
// one waits for the worker that opens the pull request. The patch is untrusted input:
// mappatch checks it before it is stored, and nothing in it is ever executed.

// MapSubmissions is the storage of the portal. *store.Store implements it.
type MapSubmissions interface {
	CreateMapSubmission(ctx context.Context, n store.NewMapSubmission) (store.MapSubmission, error)
	CheckSubmitter(ctx context.Context, accountID int64, at time.Time, perDay int, minAge time.Duration) error
	AccountInfo(ctx context.Context, accountID int64) (role, email string, err error)
	AccountMapSubmissions(ctx context.Context, accountID int64, n int) ([]store.MapSubmission, error)
	MapSubmissionsByStatus(ctx context.Context, status string, cursor store.SubmissionCursor, n int) ([]store.MapSubmission, error)
	MapSubmission(ctx context.Context, id int64) (store.MapSubmission, error)
	MapSubmissionPatch(ctx context.Context, id int64) (accountID int64, sha string, patch []byte, err error)
	ReviewMapSubmission(ctx context.Context, r store.ReviewRequest) (store.MapSubmission, error)
	AppendAudit(ctx context.Context, e store.AuditEntry) error
}

var _ MapSubmissions = (*store.Store)(nil)

// MapSubmitLimits bounds the uploads.
type MapSubmitLimits struct {
	// MaxBytes is the largest patch accepted (far below parsePatch's 32 MB).
	MaxBytes int
	// MaxFiles is the most files a patch may touch.
	MaxFiles int
	// PerDay is how many submissions an account may make in 24 hours.
	PerDay int
	// MinAccountAge is how old an account must be to submit.
	MinAccountAge time.Duration
}

// DefaultMapSubmitLimits are the production limits (flags of cmd/gameserver).
var DefaultMapSubmitLimits = MapSubmitLimits{
	MaxBytes: 2 << 20, MaxFiles: 256, PerDay: 3, MinAccountAge: 24 * time.Hour,
}

// MapLicense is the license an author grants with the checkbox (docs/04, "Licencia").
// Changing it means a new id: stored submissions keep the one their author accepted.
const MapLicense = "cc-by-4.0"

// Text limits of a submission and of a moderator's reason (in characters).
const (
	MapTitleMax       = 80
	MapDescriptionMax = 2000
	MapReasonMax      = 500
	// mapMinePage is how many of their submissions an author sees (3 a day: a month).
	mapMinePage = 100
	// mapQueuePage is how many submissions a page of the moderation lists has.
	mapQueuePage = 50
	// uploadTimeout is how long an upload may take to arrive: 2 × 2 MiB in 30 s is about
	// 140 KB/s. A slower link gets 408-like failures; a stalled one frees its slot.
	uploadTimeout = 30 * time.Second
	// maxPatchDownloads is how many patch downloads run at once (each up to MaxBytes from
	// the pgx pool the game's saves share).
	maxPatchDownloads = 2
)

// DefaultMapUploadSlots is how many uploads are in flight at once, from the first body
// byte to the answer. Each holds at most about 5 × MaxBytes (body, decoded text, the
// stored copy): with 2 MiB patches, 4 slots bound the portal to about 40 MiB. A request
// that finds every slot taken answers 503 busy without reading its body.
const DefaultMapUploadSlots = 4

// DefaultMapSubmitRateLimit is the upload attempts per account (valid or not), on top of the
// daily limit of stored submissions.
var DefaultMapSubmitRateLimit = RateLimit{Burst: 5, Every: time.Minute}

// DefaultMapDownloadRateLimit is the patch downloads per account.
var DefaultMapDownloadRateLimit = RateLimit{Burst: 10, Every: 6 * time.Second}

func (a *api) mapRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/maps/submissions", a.authed(a.submitMap))
	mux.HandleFunc("GET /api/maps/submissions/mine", a.authed(a.mySubmissions))
	mux.HandleFunc("GET /api/maps/submissions", a.authed(a.submissionQueue))
	mux.HandleFunc("GET /api/maps/submissions/{id}", a.authed(a.submissionDetail))
	mux.HandleFunc("GET /api/maps/submissions/{id}/patch", a.authed(a.submissionPatch))
	mux.HandleFunc("POST /api/maps/submissions/{id}/review", a.authed(a.reviewSubmission))
}

type submissionJSON struct {
	ID          int64                     `json:"id"`
	Title       string                    `json:"title"`
	Description string                    `json:"description"`
	Author      string                    `json:"author"`
	License     string                    `json:"license"`
	Status      string                    `json:"status"`
	SHA256      string                    `json:"sha256"`
	Size        int                       `json:"size"`
	BaseRef     string                    `json:"base_ref"`
	Files       []store.MapSubmissionFile `json:"files"`
	CreatedAt   time.Time                 `json:"created_at"`
	UpdatedAt   time.Time                 `json:"updated_at"`
	ReviewedAt  *time.Time                `json:"reviewed_at,omitempty"`
	Reason      string                    `json:"reason,omitempty"`
	Failure     string                    `json:"failure,omitempty"`
	PRURL       string                    `json:"pr_url,omitempty"`
	PRNumber    int                       `json:"pr_number,omitempty"`
	// HasPatch is false once the patch bytes were dropped (retention, docs/04).
	HasPatch bool `json:"has_patch"`
}

func submissionOut(m store.MapSubmission) submissionJSON {
	out := submissionJSON{
		ID: m.ID, Title: m.Title, Description: m.Description, Author: m.AuthorName, License: m.License,
		Status: m.Status, SHA256: m.SHA256, Size: m.SizeBytes, BaseRef: m.BaseRef, Files: m.Files,
		CreatedAt: m.CreatedAt.UTC(), UpdatedAt: m.UpdatedAt.UTC(), Reason: m.Reason,
		Failure: m.Failure, PRURL: m.PRURL, PRNumber: m.PRNumber, HasPatch: m.HasPatch,
	}
	if out.Files == nil {
		out.Files = []store.MapSubmissionFile{}
	}
	if !m.ReviewedAt.IsZero() {
		t := m.ReviewedAt.UTC()
		out.ReviewedAt = &t
	}
	return out
}

func submissionsOut(ms []store.MapSubmission) []submissionJSON {
	out := make([]submissionJSON, len(ms))
	for i, m := range ms {
		out[i] = submissionOut(m)
	}
	return out
}

type submitRequest struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	CharacterID int64  `json:"character_id"`
	License     string `json:"license"`
	// Patch is the text of the .rpgpatch.json file, as a JSON string.
	Patch string `json:"patch"`
}

type invalidPatchBody struct {
	Error struct {
		Code   string `json:"code"`
		Detail string `json:"detail"`
		File   *int   `json:"file,omitempty"`
	} `json:"error"`
}

func (a *api) submitMap(w http.ResponseWriter, r *http.Request, accountID int64) {
	lim := a.cfg.MapSubmitLimits
	if ok, _ := a.submitLimiter.allow(strconv.FormatInt(accountID, 10)); !ok {
		a.tooMany(w, a.cfg.MapSubmitRateLimit)
		return
	}
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type")
		return
	}
	// An account that would be refused (new, banned, over its daily limit) is refused
	// before a few MB of body are read; the transaction checks again.
	if err := a.cfg.MapSubmissions.CheckSubmitter(r.Context(), accountID, a.cfg.Clock.Now(), lim.PerDay, lim.MinAccountAge); err != nil {
		a.failSubmitter(w, r, err)
		return
	}
	// A JSON string can take up to twice the bytes of its text (quotes, backslashes and
	// newlines are escaped); the text itself is checked against MaxBytes below.
	bodyCap := int64(2*lim.MaxBytes + 16<<10)
	if r.ContentLength > bodyCap {
		writeError(w, http.StatusRequestEntityTooLarge, "patch_too_large")
		return
	}
	// Memory is bounded before a byte of the body is read: every upload in flight holds a
	// slot until it answers (DefaultMapUploadSlots), and a full house answers 503.
	select {
	case a.uploadSlots <- struct{}{}:
		defer func() { <-a.uploadSlots }()
	default:
		writeError(w, http.StatusServiceUnavailable, "busy")
		return
	}
	// The server's 10 s read timeout is short for a few MB; 30 s, then the slot is free.
	// A network deadline, not game logic: it needs the wall clock (a fake clock would
	// expire it at once).
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(uploadTimeout))  //nolint:forbidigo // network deadline
	_ = rc.SetWriteDeadline(time.Now().Add(uploadTimeout)) //nolint:forbidigo // network deadline
	body, err := readBody(w, r, bodyCap)
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "patch_too_large")
			return
		}
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	in, ok := decodeSubmit(body)
	body = nil //nolint:ineffassign,wastedassign // lets the GC take the body during the checks
	if !ok {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	if in.License != MapLicense {
		writeError(w, http.StatusBadRequest, "license_required")
		return
	}
	title, ok := cleanText(in.Title, MapTitleMax, false)
	if !ok || title == "" {
		writeError(w, http.StatusBadRequest, "invalid_title")
		return
	}
	desc, ok := cleanText(in.Description, MapDescriptionMax, true)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_description")
		return
	}
	if len(in.Patch) > lim.MaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "patch_too_large")
		return
	}
	patch := []byte(in.Patch)
	in.Patch = ""
	sum, err := mappatch.Validate(patch, lim.MaxBytes, lim.MaxFiles)
	if err != nil {
		var pe *mappatch.Error
		if !errors.As(err, &pe) {
			a.fail(w, r, err)
			return
		}
		var b invalidPatchBody
		b.Error.Code, b.Error.Detail = "invalid_patch", pe.Code
		if pe.File >= 0 {
			b.Error.File = &pe.File
		}
		writeJSON(w, http.StatusBadRequest, b)
		return
	}
	files := make([]store.MapSubmissionFile, len(sum.Files))
	for i, f := range sum.Files {
		files[i] = store.MapSubmissionFile{Path: f.Path, Action: f.Action}
	}
	m, err := a.cfg.MapSubmissions.CreateMapSubmission(r.Context(), store.NewMapSubmission{
		At: a.cfg.Clock.Now(), AccountID: accountID, CharacterID: in.CharacterID,
		Title: title, Description: desc, License: MapLicense, SHA256: sum.SHA256,
		BaseRef: sum.BaseRef, Files: files, Patch: patch,
		PerDay: lim.PerDay, MinAccountAge: lim.MinAccountAge,
	})
	if errors.Is(err, store.ErrNotFound) {
		// The account was checked a moment ago: what is missing is the character.
		writeError(w, http.StatusNotFound, "character_not_found")
		return
	}
	if err != nil {
		a.failSubmitter(w, r, err)
		return
	}
	a.log.Info("map submission", "id", m.ID, "account", accountID, "files", len(files), "size", m.SizeBytes)
	writeJSON(w, http.StatusCreated, map[string]submissionJSON{"submission": submissionOut(m)})
}

type mineResponse struct {
	Submissions []submissionJSON `json:"submissions"`
	// CanReview: the account is gm or admin (the website shows the queue link).
	CanReview bool `json:"can_review"`
	// Email is the account's own email ("signed in as"); never anybody else's.
	Email   string `json:"email"`
	License string `json:"license"`
	// PRWorker: approved submissions become pull requests on their own (Config.MapPRWorker).
	PRWorker bool `json:"pr_worker"`
	MaxBytes int  `json:"max_bytes"`
	PerDay   int  `json:"per_day"`
}

func (a *api) mySubmissions(w http.ResponseWriter, r *http.Request, accountID int64) {
	role, email, err := a.cfg.MapSubmissions.AccountInfo(r.Context(), accountID)
	if errors.Is(err, store.ErrNotFound) {
		err = auth.ErrUnauthorized // the session outlived its account
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	staff := store.RoleRank(role) >= store.RoleRank(store.RoleGM)
	ms, err := a.cfg.MapSubmissions.AccountMapSubmissions(r.Context(), accountID, mapMinePage)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, mineResponse{
		Submissions: submissionsOut(ms), CanReview: staff, Email: email, License: MapLicense,
		PRWorker: a.cfg.MapPRWorker,
		MaxBytes: a.cfg.MapSubmitLimits.MaxBytes, PerDay: a.cfg.MapSubmitLimits.PerDay,
	})
}

type queueResponse struct {
	Status      string           `json:"status"`
	Submissions []submissionJSON `json:"submissions"`
	// Next is the cursor of the following page; empty on the last one.
	Next string `json:"next,omitempty"`
}

func (a *api) submissionQueue(w http.ResponseWriter, r *http.Request, accountID int64) {
	if !a.requireStaff(w, r, accountID) {
		return
	}
	q := r.URL.Query()
	status := q.Get("status")
	if status == "" {
		status = store.SubmissionPending
	}
	cursor, ok := parseCursor(q.Get("cursor"))
	if !store.ValidSubmissionStatus(status) || !ok {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	ms, err := a.cfg.MapSubmissions.MapSubmissionsByStatus(r.Context(), status, cursor, mapQueuePage)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := queueResponse{Status: status, Submissions: submissionsOut(ms)}
	if len(ms) == mapQueuePage {
		out.Next = formatCursor(ms[len(ms)-1].Cursor())
	}
	writeJSON(w, http.StatusOK, out)
}

// A list cursor in a URL: "<unix microseconds>-<id>" (Postgres keeps microseconds).
func formatCursor(c store.SubmissionCursor) string {
	return strconv.FormatInt(c.At.UnixMicro(), 10) + "-" + strconv.FormatInt(c.ID, 10)
}

func parseCursor(s string) (store.SubmissionCursor, bool) {
	if s == "" {
		return store.SubmissionCursor{}, true
	}
	at, id, ok := strings.Cut(s, "-")
	micros, err1 := strconv.ParseInt(at, 10, 64)
	n, err2 := strconv.ParseInt(id, 10, 64)
	if !ok || err1 != nil || err2 != nil || n <= 0 || micros < 0 {
		return store.SubmissionCursor{}, false
	}
	return store.SubmissionCursor{At: time.UnixMicro(micros).UTC(), ID: n}, true
}

// visibleSubmission loads a submission its author or a moderator may see; anybody else
// gets the same 404 as for a missing one.
func (a *api) visibleSubmission(w http.ResponseWriter, r *http.Request, accountID int64) (store.MapSubmission, bool, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusNotFound, "not_found")
		return store.MapSubmission{}, false, false
	}
	m, err := a.cfg.MapSubmissions.MapSubmission(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found")
		return m, false, false
	}
	if err != nil {
		a.fail(w, r, err)
		return m, false, false
	}
	staff, err := a.isStaff(r.Context(), accountID)
	if err != nil {
		a.fail(w, r, err)
		return m, false, false
	}
	if !staff && m.AccountID != accountID {
		writeError(w, http.StatusNotFound, "not_found")
		return m, false, false
	}
	return m, staff, true
}

func (a *api) submissionDetail(w http.ResponseWriter, r *http.Request, accountID int64) {
	m, _, ok := a.visibleSubmission(w, r, accountID)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]submissionJSON{"submission": submissionOut(m)})
}

// submissionPatch downloads the patch as an attachment that the browser never renders.
// A moderator's download is audited.
func (a *api) submissionPatch(w http.ResponseWriter, r *http.Request, accountID int64) {
	if ok, _ := a.downloadLimiter.allow(strconv.FormatInt(accountID, 10)); !ok {
		a.tooMany(w, a.cfg.MapDownloadRateLimit)
		return
	}
	m, staff, ok := a.visibleSubmission(w, r, accountID)
	if !ok {
		return
	}
	if !m.HasPatch {
		writeError(w, http.StatusGone, "patch_gone")
		return
	}
	select {
	case a.downloadSlots <- struct{}{}:
		defer func() { <-a.downloadSlots }()
	default:
		writeError(w, http.StatusServiceUnavailable, "busy")
		return
	}
	_, sha, patch, err := a.cfg.MapSubmissions.MapSubmissionPatch(r.Context(), m.ID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if patch == nil { // purged since the row above was read
		writeError(w, http.StatusGone, "patch_gone")
		return
	}
	if staff && m.AccountID != accountID {
		err := a.cfg.MapSubmissions.AppendAudit(r.Context(), store.AuditEntry{
			At: a.cfg.Clock.Now(), Source: store.AuditWeb, ActorAccountID: accountID,
			ActorName: store.StaffName(accountID), Action: "map_download",
			TargetAccountID: m.AccountID, TargetName: m.AuthorName,
			Args:   map[string]string{"submission_id": strconv.FormatInt(m.ID, 10), "sha256": sha},
			Result: store.ResultOK,
		})
		if err != nil {
			a.fail(w, r, err)
			return
		}
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Disposition", `attachment; filename="submission-`+strconv.FormatInt(m.ID, 10)+`.rpgpatch.json"`)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.Itoa(len(patch)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(patch)
}

type reviewRequest struct {
	Decision string `json:"decision"` // "approve" or "reject"
	Reason   string `json:"reason"`
}

func (a *api) reviewSubmission(w http.ResponseWriter, r *http.Request, accountID int64) {
	if !a.requireStaff(w, r, accountID) {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	var in reviewRequest
	if !a.decode(w, r, &in) {
		return
	}
	if in.Decision != "approve" && in.Decision != "reject" {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	reason, ok := cleanText(in.Reason, MapReasonMax, true)
	if !ok || (in.Decision == "reject" && reason == "") {
		writeError(w, http.StatusBadRequest, "invalid_reason")
		return
	}
	m, err := a.cfg.MapSubmissions.ReviewMapSubmission(r.Context(), store.ReviewRequest{
		At: a.cfg.Clock.Now(), ID: id, ActorAccountID: accountID,
		Approve: in.Decision == "approve", Reason: reason,
	})
	if err != nil {
		a.failSubmission(w, r, err, "not_found")
		return
	}
	a.log.Info("map submission reviewed", "id", id, "by", accountID, "status", m.Status)
	writeJSON(w, http.StatusOK, map[string]submissionJSON{"submission": submissionOut(m)})
}

func (a *api) isStaff(ctx context.Context, accountID int64) (bool, error) {
	role, _, err := a.cfg.MapSubmissions.AccountInfo(ctx, accountID)
	if errors.Is(err, store.ErrNotFound) {
		return false, auth.ErrUnauthorized // the session outlived its account
	}
	if err != nil {
		return false, err
	}
	return store.RoleRank(role) >= store.RoleRank(store.RoleGM), nil
}

// requireStaff answers 403 forbidden unless the account is gm or admin now (the role is
// read on every request: a revoked role stops working at once).
func (a *api) requireStaff(w http.ResponseWriter, r *http.Request, accountID int64) bool {
	staff, err := a.isStaff(r.Context(), accountID)
	if err != nil {
		a.fail(w, r, err)
		return false
	}
	if !staff {
		a.log.Warn("map submissions: staff endpoint refused", "account", accountID, "path", r.URL.Path)
		writeError(w, http.StatusForbidden, "forbidden")
	}
	return staff
}

// failSubmitter answers why the account cannot submit: banned or disabled is
// account_blocked (not the moderation pages' forbidden), the rest as failSubmission.
func (a *api) failSubmitter(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, store.ErrForbidden) {
		writeError(w, http.StatusForbidden, "account_blocked")
		return
	}
	a.failSubmission(w, r, err, "unauthorized")
}

// readBody reads a whole request body of at most limit bytes into one buffer sized from
// Content-Length when the client sent it (json.Decoder would grow its own by doubling).
func readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	body := http.MaxBytesReader(w, r.Body, limit)
	if n := r.ContentLength; n >= 0 && n <= limit {
		buf := make([]byte, n)
		if _, err := io.ReadFull(body, buf); err != nil {
			return nil, err
		}
		// Nothing may follow what Content-Length announced.
		if k, err := body.Read(make([]byte, 1)); k > 0 || (err != nil && !errors.Is(err, io.EOF)) {
			if err == nil {
				err = errors.New("body longer than Content-Length")
			}
			return nil, err
		}
		return buf, nil
	}
	return io.ReadAll(body)
}

// submitFields are the only keys of an upload; the check is byte for byte because
// encoding/json matches struct fields without case.
var submitFields = map[string]bool{"title": true, "description": true, "character_id": true, "license": true, "patch": true}

// skipJSON reads any JSON value without keeping it.
type skipJSON struct{}

func (*skipJSON) UnmarshalJSON([]byte) error { return nil }

// decodeSubmit decodes an upload body: one JSON object with only submitFields.
func decodeSubmit(body []byte) (submitRequest, bool) {
	var keys map[string]skipJSON
	if json.Unmarshal(body, &keys) != nil || keys == nil {
		return submitRequest{}, false
	}
	for k := range keys {
		if !submitFields[k] {
			return submitRequest{}, false
		}
	}
	var in submitRequest
	if json.Unmarshal(body, &in) != nil {
		return submitRequest{}, false
	}
	return in, true
}

// failSubmission maps the store's submission errors; notFound is the code of ErrNotFound.
func (a *api) failSubmission(w http.ResponseWriter, r *http.Request, err error, notFound string) {
	switch {
	case errors.Is(err, store.ErrSubmitLimit):
		writeError(w, http.StatusTooManyRequests, "submit_limit")
	case errors.Is(err, store.ErrAccountTooNew):
		writeError(w, http.StatusForbidden, "account_too_new")
	case errors.Is(err, store.ErrDuplicateSubmission):
		writeError(w, http.StatusConflict, "duplicate_submission")
	case errors.Is(err, store.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, store.ErrNotPending):
		writeError(w, http.StatusConflict, "not_pending")
	case errors.Is(err, store.ErrOwnSubmission):
		writeError(w, http.StatusForbidden, "own_submission")
	case errors.Is(err, store.ErrNotFound) && notFound == "unauthorized":
		writeError(w, http.StatusUnauthorized, notFound)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, notFound)
	default:
		a.fail(w, r, err)
	}
}

// cleanText trims s and checks it: at most max characters, valid UTF-8, no control
// characters (newlines and tabs only if multiline; CR LF becomes LF) and no bidirectional
// overrides, which could make a title read differently in the queue or in the PR.
func cleanText(s string, maxChars int, multiline bool) (string, bool) {
	if !utf8.ValidString(s) {
		return "", false
	}
	s = strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
	if utf8.RuneCountInString(s) > maxChars {
		return "", false
	}
	for _, c := range s {
		switch {
		case multiline && (c == '\n' || c == '\t'):
		case unicode.IsControl(c), mappatch.ForbiddenRune(c), unicode.Is(unicode.Bidi_Control, c),
			c == '\u2028', c == '\u2029':
			return "", false
		}
	}
	return s, true
}

func mapLimitsOrDefault(l MapSubmitLimits) MapSubmitLimits {
	d := DefaultMapSubmitLimits
	if l.MaxBytes <= 0 {
		l.MaxBytes = d.MaxBytes
	}
	if l.MaxFiles <= 0 {
		l.MaxFiles = d.MaxFiles
	}
	if l.PerDay <= 0 {
		l.PerDay = d.PerDay
	}
	if l.MinAccountAge < 0 {
		l.MinAccountAge = 0
	}
	return l
}
