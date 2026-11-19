-- +goose Up
-- Pockets (docs/02-game-design.md "Bolsillos"): every character has built-in pocket cells
-- (balance.yaml inventory.pocket_slots), part of the character, never an item. Their
-- content is saved like the equipment: top-level rows (container_id NULL), with
-- pocket = true and slot = the cell. The pockets themselves have no row. Existing
-- characters get empty pockets (every row stays an equipment or container row).
ALTER TABLE inventory_items ADD COLUMN pocket BOOLEAN NOT NULL DEFAULT false;
-- Only a top-level item lies in the pockets: what is inside a container in them points
-- to that container, like anywhere else.
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_pocket_top_level
    CHECK (NOT pocket OR container_id IS NULL);
-- One item per equipment slot and one per pocket cell: an equipment slot and the pocket
-- cell of the same number are different places.
DROP INDEX inventory_items_equipment_slot_key;
CREATE UNIQUE INDEX inventory_items_equipment_slot_key
    ON inventory_items (character_id, slot) WHERE container_id IS NULL AND NOT pocket;
CREATE UNIQUE INDEX inventory_items_pocket_slot_key
    ON inventory_items (character_id, slot) WHERE pocket;

-- +goose Down
-- The pockets' items go with them (a development rollback: nothing would load them).
DELETE FROM inventory_items WHERE pocket;
DROP INDEX inventory_items_pocket_slot_key;
DROP INDEX inventory_items_equipment_slot_key;
CREATE UNIQUE INDEX inventory_items_equipment_slot_key
    ON inventory_items (character_id, slot) WHERE container_id IS NULL;
ALTER TABLE inventory_items DROP CONSTRAINT inventory_items_pocket_top_level;
ALTER TABLE inventory_items DROP COLUMN pocket;
