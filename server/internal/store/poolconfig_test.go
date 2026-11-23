package store

import "testing"

// Lote 16: pgxpool's default pool, max(4, NumCPU), is shared by the HTTP API, the Saver
// and the WebSocket handshake; Open sets DefaultMaxConns unless the URL says otherwise.
func TestPoolConfigMaxConns(t *testing.T) {
	for url, want := range map[string]int32{
		"postgres://u:p@localhost:5432/rpg":                   DefaultMaxConns,
		"postgres://u:p@localhost:5432/rpg?pool_max_conns=40": 40,
		"host=localhost dbname=rpg":                           DefaultMaxConns,
		"host=localhost dbname=rpg pool_max_conns=3":          3,
	} {
		cfg, err := poolConfig(url)
		if err != nil {
			t.Fatalf("%s: %v", url, err)
		}
		if cfg.MaxConns != want {
			t.Errorf("%s: MaxConns %d, want %d", url, cfg.MaxConns, want)
		}
		if cfg.ConnConfig.RuntimeParams["statement_timeout"] == "" {
			t.Errorf("%s: no statement_timeout", url)
		}
	}
}
