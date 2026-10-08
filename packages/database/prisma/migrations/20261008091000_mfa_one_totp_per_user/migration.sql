-- "One active / pending factor per user and type" was written when TOTP was the only type. Passkeys
-- are many per user (laptop, phone, security key), so the rule now applies to TOTP only.
DROP INDEX "mfa_factors_one_active_per_user";
DROP INDEX "mfa_factors_one_pending_per_user";
CREATE UNIQUE INDEX "mfa_factors_one_active_totp_per_user" ON "mfa_factors" ("user_id") WHERE "status" = 'ACTIVE' AND "type" = 'TOTP';
CREATE UNIQUE INDEX "mfa_factors_one_pending_totp_per_user" ON "mfa_factors" ("user_id") WHERE "status" = 'PENDING' AND "type" = 'TOTP';
