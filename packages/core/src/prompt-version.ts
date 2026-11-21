import { createHash } from "node:crypto";

/**
 * A stable version for a prompt, derived from the prompt's own text. Editing a prompt
 * produces a new version on its own, so there is no manual bump to forget, and a run that
 * records this version can always be traced back to the exact prompt it executed with.
 * Returns the first 16 hex characters of the prompt's SHA-256 digest.
 */
export function promptVersion(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}
