-- +goose Up
-- Lote 17 (owner request 2026-11-23): the living world's trail wear (livingworld/README.md
-- "Desgaste de senderos"). The game loop owns the wear in memory; every save_every_ms of
-- data/livingworld/wear.yaml (and at shutdown) the persistence side writes a copy here, and
-- the server reads it back at start (minus the decay of the downtime, from saved_at). One
-- row: data is livingworld/server/trail's encoding (Snapshot.Encode), a few bytes per worn
-- tile. Losing it costs paths in the grass, nothing else: the authored map never changes.
CREATE TABLE trail_wear (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    data BYTEA NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL
);

-- +goose Down
DROP TABLE trail_wear;
