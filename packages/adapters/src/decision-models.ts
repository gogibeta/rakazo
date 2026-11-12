import type { ModelCatalogEntry } from "@rakazo/contracts";

export const DEFAULT_DREX_MODEL = "drex-latest";

/** Protocol/pricing belongs to the adapter catalog, never approval policy. */
const models = [
  {
    provider: "openrouter",
    providerName: "OpenRouter",
    id: "typesafe/jev-1.14",
    label: "Jev 1.14",
    inputUsdPerMillion: 0.042,
  },
  {
    provider: "nace",
    providerName: "Nace",
    id: "drex-latest",
    label: "Drex (latest)",
    inputUsdPerMillion: 0.03,
  },
  {
    provider: "nace",
    providerName: "Nace",
    id: "drex-max-v1.1",
    label: "Drex Max 1.1",
    inputUsdPerMillion: 0.03,
  },
  {
    provider: "nace",
    providerName: "Nace",
    id: "drex-v2.0",
    label: "Drex 2.0",
    inputUsdPerMillion: 0.03,
  },
];
export function decisionModel(provider: string, id: string) {
  return models.find((model) => model.provider === provider && model.id === id);
}
export function decisionModelCatalog(): ModelCatalogEntry[] {
  return models.map((model) => ({
    provider: model.provider,
    providerName: model.providerName,
    id: model.id,
    label: model.label,
    protocol: "decisions",
    billing: "Uses your API key",
    auth: "api-key",
  }));
}
