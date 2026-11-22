-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "continuesRunId" TEXT,
ADD COLUMN     "chainRootTaskId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "runs_continuesRunId_key" ON "runs"("continuesRunId");

-- CreateIndex
CREATE INDEX "runs_chainRootTaskId_createdAt_idx" ON "runs"("chainRootTaskId", "createdAt");

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_continuesRunId_fkey" FOREIGN KEY ("continuesRunId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every existing run is its own chain root. Runs already in the chain (a continuation
-- created before this column existed) cannot be paired reliably after the fact, so each keeps its
-- own task as root — the view still shows one box per task for them, exactly as it does today.
UPDATE "runs" SET "chainRootTaskId" = "taskId" WHERE "chainRootTaskId" IS NULL;
