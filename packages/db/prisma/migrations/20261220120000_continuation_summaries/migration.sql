-- Additive: the previous release never reads this table.
CREATE TABLE "continuation_summaries" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "fromSeq" INTEGER NOT NULL,
    "toSeq" INTEGER NOT NULL,
    "sourceMessageCount" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "createdByRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "continuation_summaries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "continuation_summaries_threadId_generation_toSeq_key" ON "continuation_summaries"("threadId", "generation", "toSeq");
CREATE INDEX "continuation_summaries_threadId_generation_idx" ON "continuation_summaries"("threadId", "generation");

ALTER TABLE "continuation_summaries" ADD CONSTRAINT "continuation_summaries_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A thread's summaries are its space's, as messages are.
ALTER TABLE "continuation_summaries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY continuation_summaries_tenant ON "continuation_summaries"
  USING (EXISTS (
    SELECT 1 FROM "threads" t
    WHERE t."id" = "continuation_summaries"."threadId"
      AND t."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY continuation_summaries_system ON "continuation_summaries"
  USING ((SELECT app_rls_bypass()));
