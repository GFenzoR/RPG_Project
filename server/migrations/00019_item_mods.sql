-- +goose Up
-- Item attributes (docs/02-game-design.md "Atributos de items", docs/05 ItemMods): every
-- equipable carries its own data (the one attribute it rolled and, with the forge, its
-- refine level) as a JSON object {"attribute": id, "value": n, "refine": n} ('{}' for a
-- plain item). inventory_items.attributes (00002) already holds it per row; the instances
-- saved whole as JSON (market_mail_items.item, house_items.item) carry it as "mods". A
-- sell offer of an equipable is one instance: it keeps the instance's data here, so the
-- buyer (or the owner's mailbox, when it closes) gets exactly that one.
ALTER TABLE market_offers ADD COLUMN attributes JSONB NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE market_offers DROP COLUMN attributes;
