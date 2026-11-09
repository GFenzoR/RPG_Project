-- +goose Up
-- Guilds (T5.1, docs/02-game-design.md "Gremios"). The game loop owns the guilds: it
-- loads every row at start, decides every change and writes it here in order through
-- the admin goroutine (docs/01 "Persistencia"). That is why guilds.id is assigned by the
-- server (the next one after the highest), not by an identity. The constraints are the
-- safety net, not the rules: those live in the server.
CREATE TABLE guilds (
    id         BIGINT      PRIMARY KEY CHECK (id > 0),
    name       TEXT        NOT NULL CHECK (length(name) BETWEEN 2 AND 32),
    motd       TEXT        NOT NULL DEFAULT '' CHECK (length(motd) <= 255),
    created_at TIMESTAMPTZ NOT NULL
);
-- Names are unique ignoring case.
CREATE UNIQUE INDEX guilds_name_key ON guilds (lower(name));
-- The highest guild id ever issued (one row; store.ApplyGuild raises it on every founding), so a
-- disbanded guild's id is never reused after a restart: audit_log entries, public links
-- and guild_wars (T5.2) keep pointing at one guild. Not an identity: the loop picks ids.
CREATE TABLE guild_id_high (
    one  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (one),
    high BIGINT  NOT NULL CHECK (high >= 0)
);
INSERT INTO guild_id_high (high) VALUES (0);

-- rank: 1 member, 2 vice leader, 3 leader (guild.Rank). A character is in one guild at
-- most (the primary key) and a guild has one leader at most (the partial index).
CREATE TABLE guild_members (
    character_id BIGINT      PRIMARY KEY REFERENCES characters (id) ON DELETE CASCADE,
    guild_id     BIGINT      NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    rank         SMALLINT    NOT NULL CHECK (rank BETWEEN 1 AND 3),
    joined_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX guild_members_guild_idx ON guild_members (guild_id, rank DESC, joined_at);
CREATE UNIQUE INDEX guild_members_leader_key ON guild_members (guild_id) WHERE rank = 3;

-- Pending invitations. They expire at expires_at (the game clock); expired rows are
-- deleted when the server loads the guilds.
CREATE TABLE guild_invites (
    guild_id     BIGINT      NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    character_id BIGINT      NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    invited_by   BIGINT      REFERENCES characters (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (guild_id, character_id)
);
CREATE INDEX guild_invites_character_idx ON guild_invites (character_id);

-- Prepared for guild wars with PvP (T5.2), not used yet: no code reads or writes it.
-- A war is declared by one guild on another and ends at ended_at.
CREATE TABLE guild_wars (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    guild_id    BIGINT      NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    enemy_id    BIGINT      NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    declared_at TIMESTAMPTZ NOT NULL,
    ended_at    TIMESTAMPTZ,
    CHECK (guild_id <> enemy_id)
);
COMMENT ON TABLE guild_wars IS 'T5.2 (PvP): prepared by T5.1, not used yet';

-- +goose Down
DROP TABLE guild_id_high;
DROP TABLE guild_wars;
DROP TABLE guild_invites;
DROP TABLE guild_members;
DROP TABLE guilds;
