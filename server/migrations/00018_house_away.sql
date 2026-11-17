-- +goose Up
-- Content audit M6: a house whose owner's account has not been in the game for balance
-- houses.inactive_days is released when its rent runs out. The loop counts that absence
-- from the account's last login or save (characters.last_login_at / last_save_at), but
-- never from before away_from: the rows that exist when this migration runs get its time,
-- so nobody loses a house the day the rule arrives without having been told it at a login;
-- a house rented later gets its rent time (since says the same).
ALTER TABLE house_owners ADD COLUMN away_from TIMESTAMPTZ NOT NULL DEFAULT now();

-- +goose Down
ALTER TABLE house_owners DROP COLUMN away_from;
