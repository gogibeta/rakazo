-- Additive: the previous release never reads this column. Rows recorded before this
-- migration carry no expiry and are never swept; the expiry applies to effects
-- recorded after it.
ALTER TABLE "external_effects" ADD COLUMN "expiresAt" TIMESTAMP(3);

CREATE INDEX "external_effects_status_expiresAt_idx" ON "external_effects"("status", "expiresAt");
