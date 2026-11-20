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

-- Rollout (design §8). The previous scheme kept only failedAttempts + lockedUntil and had no
-- window anchor, so every pre-existing row lands here with the new "windowStartedAt" NULL. A
-- charged legacy row with no anchor can never be normalized (normalization requires a
-- non-null window) and, once at the cap, can never be admitted again — a permanent lockout.
-- So: validate the legacy counters, backfill a usable anchor, then canonicalize the lock.

-- §8 validation. A legacy counter outside [0,5] is an unexpected state that this migration
-- must not silently clamp. Abort so an operator can repair those rows explicitly, then re-run.
DO $$
DECLARE
  outside_range bigint;
  offender_list text;
BEGIN
  SELECT count(*), string_agg("userId", ', ' ORDER BY "userId")
    INTO outside_range, offender_list
  FROM "wallet_vaults"
  WHERE "failedAttempts" < 0 OR "failedAttempts" > 5;
  IF outside_range > 0 THEN
    RAISE EXCEPTION
      'wallet_vaults rollout: % legacy row(s) have failedAttempts outside [0,5] (%). Repair them explicitly before rolling out the reservation throttle.',
      outside_range, offender_list;
  END IF;
END
$$;

-- Backfill the window anchor (design §8 step 3). A locked legacy row's window began when its
-- lock was earned, so reconstructing the anchor from "lockedUntil" keeps an unexpired lock
-- locking and lets the first normalization retire an already-expired one. A charged row with
-- no lock has no recoverable anchor, so it starts a fresh window at the rollout instant and
-- expires normally. An uncharged legacy row keeps a NULL window: inactive, nothing to expire.
UPDATE "wallet_vaults"
SET "windowStartedAt" =
  CASE
    WHEN "failedAttempts" = 0 THEN NULL
    WHEN "lockedUntil" IS NOT NULL THEN "lockedUntil" - INTERVAL '15 minutes'
    ELSE (now() AT TIME ZONE 'UTC')
  END
WHERE "windowStartedAt" IS NULL;

-- Canonicalize the lock from the charged counter (design §8 step 5). Every charged row now
-- has a window anchor, so this reaches the legacy rows a "windowStartedAt IS NOT NULL"
-- filter alone would have skipped — the ones that could otherwise never recover.
UPDATE "wallet_vaults"
SET "lockedUntil" =
  CASE
    WHEN "failedAttempts" >= 5 THEN "windowStartedAt" + INTERVAL '15 minutes'
    ELSE NULL
  END
WHERE "windowStartedAt" IS NOT NULL;
