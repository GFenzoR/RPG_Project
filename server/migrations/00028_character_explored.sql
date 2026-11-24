-- +goose Up
-- The minimap's fog (docs/02 "Minimapa", owner request 2026-11-23): what each character
-- has explored, one row per sector of 32x32 tiles of one floor with something explored.
-- bits is the sector's bitset (server/internal/explore): 128 bytes, one bit per tile, row
-- by row. Bits are only ever set, so a snapshot writes the sectors that gained bits during
-- the login (a newer copy is always a superset) and never deletes. Kept per character on
-- the server so the explored map follows the character to another device (docs/07
-- "Minimapa": a few KB per character).
CREATE TABLE character_explored (
    character_id BIGINT   NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    z            SMALLINT NOT NULL CHECK (z BETWEEN 0 AND 15),
    sx           SMALLINT NOT NULL CHECK (sx BETWEEN 0 AND 4095),
    sy           SMALLINT NOT NULL CHECK (sy BETWEEN 0 AND 4095),
    bits         BYTEA    NOT NULL CHECK (length(bits) = 128),
    PRIMARY KEY (character_id, z, sx, sy)
);

-- +goose Down
DROP TABLE character_explored;
