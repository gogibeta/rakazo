-- Wallet-vault password throttle v8 (pr66-design.md): reservation-based
-- accounting so a success refunds only its own slot and a take-over can
-- never release another operation's claim.

ALTER TABLE "wallet_vaults"
  ADD COLUMN "throttleGeneration" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "windowStartedAt" TIMESTAMP(3),
  ADD COLUMN "pendingReservations" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "credentialRevision" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "wallet_vaults"
  ADD CONSTRAINT "wallet_vaults_pending_reservations_object"
  CHECK (jsonb_typeof("pendingReservations") = 'object');

CREATE SEQUENCE wallet_vault_reservation_token_seq
  AS BIGINT
  NO CYCLE;

-- Rollout (design §8): active legacy windows keep their charged counter as
-- historical failures with an empty reservation map; the lock is canonicalized
-- from the counter so it never outlives the budget that earned it.
UPDATE "wallet_vaults"
SET "lockedUntil" =
  CASE
    WHEN "failedAttempts" = 5 THEN "windowStartedAt" + INTERVAL '15 minutes'
    ELSE NULL
  END
WHERE "windowStartedAt" IS NOT NULL;
