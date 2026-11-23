-- +goose Up
-- Lote 16: the reset link of an address nobody verified is a claim_email token (it
-- resets the password and verifies the address). A purpose of its own, so issuing it
-- does not replace the registration's verify_email link nor the other way around.
ALTER TABLE account_tokens DROP CONSTRAINT account_tokens_purpose_check;
ALTER TABLE account_tokens ADD CONSTRAINT account_tokens_purpose_check
    CHECK (purpose IN ('verify_email', 'reset_password', 'claim_email'));

-- +goose Down
DELETE FROM account_tokens WHERE purpose = 'claim_email';
ALTER TABLE account_tokens DROP CONSTRAINT account_tokens_purpose_check;
ALTER TABLE account_tokens ADD CONSTRAINT account_tokens_purpose_check
    CHECK (purpose IN ('verify_email', 'reset_password'));
