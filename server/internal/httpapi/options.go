package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/accountopts"
)

// Interface options of the account (docs/05 "Opciones de la cuenta", owner decision
// 2026-11-26). The document is untrusted input stored and served back: only the session's
// own account is ever read or written (the id comes from authed, never from the request),
// every save is parsed by accountopts (closed schema, bounded) and stored in the
// canonical form the server builds, and saves are limited per account.

// AccountOptions stores the interface options document of each account. *store.Store
// implements it.
type AccountOptions interface {
	// AccountOptions returns the stored document, nil if the account never saved one.
	AccountOptions(ctx context.Context, accountID int64) ([]byte, error)
	SaveAccountOptions(ctx context.Context, accountID int64, doc []byte, now time.Time) error
}

// DefaultOptionsRateLimit limits POST /api/account/options per account. The client saves
// at most once every few seconds while the player changes options.
var DefaultOptionsRateLimit = RateLimit{Burst: 20, Every: 3 * time.Second}

func (a *api) optionsRoutes(mux *http.ServeMux) {
	if a.cfg.Options == nil {
		return
	}
	mux.HandleFunc("GET /api/account/options", a.authed(shortDBRoute(a.getOptions)))
	mux.HandleFunc("POST /api/account/options", a.authed(a.optionsLimited(shortDBRoute(a.saveOptions))))
}

func (a *api) optionsLimited(next authedFunc) authedFunc {
	return func(w http.ResponseWriter, r *http.Request, accountID int64) {
		if ok, _ := a.optionsLimiter.allow(strconv.FormatInt(accountID, 10)); !ok {
			a.tooMany(w, a.cfg.OptionsRateLimit)
			return
		}
		next(w, r, accountID)
	}
}

type optionsJSON struct {
	Options *accountopts.Doc `json:"options"`
	// Account tells one account from another on a shared browser: the client does not
	// fill a document with what another account left in localStorage. A tag, not the id.
	Account string `json:"account"`
}

// optionsTag is the tag of an account in optionsJSON: stable, and of no use to the API.
func optionsTag(accountID int64) string {
	sum := sha256.Sum256([]byte("rpg-account-options:" + strconv.FormatInt(accountID, 10)))
	return hex.EncodeToString(sum[:8])
}

// optionsStripes bounds the locks that make a save's read, merge and write one step per
// account (the game server is one process: docs/01).
const optionsStripes = 64

// getOptions answers the account's document, the empty one ({"v":1}) if it never saved.
// A stored document this server no longer accepts (an older schema) reads as empty: the
// client fills it again from what it has.
func (a *api) getOptions(w http.ResponseWriter, r *http.Request, accountID int64) {
	raw, err := a.cfg.Options.AccountOptions(r.Context(), accountID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	doc := accountopts.Empty()
	if raw != nil {
		if d, err := accountopts.Parse(raw); err == nil {
			doc = d
		}
	}
	writeJSON(w, http.StatusOK, optionsJSON{Options: doc, Account: optionsTag(accountID)})
}

// saveOptions replaces the account's document with the one in the body, except the
// sections of the device classes the body does not bring, which stay as stored (a save
// speaks for its own kind of screen: accountopts.KeepMissingDevices). Like decode
// (Content-Type application/json: no cross-site form can send it), with the document's
// own size limit and schema.
func (a *api) saveOptions(w http.ResponseWriter, r *http.Request, accountID int64) {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, accountopts.MaxBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large")
			return
		}
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	doc, err := accountopts.Parse(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	// Two saves of one account (the computer and the phone) must not interleave between
	// the read and the write.
	lock := &a.optionsLocks[uint64(accountID)%optionsStripes]
	lock.Lock()
	defer lock.Unlock()
	stored, err := a.cfg.Options.AccountOptions(r.Context(), accountID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if stored != nil {
		// A stored document this server no longer accepts has nothing worth keeping.
		if old, err := accountopts.Parse(stored); err == nil {
			doc.KeepMissingDevices(old)
		}
	}
	// With the kept sections the document may not fit any more: refused, like one sent
	// too large.
	canon, err := doc.Canonical()
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	if err := a.cfg.Options.SaveAccountOptions(r.Context(), accountID, canon, a.cfg.Clock.Now()); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
