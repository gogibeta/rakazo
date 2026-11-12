import type { DecisionProviderOptions } from "@rakazo/adapter-kit";
import { DecisionAutoReviewProvider } from "./decision-auto-review.js";
import { DEFAULT_DREX_MODEL } from "./decision-models.js";
import { HttpDecisionProvider } from "./http-decisions.js";

export interface DrexAutoReviewOptions extends DecisionProviderOptions {
  timeoutMs?: number;
  model?: string;
  minConfidence?: number;
}

/** Nace Drex as an Auto Review checker; it speaks the same decision protocol as Jev. */
export class DrexAutoReviewProvider extends DecisionAutoReviewProvider {
  constructor(options: DrexAutoReviewOptions) {
    if (!options.apiKey.trim()) throw new Error("NACE_API_KEY is required");
    super({
      ...options,
      provider: new HttpDecisionProvider("nace", options),
      providerId: "drex",
      model: options.model?.trim() || DEFAULT_DREX_MODEL,
    });
  }
}
