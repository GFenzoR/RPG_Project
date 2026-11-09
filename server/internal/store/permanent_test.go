package store

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestPermanent(t *testing.T) {
	for code, want := range map[string]bool{"23514": true, "22003": true, "23505": true, "40001": false, "57014": false, "08006": false} {
		err := fmt.Errorf("save: %w", &pgconn.PgError{Code: code})
		if got := Permanent(err); got != want {
			t.Errorf("%s: %v, want %v", code, got, want)
		}
	}
	if Permanent(errors.New("timeout")) || Permanent(nil) {
		t.Error("non-Postgres errors are not permanent")
	}
	// The store's own guild refusals (no pg error inside) are permanent too (T5.1).
	if !Permanent(fmt.Errorf("guild change: %w: unknown op 99", ErrGuildConflict)) {
		t.Error("ErrGuildConflict is not permanent")
	}
}
