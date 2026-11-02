package store

import "testing"

func TestMigrationConfig(t *testing.T) {
	cfg, err := migrationConfig("postgres://u:p@localhost:5432/db?pool_max_conns=20&pool_min_conns=2&statement_timeout=500&search_path=x")
	if err != nil {
		t.Fatal(err)
	}
	for k := range cfg.RuntimeParams {
		if len(k) >= 5 && k[:5] == "pool_" {
			t.Errorf("pool option %q leaked into runtime params", k)
		}
	}
	if got := cfg.RuntimeParams["statement_timeout"]; got != "0" {
		t.Errorf("statement_timeout = %q, want 0 for migrations", got)
	}
	if got := cfg.RuntimeParams["search_path"]; got != "x" {
		t.Errorf("search_path = %q, other params must be kept", got)
	}
}
