-- One active executor per computer: the execution lease is keyed by the computer
-- alone, so two bots sharing a team computer can no longer hold live leases at
-- the same time. Existing rows are collapsed to one per computer first: a live
-- lease wins over an expired tombstone, then the highest fence, so the surviving
-- row keeps the computer's screen fencing moving forward.
DELETE FROM "computer_execution_leases" AS lease
USING (
    SELECT "id",
        ROW_NUMBER() OVER (
            PARTITION BY "computerId"
            ORDER BY ("expiresAt" > CURRENT_TIMESTAMP) DESC, "fence" DESC, "updatedAt" DESC, "id" DESC
        ) AS "rank"
    FROM "computer_execution_leases"
) AS ranked
WHERE lease."id" = ranked."id" AND ranked."rank" > 1;

DROP INDEX "computer_execution_leases_computerId_botId_key";

CREATE UNIQUE INDEX "computer_execution_leases_computerId_key" ON "computer_execution_leases"("computerId");
