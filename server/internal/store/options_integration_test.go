//go:build integration

package store_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/accountopts"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// Migration 00029 (docs/02 "Opciones guardadas"): a character from before it has the
// defaults (balanced, not chasing, safe mode on); what the game saves comes back; the
// stance column is bounded. The account's interface document is one row per account,
// replaced by each save, never another account's, and capped in size.
func TestSavedOptionsMigration(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_saved_options"
	st := storetest.Open(t, schema, false)
	conn := storetest.Conn(t, schema)
	if err := st.MigrateUpTo(ctx, 28); err != nil {
		t.Fatal(err)
	}
	var acc, other, old int64
	if err := conn.QueryRow(ctx, `INSERT INTO accounts (email) VALUES ('opts@example.org') RETURNING id`).Scan(&acc); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO accounts (email) VALUES ('other@example.org') RETURNING id`).Scan(&other); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO characters (account_id, name, vocation, health, mana)
		VALUES ($1, 'Antigua', 'guardian', 150, 30) RETURNING id`, acc).Scan(&old); err != nil {
		t.Fatal(err)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)

	pc, err := st.PlayCharacter(ctx, acc, old, now)
	if err != nil {
		t.Fatal(err)
	}
	if want := (store.GameOptions{Stance: 2}); pc.Options != want {
		t.Fatalf("an existing character's options %+v, want %+v", pc.Options, want)
	}
	chosen := store.GameOptions{Stance: 3, Chase: true, Unsafe: true}
	if err := st.SaveCharacterState(ctx, store.CharacterState{ID: old, Level: 1, Health: 1, X: 5, Y: 5, Z: 7,
		Options: chosen, SavedAt: now}); err != nil {
		t.Fatal(err)
	}
	if pc, err = st.PlayCharacter(ctx, acc, old, now); err != nil || pc.Options != chosen {
		t.Fatalf("saved options %+v, want %+v (%v)", pc.Options, chosen, err)
	}
	// A snapshot without options (the zero value) and a junk stance are saved balanced.
	for _, o := range []store.GameOptions{{}, {Stance: 9}} {
		if err := st.SaveCharacterState(ctx, store.CharacterState{ID: old, Level: 1, Health: 1, X: 5, Y: 5, Z: 7,
			Options: o, SavedAt: now}); err != nil {
			t.Fatal(err)
		}
		if pc, err = st.PlayCharacter(ctx, acc, old, now); err != nil || pc.Options != (store.GameOptions{Stance: 2}) {
			t.Fatalf("options %+v saved as %+v (%v), want balanced", o, pc.Options, err)
		}
	}
	if _, err := conn.Exec(ctx, `UPDATE characters SET opt_stance = 4 WHERE id = $1`, old); err == nil {
		t.Fatal("stance 4 accepted by the table")
	}

	// The account document.
	if doc, err := st.AccountOptions(ctx, acc); err != nil || doc != nil {
		t.Fatalf("options of an account that never saved = %q, %v", doc, err)
	}
	if err := st.SaveAccountOptions(ctx, acc, []byte(`{"v":1,"lang":"es"}`), now); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveAccountOptions(ctx, acc, []byte(`{"v":1,"lang":"en"}`), now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	doc, err := st.AccountOptions(ctx, acc)
	if err != nil || !strings.Contains(string(doc), `"en"`) || strings.Contains(string(doc), `"es"`) {
		t.Fatalf("account options = %q, %v; want the last document", doc, err)
	}
	if doc, err := st.AccountOptions(ctx, other); err != nil || doc != nil {
		t.Fatalf("another account reads %q, %v", doc, err)
	}
	// The largest document the API accepts (16 KiB of window places, the densest JSONB
	// there is in the schema) fits the table's cap.
	fullest := fullestOptions(t)
	if err := st.SaveAccountOptions(ctx, acc, fullest, now); err != nil {
		t.Fatalf("a valid document of the largest size is refused by the table: %v", err)
	}
	// And reads back: JSONB returns it spaced its own way, longer than the API's limit,
	// which accountopts.ParseStored accepts and Parse would not.
	stored, err := st.AccountOptions(ctx, acc)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) <= accountopts.MaxBytes {
		t.Fatalf("the fullest document reads back as %d bytes: no longer than the limit, so this proves nothing", len(stored))
	}
	back, err := accountopts.ParseStored(stored)
	if err != nil {
		t.Fatalf("the fullest document does not read back (%d bytes saved, %d read): %v", len(fullest), len(stored), err)
	}
	if again, err := back.Canonical(); err != nil || string(again) != string(fullest) {
		t.Fatalf("the fullest document reads back different (%v)", err)
	}
	huge := `{"v":1,"lang":"` + strings.Repeat("x", 100000) + `"}`
	if err := st.SaveAccountOptions(ctx, acc, []byte(huge), now); err == nil {
		t.Fatal("a 100 kB document accepted by the table")
	}
	if err := st.SaveAccountOptions(ctx, acc, []byte(`[1]`), now); err == nil {
		t.Fatal("a document that is not an object accepted by the table")
	}

	// UpdateAccountOptions: the merge sees what is stored (nil: never saved), its error
	// writes nothing, and the saves of one account are one after another.
	errMerge := errors.New("merge refused")
	if err := st.UpdateAccountOptions(ctx, other, now, func(stored []byte) ([]byte, error) {
		if stored != nil {
			t.Errorf("an account that never saved merges over %q", stored)
		}
		return nil, errMerge
	}); !errors.Is(err, errMerge) {
		t.Fatalf("the merge's error came back as %v", err)
	}
	if doc, err := st.AccountOptions(ctx, other); err != nil || doc != nil {
		t.Fatalf("a refused merge stored %q, %v", doc, err)
	}
	if err := st.UpdateAccountOptions(ctx, 999999, now, func([]byte) ([]byte, error) {
		t.Error("merge called for an account that does not exist")
		return []byte(`{"v":1}`), nil
	}); err == nil {
		t.Fatal("an account that does not exist saved options")
	}
	const saves = 12
	var wg sync.WaitGroup
	errs := make(chan error, saves)
	for range saves {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- st.UpdateAccountOptions(ctx, other, now, func(stored []byte) ([]byte, error) {
				d := accountopts.Empty()
				if stored != nil {
					var err error
					if d, err = accountopts.ParseStored(stored); err != nil {
						return nil, err
					}
				}
				n := 0
				if d.ChatOpacity != nil {
					n = *d.ChatOpacity
				}
				n++
				d.ChatOpacity = &n
				return d.Canonical()
			})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("a concurrent save: %v", err)
		}
	}
	doc, err = st.AccountOptions(ctx, other)
	if err != nil {
		t.Fatal(err)
	}
	if d, err := accountopts.ParseStored(doc); err != nil || d.ChatOpacity == nil || *d.ChatOpacity != saves {
		t.Fatalf("%d concurrent saves left %s (%v): some read the document before another wrote it", saves, doc, err)
	}
	// A save that waits behind another gives up with its context.
	held, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- st.UpdateAccountOptions(ctx, other, now, func(stored []byte) ([]byte, error) {
			close(held)
			<-release
			return stored, nil
		})
	}()
	<-held
	short, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	err = st.UpdateAccountOptions(short, other, now, func([]byte) ([]byte, error) {
		t.Error("the waiting save merged while the other held the account")
		return []byte(`{"v":1}`), nil
	})
	cancel()
	close(release)
	if err == nil {
		t.Fatal("a save behind another did not give up with its context")
	}
	if err := <-done; err != nil {
		t.Fatalf("the save that held the account: %v", err)
	}

	if err := st.MigrateDownAll(ctx); err != nil {
		t.Fatal(err)
	}
}

// fullestOptions is a valid document as close to accountopts.MaxBytes as window places
// get: both device classes, every window with its six fields.
func fullestOptions(t *testing.T) []byte {
	t.Helper()
	var best []byte
	for n := 1; n <= accountopts.MaxWindows; n++ {
		var places []string
		for i := range n {
			places = append(places, fmt.Sprintf(`"w%d":{"open":true,"collapsed":false,"x":%d,"y":-%d,"w":7,"h":9}`, i, i, i))
		}
		p := strings.Join(places, ",")
		dev := `{"touch_pad":true,"zoom":2,"minimap":{"open":true,"scale":2},"windows":{"v":3,"z":[],"win":{` + p + `},"others":{` + p + `}}}`
		doc, err := accountopts.Parse([]byte(`{"v":1,"devices":{"desktop":` + dev + `,"touch":` + dev + `}}`))
		if err != nil {
			break // over MaxBytes
		}
		if best, err = doc.Canonical(); err != nil {
			t.Fatal(err)
		}
	}
	if len(best) < accountopts.MaxBytes*3/4 {
		t.Fatalf("the fullest document is only %d bytes", len(best))
	}
	return best
}
