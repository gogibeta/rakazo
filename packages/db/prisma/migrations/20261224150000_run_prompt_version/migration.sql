-- Prompt auto-versioning: each run records the version of the prompt it executed with.
-- The version is derived from the prompt text itself, so an edited prompt becomes a new
-- version without a manual bump. Nullable: runs that predate this column keep no version.
ALTER TABLE "runs" ADD COLUMN "promptVersion" TEXT;
