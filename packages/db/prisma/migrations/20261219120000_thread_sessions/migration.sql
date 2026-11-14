-- Sessions: Thread becomes the session record. A bot may have many threads,
-- exactly one of them primary. Additive columns plus a relaxed uniqueness
-- rule; no data moves and every existing thread keeps its id, so all
-- messages, events and runs keep their keys.
--
-- The previous release keeps working on this schema: it only ever sees one
-- thread per bot (the backfilled primary), its by-botId lookups still return
-- that row through the plain index, and bot creation still inserts a single
-- thread (which the new partial index accepts: the backfill below has
-- already marked the existing one primary, and a fresh bot has none).

-- Fail loudly if the invariant the primary backfill relies on is broken,
-- while the unique constraint still guarantees it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "threads" WHERE "botId" IS NOT NULL
    GROUP BY "botId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'threads: a bot has more than one thread; primary backfill is ambiguous';
  END IF;
END $$;

ALTER TABLE "threads" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE "threads" ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "threads" ADD COLUMN "title" TEXT;
ALTER TABLE "threads" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "threads" ADD COLUMN "lastMessageAt" TIMESTAMP(3);
ALTER TABLE "threads" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'web';
ALTER TABLE "threads" ADD COLUMN "parentThreadId" TEXT;

ALTER TABLE "threads" ADD CONSTRAINT "threads_parentThreadId_fkey" FOREIGN KEY ("parentThreadId") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Kind from the existing discriminator: which nullable FK is set.
UPDATE "threads" SET "kind" = CASE
  WHEN "botId" IS NOT NULL THEN 'direct'
  WHEN "groupId" IS NOT NULL THEN 'group'
  WHEN "helperBotId" IS NOT NULL THEN 'helper'
  WHEN "externalConversationId" IS NOT NULL THEN 'external'
  ELSE 'direct'
END;

-- The one thread a bot has today is its primary session.
UPDATE "threads" SET "isPrimary" = true WHERE "botId" IS NOT NULL;

UPDATE "threads" AS t SET "lastMessageAt" = COALESCE(
  (SELECT MAX(m."createdAt") FROM "messages" AS m WHERE m."threadId" = t."id"),
  t."createdAt"
);

DROP INDEX "threads_botId_key";
CREATE INDEX "threads_botId_idx" ON "threads"("botId");
CREATE INDEX "threads_spaceId_botId_archivedAt_lastMessageAt_idx" ON "threads"("spaceId", "botId", "archivedAt", "lastMessageAt");

-- At most one primary session per bot, from here on.
CREATE UNIQUE INDEX "threads_one_primary_per_bot" ON "threads"("botId") WHERE "isPrimary" AND "botId" IS NOT NULL;

ALTER TABLE "spaces" ADD COLUMN "orchestratorBotId" TEXT;
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_orchestratorBotId_fkey" FOREIGN KEY ("orchestratorBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "spaces_orchestratorBotId_idx" ON "spaces"("orchestratorBotId");

ALTER TABLE "messaging_identities" ADD COLUMN "activeThreadId" TEXT;
ALTER TABLE "messaging_identities" ADD CONSTRAINT "messaging_identities_activeThreadId_fkey" FOREIGN KEY ("activeThreadId") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "messaging_identities_activeThreadId_idx" ON "messaging_identities"("activeThreadId");

-- Each DM starts out landing in its bot's primary session.
UPDATE "messaging_identities" AS mi SET "activeThreadId" = t."id"
FROM "threads" AS t
WHERE t."botId" = mi."botId" AND t."isPrimary";
