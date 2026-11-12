import type { WebProvider } from "@rakazo/adapter-kit";
import { CombinedWebProvider } from "./combined-web.js";
import { FakeWebProvider } from "./fake-web.js";
import { KeenableWebProvider } from "./keenable-web.js";
import type { KeylessHttpWebOptions } from "./keyless-http-web.js";
import { KeylessHttpWebProvider } from "./keyless-http-web.js";
import { MonidWebProvider } from "./monid-web.js";
import { ParallelWebProvider } from "./parallel-web.js";
import { TinyFishWebProvider } from "./tinyfish-web.js";

/**
 * Pi 0.84 exposes no provider-neutral native-search API, so the default is keyless HTTP and core
 * runs with no hosted search vendor.
 */
export function resolveWebProviderKind(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source.WEB_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "keyless" || raw === "keyless-http") return "keyless-http";
  if (raw === "fake") return "fake";
  return raw;
}

/** Compose the explicitly selected backend, retaining the keyless HTTP default. */
export function createWebProvider(
  kind: string = resolveWebProviderKind(),
  options?: KeylessHttpWebOptions & {
    /** The Monid key saved in Settings; the direct TINYFISH_API_KEY wins over it. */
    tinyfishApiKey?: string;
  },
): WebProvider {
  switch (kind) {
    case "parallel":
      return new ParallelWebProvider(options);
    case "keenable":
      return new KeenableWebProvider(options);
    case "tinyfish-ddg":
    case "combined": {
      // The TinyFish primary joins only when a key is configured; without one
      // the combined provider is exactly the keyless default. TINYFISH_API_KEY
      // holds a direct TinyFish key and keeps the direct provider; the key
      // saved in Settings is a Monid key, so it runs TinyFish through Monid's
      // free endpoints instead.
      const envKey = process.env.TINYFISH_API_KEY?.trim();
      const savedKey = options?.tinyfishApiKey?.trim();
      const primary = envKey
        ? new TinyFishWebProvider({ ...options, apiKey: envKey })
        : savedKey
          ? new MonidWebProvider({ ...options, apiKey: savedKey })
          : undefined;
      return new CombinedWebProvider({
        primary,
        fallback: new KeylessHttpWebProvider(options),
      });
    }
    case "fake":
      return new FakeWebProvider();
    case "keyless-http":
    case "keyless":
    case "":
      return new KeylessHttpWebProvider(options);
    default:
      throw new Error(`Unknown web provider "${kind}"`);
  }
}
