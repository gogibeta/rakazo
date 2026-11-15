-- Hardening for wallet_proposals, additive to 20261222120000_wallet_proposals.
--
-- A proposal is a transaction the owner may later be asked to sign. Its canonical
-- payload must therefore be immutable at the database boundary, not only in the
-- service that writes it: row-level security says whose row it is, but says nothing
-- about which columns may change. This migration adds the sender the hash already
-- covered, the constraints that make a malformed row unrepresentable, a composite
-- foreign key that proves the wallet is the owner's, and a trigger that limits a row's
-- whole lifetime to "created once, then proposed -> cancelled or expired".

-- The sender the canonical hash covers. Until now the hash bound in the wallet's
-- address at signing-read time; storing it here means a later wallet change cannot
-- silently re-point an existing proposal. Backfilled from the wallet it belongs to,
-- which is exactly the value the existing hashes were computed over.
ALTER TABLE "wallet_proposals" ADD COLUMN "fromAddress" TEXT;

UPDATE "wallet_proposals" p
SET "fromAddress" = w."address"
FROM "user_wallets" w
WHERE w."id" = p."walletId" AND p."fromAddress" IS NULL;

ALTER TABLE "wallet_proposals" ALTER COLUMN "fromAddress" SET NOT NULL;

-- A proposal's wallet must belong to the same person. The composite key below makes
-- that a database fact rather than a convention two writes have to keep in step.
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_userId_id_key" UNIQUE ("userId", "id");
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_walletId_userId_fkey"
  FOREIGN KEY ("walletId", "userId") REFERENCES "user_wallets"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Canonical decimal strings: digits only, no sign, no exponent, no float. The uint256
-- ceiling is the same one the contracts enforce.
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_amount_canonical_chk" CHECK (
  "amountWei" ~ '^(0|[1-9][0-9]*)$' AND "amountWei"::numeric < (2::numeric ^ 256)
);
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_gas_canonical_chk" CHECK (
  "gasLimit" ~ '^(0|[1-9][0-9]*)$'
  AND "gasLimit"::numeric > 0
  AND "gasLimit"::numeric < (2::numeric ^ 256)
);
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_fees_canonical_chk" CHECK (
  "maxFeePerGas" ~ '^(0|[1-9][0-9]*)$'
  AND "maxPriorityFeePerGas" ~ '^(0|[1-9][0-9]*)$'
  AND "maxFeePerGas"::numeric < (2::numeric ^ 256)
  AND "maxPriorityFeePerGas"::numeric < (2::numeric ^ 256)
  -- A tip above the cap would make the transaction unpayable under its own terms.
  AND "maxFeePerGas"::numeric >= "maxPriorityFeePerGas"::numeric
);

-- Addresses and hex are stored lowercased, as the hash covers them.
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_from_chk" CHECK (
  "fromAddress" ~ '^0x[0-9a-f]{40}$'
);
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_to_chk" CHECK (
  "to" IS NULL OR "to" ~ '^0x[0-9a-f]{40}$'
);
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_data_chk" CHECK (
  "data" IS NULL OR "data" ~ '^0x([0-9a-f]{2})*$'
);
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_hash_chk" CHECK (
  "canonicalHash" ~ '^[0-9a-f]{64}$'
);

-- Only the three allowlisted testnets, and only the three statuses the product defines.
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_chain_chk" CHECK (
  "chainId" IN (99801, 998, 11155111)
);
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_status_chk" CHECK (
  "status" IN ('proposed', 'expired', 'cancelled')
);

-- A nonce must fit both JavaScript's safe integer and the INTEGER column: a value that
-- passes the wire but overflows on write would fail as an untyped database error.
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_nonce_chk" CHECK (
  "nonce" >= 0 AND "nonce" <= 2147483647
);

-- The proposal must expire after it was created, and within a bounded window: a
-- lifetime is what makes "still proposed" meaningful.
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_lifetime_chk" CHECK (
  "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '1 hour'
);

-- Ownership after an update is already enforced: a policy with only USING applies the
-- same expression as its check. Restating it as WITH CHECK would be redundant, and the
-- repo keeps every *_system policy to USING alone (see the row-security guard test).

/**
 * A proposal's canonical payload, its identity, its owner and its lifetime are written
 * once. The only permitted change is the status moving from `proposed` to `expired` or
 * `cancelled`; nothing may move back out of a terminal state, and no other column may
 * change in the same or any later statement.
 *
 * This holds for the application's own login: the trigger runs for every writer except
 * a superuser, and `rakazo_app` owns nothing here, so it cannot disable or drop the
 * trigger. A regression test runs these statements as that role.
 */
CREATE FUNCTION wallet_proposals_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."walletId" IS DISTINCT FROM OLD."walletId"
    OR NEW."fromAddress" IS DISTINCT FROM OLD."fromAddress"
    OR NEW."chainId" IS DISTINCT FROM OLD."chainId"
    OR NEW."to" IS DISTINCT FROM OLD."to"
    OR NEW."asset" IS DISTINCT FROM OLD."asset"
    OR NEW."amountWei" IS DISTINCT FROM OLD."amountWei"
    OR NEW."data" IS DISTINCT FROM OLD."data"
    OR NEW."nonce" IS DISTINCT FROM OLD."nonce"
    OR NEW."gasLimit" IS DISTINCT FROM OLD."gasLimit"
    OR NEW."maxFeePerGas" IS DISTINCT FROM OLD."maxFeePerGas"
    OR NEW."maxPriorityFeePerGas" IS DISTINCT FROM OLD."maxPriorityFeePerGas"
    OR NEW."rpcProfile" IS DISTINCT FROM OLD."rpcProfile"
    OR NEW."canonicalHash" IS DISTINCT FROM OLD."canonicalHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."runId" IS DISTINCT FROM OLD."runId"
  THEN
    RAISE EXCEPTION 'wallet proposal canonical fields are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" <> 'proposed' OR NEW."status" NOT IN ('cancelled', 'expired') THEN
      RAISE EXCEPTION 'wallet proposal status may only move from proposed to cancelled or expired'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER wallet_proposals_immutable BEFORE UPDATE ON "wallet_proposals"
  FOR EACH ROW EXECUTE FUNCTION wallet_proposals_immutable();

-- Deletion stays possible: an account or wallet deletion cascades here, and destroying a
-- proposal is not the same as rewriting one. A forged replacement would be a new row with
-- its own hash and audit trail, not a changed transaction under the old identity.
