//go:build integration

package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// Roles, bans and the audit log (T2.6).
func TestRolesBansAudit(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_admin"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

	gmAcc, _ := st.CreateAccount(ctx, "gm@example.org", "h")
	plAcc, _ := st.CreateAccount(ctx, "pl@example.org", "h")
	gm, _ := st.CreateCharacter(ctx, store.NewCharacter{AccountID: gmAcc, Name: "Warden", Vocation: "guardian", Health: 150}, 5)
	pl, _ := st.CreateCharacter(ctx, store.NewCharacter{AccountID: plAcc, Name: "Old Tom", Vocation: "guardian", Health: 150}, 5)

	// New accounts are players; the schema refuses unknown roles.
	if pc, err := st.PlayCharacter(ctx, gmAcc, gm.ID, now); err != nil || pc.Role != store.RolePlayer {
		t.Fatalf("default role %q, %v", pc.Role, err)
	}
	if _, err := conn.Exec(ctx, "UPDATE accounts SET role = 'god' WHERE id = $1", gmAcc); err == nil {
		t.Fatal("unknown role accepted")
	}

	// The operator's tool sets roles, audited in the same transaction.
	cli := store.AuditEntry{At: now, Source: store.AuditCLI, ActorName: "cli:ops", Args: map[string]string{"note": "new GM"}}
	id, old, err := st.SetRole(ctx, "gm@example.org", store.RoleGM, cli)
	if err != nil || id != gmAcc || old != store.RolePlayer {
		t.Fatalf("SetRole = %d %q %v", id, old, err)
	}
	if _, _, err := st.SetRole(ctx, "nobody@example.org", store.RoleGM, cli); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown email: %v", err)
	}
	if _, _, err := st.SetRole(ctx, "gm@example.org", "god", cli); err == nil {
		t.Fatal("invalid role accepted")
	}
	if pc, _ := st.PlayCharacter(ctx, gmAcc, gm.ID, now); pc.Role != store.RoleGM {
		t.Fatalf("role after SetRole: %q", pc.Role)
	}

	// The player has a token; a ban revokes it and hides the account from logins.
	tok := store.Session{TokenHash: hash("pl"), AccountID: plAcc, Kind: store.SessionAccount, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	if err := st.CreateSession(ctx, tok); err != nil {
		t.Fatal(err)
	}
	actor := store.AuditEntry{At: now, Source: store.AuditGame, ActorAccountID: gmAcc, ActorCharacterID: gm.ID, ActorName: "Warden",
		Action: "ban", Args: map[string]string{"duration": "1d", "reason": "botting"}}
	gmRank := store.RoleRank(store.RoleGM)
	res, err := st.Ban(ctx, store.BanRequest{Audit: actor, TargetName: "old tom", ActorRank: gmRank, Reason: "botting", ExpiresAt: now.Add(24 * time.Hour)})
	if err != nil || res.Result != store.ResultOK || res.AccountID != plAcc || res.CharacterID != pl.ID || res.Name != "Old Tom" {
		t.Fatalf("Ban = %+v, %v", res, err)
	}
	if _, err := st.ActiveSession(ctx, tok.TokenHash, store.SessionAccount, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("token survived the ban: %v", err)
	}
	b, err := st.ActiveBan(ctx, plAcc, now.Add(time.Hour))
	if err != nil || b.Reason != "botting" || !b.ExpiresAt.Equal(now.Add(24*time.Hour)) || b.Permanent() {
		t.Fatalf("ActiveBan = %+v, %v", b, err)
	}
	if _, err := st.PlayCharacter(ctx, plAcc, pl.ID, now.Add(time.Hour)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("banned character loaded: %v", err)
	}
	// A token issued after the ban (it would not be: login refuses) still does not work.
	tok2 := store.Session{TokenHash: hash("pl2"), AccountID: plAcc, Kind: store.SessionPlay, CharacterID: pl.ID, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	_ = st.CreateSession(ctx, tok2)
	if _, err := st.ConsumeSession(ctx, tok2.TokenHash, store.SessionPlay, now.Add(time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("play token of a banned account: %v", err)
	}
	// The ban ends on its own.
	if _, err := st.ActiveBan(ctx, plAcc, now.Add(25*time.Hour)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired ban still active: %v", err)
	}
	if _, err := st.PlayCharacter(ctx, plAcc, pl.ID, now.Add(25*time.Hour)); err != nil {
		t.Fatalf("after the ban: %v", err)
	}

	// Staff of the same rank and missing characters are not banned, but audited.
	res, _ = st.Ban(ctx, store.BanRequest{Audit: actor, TargetName: "Warden", ActorRank: gmRank, Reason: "x", ExpiresAt: now.Add(time.Hour)})
	if res.Result != store.ResultProtected {
		t.Fatalf("self ban: %+v", res)
	}
	res, _ = st.Ban(ctx, store.BanRequest{Audit: actor, TargetName: "Nobody", ActorRank: gmRank, Reason: "x", ExpiresAt: now.Add(time.Hour)})
	if res.Result != store.ResultNotFound {
		t.Fatalf("missing: %+v", res)
	}
	if _, err := st.ActiveBan(ctx, gmAcc, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("a protected account was banned")
	}

	// Only admins (by their role now, not the cached one) ban permanently or for long.
	res, _ = st.Ban(ctx, store.BanRequest{Audit: actor, TargetName: "Old Tom", ActorRank: 2, Reason: "cheating"})
	if res.Result != store.ResultProtected {
		t.Fatalf("permanent ban by a GM claiming admin: %+v", res)
	}
	res, _ = st.Ban(ctx, store.BanRequest{Audit: actor, TargetName: "Old Tom", ActorRank: gmRank, Reason: "x", ExpiresAt: now.Add(31 * 24 * time.Hour)})
	if res.Result != store.ResultProtected {
		t.Fatalf("31-day ban by a GM: %+v", res)
	}
	adAcc, _ := st.CreateAccount(ctx, "ad@example.org", "h")
	ad, _ := st.CreateCharacter(ctx, store.NewCharacter{AccountID: adAcc, Name: "Keeper", Vocation: "guardian", Health: 150}, 5)
	if _, _, err := st.SetRole(ctx, "ad@example.org", store.RoleAdmin, cli); err != nil {
		t.Fatal(err)
	}
	admin := actor
	admin.ActorAccountID, admin.ActorCharacterID, admin.ActorName = adAcc, ad.ID, "Keeper"

	// A permanent ban outlasts a timed one; unban lifts both.
	_, _ = st.Ban(ctx, store.BanRequest{Audit: admin, TargetName: "Old Tom", ActorRank: 2, Reason: "cheating"})
	_, _ = st.Ban(ctx, store.BanRequest{Audit: actor, TargetName: "Old Tom", ActorRank: gmRank, Reason: "spam", ExpiresAt: now.Add(time.Hour)})
	if b, err := st.ActiveBan(ctx, plAcc, now.Add(1000*time.Hour)); err != nil || !b.Permanent() || b.Reason != "cheating" {
		t.Fatalf("permanent ban %+v, %v", b, err)
	}
	unban := actor
	unban.Action, unban.Args = "unban", nil
	// A GM cannot lift a permanent ban, nor unban staff of its rank.
	if res, _ := st.Unban(ctx, store.BanRequest{Audit: unban, TargetName: "Old Tom", ActorRank: gmRank}); res.Result != store.ResultProtected {
		t.Fatalf("GM lifting a permanent ban: %+v", res)
	}
	if res, _ := st.Unban(ctx, store.BanRequest{Audit: unban, TargetName: "Keeper", ActorRank: gmRank}); res.Result != store.ResultProtected {
		t.Fatalf("GM unbanning an admin: %+v", res)
	}
	unban.ActorAccountID, unban.ActorCharacterID, unban.ActorName = adAcc, ad.ID, "Keeper"
	if res, err := st.Unban(ctx, store.BanRequest{Audit: unban, TargetName: "Old Tom", ActorRank: 2}); err != nil || res.Result != store.ResultOK {
		t.Fatalf("Unban = %+v, %v", res, err)
	}
	if _, err := st.ActiveBan(ctx, plAcc, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("ban not lifted")
	}
	if res, _ := st.Unban(ctx, store.BanRequest{Audit: unban, TargetName: "Old Tom", ActorRank: 2}); res.Result != store.ResultNotBanned {
		t.Fatalf("second unban: %+v", res)
	}
	var lifted int
	_ = conn.QueryRow(ctx, "SELECT count(*) FROM account_bans WHERE lifted_by = $1", adAcc).Scan(&lifted)
	if lifted != 3 { // every ban still active at the unban's time (now)
		t.Fatalf("lifted bans = %d, want 3", lifted)
	}

	// Plain audit entries, then the whole log, newest first.
	if err := st.AppendAudit(ctx, store.AuditEntry{At: now, Source: store.AuditGame, ActorAccountID: gmAcc, ActorName: "Warden",
		Action: "announce", Args: map[string]string{"text": "hi"}, Result: "ok"}); err != nil {
		t.Fatal(err)
	}
	es, err := st.ListAudit(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range es {
		got = append(got, e.Action+":"+e.Result)
	}
	want := []string{"announce:ok", "unban:not_banned", "unban:ok", "unban:protected", "unban:protected", "ban:ok", "ban:ok",
		"set_role:ok", "ban:protected", "ban:protected", "ban:not_found", "ban:protected", "ban:ok", "set_role:ok"}
	if len(got) != len(want) {
		t.Fatalf("audit %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("audit %v, want %v", got, want)
		}
	}
	if e := es[len(es)-1]; e.Source != store.AuditCLI || e.ActorName != "cli:ops" || e.TargetAccountID != gmAcc ||
		e.Args["old"] != "player" || e.Args["new"] != "gm" || e.Args["note"] != "new GM" || !e.At.Equal(now) || e.TargetName != "" {
		t.Fatalf("set_role entry %+v", e)
	}
	if e := es[len(es)-2]; e.TargetName != "Old Tom" || e.TargetCharacterID != pl.ID || e.Args["reason"] != "botting" {
		t.Fatalf("ban entry %+v", e)
	}

	// A demoted GM loses its bans at once, whatever the loop cached at login, and its
	// tokens are revoked.
	gmTok := store.Session{TokenHash: hash("gm"), AccountID: gmAcc, Kind: store.SessionAccount, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	_ = st.CreateSession(ctx, gmTok)
	if _, _, err := st.SetRole(ctx, "gm@example.org", store.RolePlayer, cli); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ActiveSession(ctx, gmTok.TokenHash, store.SessionAccount, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("token survived the demotion: %v", err)
	}
	if res, _ := st.Ban(ctx, store.BanRequest{Audit: actor, TargetName: "Old Tom", ActorRank: gmRank, Reason: "x", ExpiresAt: now.Add(time.Hour)}); res.Result != store.ResultProtected {
		t.Fatalf("ban by a demoted GM: %+v", res)
	}
	want = append([]string{"ban:protected", "set_role:ok"}, want...)

	// The log is append-only and survives the deletion of the accounts it names.
	for _, sql := range []string{"UPDATE audit_log SET result = 'x'", "DELETE FROM audit_log", "TRUNCATE audit_log"} {
		if _, err := conn.Exec(ctx, sql); err == nil {
			t.Errorf("%s: allowed", sql)
		}
	}
	if _, err := conn.Exec(ctx, "DELETE FROM accounts"); err != nil {
		t.Fatal(err)
	}
	var rows int
	_ = conn.QueryRow(ctx, "SELECT count(*) FROM audit_log").Scan(&rows)
	if rows != len(want) {
		t.Fatalf("audit rows after deleting accounts = %d", rows)
	}
}
