-- name: LoadTrailWear :one
-- The living world's trail wear (migration 00027): its one row.
SELECT data, saved_at FROM trail_wear WHERE id = 1;

-- name: SaveTrailWear :exec
-- Replaces the one row of the trail wear.
INSERT INTO trail_wear (id, data, saved_at) VALUES (1, @data, @saved_at)
ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, saved_at = EXCLUDED.saved_at;
