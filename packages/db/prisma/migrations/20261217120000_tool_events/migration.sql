-- Additive: the previous release never reads this table.
-- One row per tool call a run dispatched: the durable record of what a run's
-- tools actually did, kept apart from the transcript and the audit log.
CREATE TABLE "tool_events" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "connectorKind" TEXT,
    "argsHash" TEXT NOT NULL,
    "argsSummary" JSONB,
    "kind" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL,
    "effectId" TEXT,
    "resultBytes" INTEGER,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tool_events_runId_seq_key" ON "tool_events"("runId", "seq");
CREATE INDEX "tool_events_spaceId_createdAt_idx" ON "tool_events"("spaceId", "createdAt");
CREATE INDEX "tool_events_threadId_createdAt_idx" ON "tool_events"("threadId", "createdAt");
CREATE INDEX "tool_events_createdAt_idx" ON "tool_events"("createdAt");

ALTER TABLE "tool_events" ADD CONSTRAINT "tool_events_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tool_events" ADD CONSTRAINT "tool_events_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A Space's own record of its bots' tool calls, as events.
ALTER TABLE "tool_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tool_events_tenant ON "tool_events"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY tool_events_system ON "tool_events"
  USING ((SELECT app_rls_bypass()));
