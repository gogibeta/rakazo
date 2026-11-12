import type { WebProvider } from "@rakazo/adapter-kit";
import { CombinedWebProvider } from "./combined-web.js";
import { FakeWebProvider } from "./fake-web.js";
import { KeenableWebProvider } from "./keenable-web.js";
import { KeylessHttpWebProvider } from "./keyless-http-web.js";
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
  options?: ConstructorParameters<typeof KeylessHttpWebProvider>[0],
): WebProvider {
  switch (kind) {
    case "parallel":
      return new ParallelWebProvider(options);
    case "keenable":
      return new KeenableWebProvider(options);
    case "tinyfish-ddg":
    case "combined":
      // The TinyFish primary joins only when its key is configured; without one
      // the combined provider is exactly the keyless default.
      return new CombinedWebProvider({
        primary: process.env.TINYFISH_API_KEY?.trim()
          ? new TinyFishWebProvider(options)
          : undefined,
        fallback: new KeylessHttpWebProvider(options),
      });
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
