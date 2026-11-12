import type { DecisionProvider } from "@rakazo/adapter-kit";
import { DEFAULT_JEV_MODEL, naceApiKey, typesafeApiKey } from "./auto-review.js";
import { DEFAULT_DREX_MODEL } from "./decision-models.js";
import { HttpDecisionProvider } from "./http-decisions.js";

/** A decision provider plus the model the deployment pinned for bot-facing calls. */
export type ConfiguredDecision = {
  provider: DecisionProvider;
  model: string;
};

/** Decision-service keys saved in Settings, used for whichever the environment leaves unset. */
export interface StoredDecisionKeys {
  naceApiKey?: string;
  typesafeApiKey?: string;
}

/**
 * The deployment's decision endpoint for the `decide` tool, when a key is
 * configured: Nace Drex when a Nace key is set, otherwise TypeSafe Jev.
 * Both speak the same decision protocol. A key from the environment wins
 * over the same service's key saved in Settings.
 */
export function createConfiguredDecision(
  env: NodeJS.ProcessEnv = process.env,
  stored: StoredDecisionKeys = {},
): ConfiguredDecision | undefined {
  const nace = naceApiKey(env) ?? savedKey(stored.naceApiKey);
  if (nace)
    return {
      provider: new HttpDecisionProvider("nace", { apiKey: nace }),
      model: DEFAULT_DREX_MODEL,
    };
  const typesafe = typesafeApiKey(env) ?? savedKey(stored.typesafeApiKey);
  if (typesafe)
    return {
      provider: new HttpDecisionProvider("typesafe", { apiKey: typesafe }),
      model: DEFAULT_JEV_MODEL,
    };
  return undefined;
}

function savedKey(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
