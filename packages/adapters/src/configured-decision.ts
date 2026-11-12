import type { DecisionProvider } from "@rakazo/adapter-kit";
import { DEFAULT_JEV_MODEL, naceApiKey, typesafeApiKey } from "./auto-review.js";
import { DEFAULT_DREX_MODEL } from "./decision-models.js";
import { HttpDecisionProvider } from "./http-decisions.js";

/** A decision provider plus the model the deployment pinned for bot-facing calls. */
export type ConfiguredDecision = {
  provider: DecisionProvider;
  model: string;
};

/**
 * The deployment's decision endpoint for the `decide` tool, when a key is
 * configured: Nace Drex when NACE_API_KEY is set, otherwise TypeSafe Jev.
 * Both speak the same decision protocol.
 */
export function createConfiguredDecision(
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredDecision | undefined {
  const nace = naceApiKey(env);
  if (nace)
    return {
      provider: new HttpDecisionProvider("nace", { apiKey: nace }),
      model: DEFAULT_DREX_MODEL,
    };
  const typesafe = typesafeApiKey(env);
  if (typesafe)
    return {
      provider: new HttpDecisionProvider("typesafe", { apiKey: typesafe }),
      model: DEFAULT_JEV_MODEL,
    };
  return undefined;
}
