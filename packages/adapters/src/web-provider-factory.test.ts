import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebProvider } from "./web-provider-factory.js";

const ORIGINAL_TINYFISH_KEY = process.env.TINYFISH_API_KEY;

beforeEach(() => {
  delete process.env.TINYFISH_API_KEY;
});

afterEach(() => {
  if (ORIGINAL_TINYFISH_KEY === undefined) delete process.env.TINYFISH_API_KEY;
  else process.env.TINYFISH_API_KEY = ORIGINAL_TINYFISH_KEY;
});

describe("createWebProvider tinyfish-ddg", () => {
  it("stays keyless when no key is configured anywhere", () => {
    const provider = createWebProvider("tinyfish-ddg");
    expect(provider.describe().id).toBe("tinyfish-ddg");
    expect(provider.describe().capabilities.keyless).toBe(true);
  });

  it("joins the TinyFish primary with the key saved in Settings", () => {
    const provider = createWebProvider("tinyfish-ddg", { tinyfishApiKey: "saved-key" });
    expect(provider.describe().capabilities.keyless).toBe(false);
  });

  it("ignores a blank saved key", () => {
    const provider = createWebProvider("tinyfish-ddg", { tinyfishApiKey: "   " });
    expect(provider.describe().capabilities.keyless).toBe(true);
  });

  it("joins the TinyFish primary with the environment key", () => {
    process.env.TINYFISH_API_KEY = "env-key";
    const provider = createWebProvider("tinyfish-ddg");
    expect(provider.describe().capabilities.keyless).toBe(false);
  });
});
