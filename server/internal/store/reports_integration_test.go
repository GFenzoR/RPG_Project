//go:build integration

package store_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// The economy log in batches and the report queue (T4.1).
func TestEconomyLogAndReports(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_reports"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)

	es := []store.EconomyEntry{
		{At: now, Kind: "loot", CharacterID: 7, Amount: 40, Ref: "wolf"},
		{At: now, Kind: "npc_sell", CharacterID: 7, ItemID: 120, Count: -3, Ref: "puerto_provisioner"},
		{At: now, Kind: "loot", CharacterID: 8, ItemID: 5, Count: 1},
	}
	if err := st.AppendEconomy(ctx, "b1", es); err != nil {
		t.Fatal(err)
	}
	// A retry of the same batch (its commit was not acknowledged) writes nothing twice.
	if err := st.AppendEconomy(ctx, "b1", es); err != nil {
		t.Fatal(err)
	}
	got, err := st.ListEconomy(ctx, 7, 10)
	if err != nil || len(got) != 2 {
		t.Fatalf("ListEconomy = %+v, %v", got, err)
	}
	if g := got[0]; g.Kind != "npc_sell" || g.ItemID != 120 || g.Count != -3 || g.Amount != 0 || g.Ref != "puerto_provisioner" {
		t.Fatalf("newest %+v", g)
	}
	if g := got[1]; g.Amount != 40 || g.ItemID != 0 || g.Ref != "wolf" || !g.At.Equal(now) {
		t.Fatalf("oldest %+v", g)
	}
	if _, err := conn.Exec(ctx, "UPDATE economy_log SET amount = 1"); err == nil {
		t.Fatal("economy_log is not append-only")
	}

	rctx, _ := json.Marshal(map[string]any{"target_pos": map[string]int{"x": 1, "y": 2, "z": 7}})
	r := store.Report{At: now, ReporterAccountID: 1, ReporterCharacterID: 11, ReporterName: "Ana",
		TargetAccountID: 2, TargetCharacterID: 22, TargetName: "Bob", Reason: "spam", Context: rctx}
	audit := store.AuditEntry{At: now, Source: store.AuditGame, ActorAccountID: 1, ActorName: "Ana", Action: "report",
		TargetAccountID: 2, TargetName: "Bob", Result: store.ResultOK}
	id, err := st.CreateReport(ctx, r, audit)
	if err != nil || id <= 0 {
		t.Fatalf("CreateReport = %d, %v", id, err)
	}
	r.Reason = ""
	if _, err := st.CreateReport(ctx, r, audit); err == nil {
		t.Fatal("empty reason accepted")
	}
	gmAudit := store.AuditEntry{At: now.Add(time.Minute), Source: store.AuditGame, ActorAccountID: 9, ActorName: "Warden", Action: "list_reports"}
	open, err := st.ListReportsAudited(ctx, 10, gmAudit)
	if err != nil || len(open) != 1 || open[0].ID != id || open[0].TargetName != "Bob" || open[0].Reason != "spam" {
		t.Fatalf("open reports = %+v, %v", open, err)
	}
	var pos struct {
		TargetPos struct{ X, Y, Z int } `json:"target_pos"`
	}
	if err := json.Unmarshal(open[0].Context, &pos); err != nil || pos.TargetPos.Y != 2 {
		t.Fatalf("context %s: %v", open[0].Context, err)
	}
	gmAudit.Action = "close_report"
	for _, c := range []struct {
		id   int64
		want string
	}{{id, store.ResultOK}, {id, store.ResultNotOpen}, {id + 100, store.ResultNotFound}} {
		if res, err := st.CloseReport(ctx, c.id, "warned", gmAudit); err != nil || res != c.want {
			t.Fatalf("CloseReport(%d) = %q, %v; want %q", c.id, res, err, c.want)
		}
	}
	if open, _ := st.OpenReports(ctx, 10); len(open) != 0 {
		t.Fatalf("still open: %+v", open)
	}
	log, _ := st.ListAudit(ctx, 10)
	if len(log) != 5 || log[4].Action != "report" || log[4].Args["report_id"] == "" || log[3].Args["listed"] != "1" ||
		log[2].Result != store.ResultOK || log[1].Result != store.ResultNotOpen || log[0].Result != store.ResultNotFound {
		t.Fatalf("audit %+v", log)
	}
}
