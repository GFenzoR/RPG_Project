-- +goose Up
-- Inventory is one row per item instance so trades and the future global market can move
-- single items transactionally. Equipment slots have container_id NULL; items inside a
-- container point to the container's row.
CREATE TABLE inventory_items (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    character_id BIGINT   NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    container_id BIGINT,
    -- Equipment slot (container_id NULL) or index inside the container.
    slot         SMALLINT NOT NULL CHECK (slot >= 0),
    -- Stable numeric id from data/ids.lock.yaml.
    item_id      INTEGER  NOT NULL CHECK (item_id > 0),
    count        INTEGER  NOT NULL DEFAULT 1 CHECK (count > 0),
    -- Per-instance attributes (charges, text, duration...). Empty for plain items.
    attributes   JSONB    NOT NULL DEFAULT '{}',
    UNIQUE (id, character_id),
    -- A container's contents belong to the same character as the container.
    FOREIGN KEY (container_id, character_id)
        REFERENCES inventory_items (id, character_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX inventory_items_equipment_slot_key
    ON inventory_items (character_id, slot) WHERE container_id IS NULL;
CREATE UNIQUE INDEX inventory_items_container_slot_key
    ON inventory_items (container_id, slot) WHERE container_id IS NOT NULL;
CREATE INDEX inventory_items_character_idx ON inventory_items (character_id);

-- Skills and crafts. A missing row means the skill is at its base level from
-- data/balance.yaml (skills.base) with no progress.
CREATE TABLE character_skills (
    character_id BIGINT  NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    skill        TEXT    NOT NULL,
    level        INTEGER NOT NULL CHECK (level >= 0),
    tries        BIGINT  NOT NULL DEFAULT 0 CHECK (tries >= 0),
    PRIMARY KEY (character_id, skill)
);

-- Quest progress and other per-character flags ("storage values").
CREATE TABLE quest_state (
    character_id BIGINT NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    key          TEXT   NOT NULL,
    value        BIGINT NOT NULL,
    PRIMARY KEY (character_id, key)
);

-- +goose Down
DROP TABLE quest_state;
DROP TABLE character_skills;
DROP TABLE inventory_items;
