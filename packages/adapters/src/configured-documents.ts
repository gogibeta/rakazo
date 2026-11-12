import type { DocumentProvider } from "@rakazo/adapter-kit";
import { naceApiKey } from "./auto-review.js";
import { HttpDocumentProvider } from "./http-documents.js";

/** The document-service key saved in Settings, used when the environment leaves it unset. */
export interface StoredDocumentKeys {
  naceApiKey?: string;
}

/**
 * The deployment's document provider for the document tools, when a Nace key
 * is configured: the same key as the `decide` tool, from the environment or
 * saved in Settings, the environment winning. Document operations exist only
 * on Nace, so a TypeSafe key alone does not configure this.
 */
export function createConfiguredDocuments(
  env: NodeJS.ProcessEnv = process.env,
  stored: StoredDocumentKeys = {},
): DocumentProvider | undefined {
  const nace = naceApiKey(env) ?? savedKey(stored.naceApiKey);
  return nace ? new HttpDocumentProvider({ apiKey: nace }) : undefined;
}

function savedKey(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
