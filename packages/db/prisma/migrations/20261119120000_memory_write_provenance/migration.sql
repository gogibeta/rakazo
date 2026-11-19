-- Additive: memory write provenance.
--
-- A memory document is loaded into every later run's prompt as trusted background, so text
-- planted there by a run that had read outside content steers every run that follows. These
-- columns record which revisions were written after outside content entered the run, and
-- mirror the current document's state so a reading run can tell in one row fetch.
--
-- No `-- deferred` marker: nothing is dropped or renamed. The previous release never reads
-- either column, so it keeps working while this migration is live.

ALTER TABLE "memory_documents" ADD COLUMN "writtenAfterOutsideContent" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "memory_revisions" ADD COLUMN "writtenAfterOutsideContent" BOOLEAN NOT NULL DEFAULT false;
