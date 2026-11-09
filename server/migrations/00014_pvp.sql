-- +goose Up
-- PvP with skulls and guild wars (T5.2, docs/02-game-design.md "PvP"). The game loop owns
-- this state: a character's skull, its unjustified kills and its kill counter travel
-- with the character snapshot; guild wars are written in order by the admin goroutine,
-- like the guilds (T5.1). The constraints are the safety net, not the rules.

-- characters.skull (00001): 0 none, 1 aggressor, 2 murderer, 3 outlaw (pb.Skull), until
-- skull_until. pvp_kills counts every player the character killed (justified or not).
ALTER TABLE characters ADD CONSTRAINT characters_skull_max CHECK (skull <= 3);
ALTER TABLE characters ADD COLUMN pvp_kills INTEGER NOT NULL DEFAULT 0 CHECK (pvp_kills >= 0);

-- The unjustified kills of a character still inside the longest skull window (older
-- ones are dropped when the next snapshot replaces the character's rows). No victim:
-- only the count over time matters to the rules; the log line of each kill names both.
CREATE TABLE pvp_unjust_kills (
    character_id BIGINT      NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    killed_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX pvp_unjust_kills_character_idx ON pvp_unjust_kills (character_id, killed_at);

-- Guild wars: T5.1 created the table empty. Like guilds.id, a war id is issued by the
-- loop (the next after war_high), so the identity goes away.
-- state: 1 declared (waiting for the enemy's leader), 2 active, 3 ended.
-- expires_at: when a declaration expires (state 1) or the war ends by time (state 2).
-- end_reason (state 3): 1 declined, 2 declaration expired, 3 surrendered, 4 kill limit,
-- 5 time, 6 a guild disbanded. winner_id: NULL for none or a draw.
ALTER TABLE guild_wars ALTER COLUMN id DROP IDENTITY;
ALTER TABLE guild_wars ADD CONSTRAINT guild_wars_id_positive CHECK (id > 0);
ALTER TABLE guild_wars
    ADD COLUMN state       SMALLINT    NOT NULL DEFAULT 1 CHECK (state BETWEEN 1 AND 3),
    ADD COLUMN started_at  TIMESTAMPTZ,
    ADD COLUMN expires_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN kill_limit  INTEGER     NOT NULL DEFAULT 1 CHECK (kill_limit > 0),
    ADD COLUMN guild_kills INTEGER     NOT NULL DEFAULT 0 CHECK (guild_kills >= 0),
    ADD COLUMN enemy_kills INTEGER     NOT NULL DEFAULT 0 CHECK (enemy_kills >= 0),
    ADD COLUMN end_reason  SMALLINT    NOT NULL DEFAULT 0 CHECK (end_reason BETWEEN 0 AND 6),
    ADD COLUMN winner_id   BIGINT,
    ADD CONSTRAINT guild_wars_ended CHECK ((state = 3) = (ended_at IS NOT NULL) AND (state = 3) = (end_reason > 0));
ALTER TABLE guild_wars ALTER COLUMN expires_at DROP DEFAULT;
-- One open (declared or active) war per pair of guilds, whoever declared it.
CREATE UNIQUE INDEX guild_wars_open_pair ON guild_wars (LEAST(guild_id, enemy_id), GREATEST(guild_id, enemy_id))
    WHERE state < 3;
CREATE INDEX guild_wars_enemy_idx ON guild_wars (enemy_id);
COMMENT ON TABLE guild_wars IS 'Guild wars (T5.2): written by the game loop through the admin goroutine';

-- The highest war id ever issued, like guild_id_high.high for guilds.
ALTER TABLE guild_id_high ADD COLUMN war_high BIGINT NOT NULL DEFAULT 0 CHECK (war_high >= 0);

-- +goose Down
ALTER TABLE guild_id_high DROP COLUMN war_high;
DROP INDEX guild_wars_enemy_idx;
DROP INDEX guild_wars_open_pair;
DELETE FROM guild_wars;
ALTER TABLE guild_wars
    DROP CONSTRAINT guild_wars_ended,
    DROP COLUMN winner_id,
    DROP COLUMN end_reason,
    DROP COLUMN enemy_kills,
    DROP COLUMN guild_kills,
    DROP COLUMN kill_limit,
    DROP COLUMN expires_at,
    DROP COLUMN started_at,
    DROP COLUMN state,
    DROP CONSTRAINT guild_wars_id_positive;
ALTER TABLE guild_wars ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;
COMMENT ON TABLE guild_wars IS 'T5.2 (PvP): prepared by T5.1, not used yet';
DROP TABLE pvp_unjust_kills;
ALTER TABLE characters DROP COLUMN pvp_kills;
ALTER TABLE characters DROP CONSTRAINT characters_skull_max;
