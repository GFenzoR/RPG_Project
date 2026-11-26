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
	// AccountOptions returns the stored document as the database spells it
	// (accountopts.ParseStored reads it), nil if the account never saved one.
	AccountOptions(ctx context.Context, accountID int64) ([]byte, error)
	// UpdateAccountOptions replaces the document with merge(stored), stored being what
	// AccountOptions would return. The read and the write are one step per account: two
	// saves of one account never interleave, whatever process they come from. An error of
	// merge is returned as it is and nothing is written.
	UpdateAccountOptions(ctx context.Context, accountID int64, now time.Time, merge func(stored []byte) ([]byte, error)) error
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
	// fill a document with what another account left in localStorage.
	Account string `json:"account"`
}

// optionsTag is the tag of an account in optionsJSON: stable (the client keeps it in
// localStorage across server restarts) and of no use to the API. It is an unkeyed hash of
// a sequential id, so whoever holds a tag can find the id by trying them all: it is only
// ever sent to the account itself. Shown to anyone else it would have to be keyed.
func optionsTag(accountID int64) string {
	sum := sha256.Sum256([]byte("rpg-account-options:" + strconv.FormatInt(accountID, 10)))
	return hex.EncodeToString(sum[:8])
}

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
		if d, err := accountopts.ParseStored(raw); err == nil {
			doc = d
		}
	}
	writeJSON(w, http.StatusOK, optionsJSON{Options: doc, Account: optionsTag(accountID)})
}

// saveOptions replaces the account's document with the one in the body, except the
// sections of the device classes the body does not bring, which stay as stored (a save
// speaks for its own kind of screen: accountopts.CanonicalKeeping). Like decode
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
	// What the save brings must stand alone; then it is merged with what is stored, in
	// one step per account (the computer and the phone may save at once).
	if _, err := doc.Canonical(); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	err = a.cfg.Options.UpdateAccountOptions(r.Context(), accountID, a.cfg.Clock.Now(), func(stored []byte) ([]byte, error) {
		// A stored document this server no longer accepts has nothing worth keeping.
		var old *accountopts.Doc
		if stored != nil {
			if d, err := accountopts.ParseStored(stored); err == nil {
				old = d
			}
		}
		return doc.CanonicalKeeping(old)
	})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
