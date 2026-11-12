import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { serializeModelSecret } from "./model-secret.js";
import type * as PiOAuthModule from "./pi-oauth.js";
import { resolveModelKey } from "./run-model.js";

// Deterministic OAuth handling: a pooled account resolves to its access token
// without touching the provider.
vi.mock("./pi-oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PiOAuthModule>();
  return {
    ...actual,
    loadProviderOAuth: () => ({
      refresh: async (credential: { access: string }) => credential,
      toAuth: (credential: { access: string }) => ({ apiKey: credential.access }),
    }),
  };
});

type Entry = { id: string; secretId: string; position: number };

const apiKeySecret = (key: string) => serializeModelSecret({ kind: "api_key", key });
const oauthSecret = (access: string, refresh = `${access}-refresh`) =>
  serializeModelSecret({
    kind: "oauth",
    credential: { type: "oauth", access, refresh, expires: Date.now() + 3_600_000 },
  });

function poolDeps(input: {
  secrets: Record<string, string>;
  entries: Entry[];
  loadError?: (secretId: string) => Error | undefined;
}) {
  const findFirst = vi.fn(async ({ where }: { where: { id: string } }) => {
    const plaintext = input.secrets[where.id];
    return plaintext === undefined ? null : { id: where.id, ciphertext: plaintext };
  });
  const load = vi.fn(async (ciphertext: string, id: string) => {
    const error = input.loadError?.(id);
    if (error) throw error;
    return ciphertext;
  });
  const prisma = {
    secret: { findFirst },
    userModelCredentialKey: {
      findMany: vi.fn(async () =>
        input.entries.map((entry) => ({
          id: entry.id,
          credentialId: "conn-1",
          userId: "user-1",
          label: "",
          secretId: entry.secretId,
          position: entry.position,
          lastFailedAt: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        })),
      ),
    },
  };
  const deps = {
    prisma,
    secretStore: {
      load,
      put: vi.fn(async () => {
        throw new Error("put is not used by these resolutions");
      }),
      delete: vi.fn(async () => undefined),
    },
    billingEnabled: false,
  } as unknown as ExecutorDeps;
  return { deps, findFirst, load };
}

const credential = (secretId: string, provider = "openai") => ({
  id: "conn-1",
  secretId,
  provider,
});

const twoKeys: Entry[] = [
  { id: "key-1", secretId: "secret-1", position: 0 },
  { id: "key-2", secretId: "secret-2", position: 1 },
];

describe("resolveModelKey with a credential pool", () => {
  it("starts on the active entry even when it is not first in pool order", async () => {
    const { deps } = poolDeps({
      secrets: { "secret-1": apiKeySecret("sk-first"), "secret-2": apiKeySecret("sk-second") },
      entries: twoKeys,
    });
    const resolved = await resolveModelKey(
      deps,
      "user-1",
      "space-1",
      credential("secret-2"),
      "openai",
      "gpt-5.1",
    );
    expect(resolved.apiKey).toBe("sk-second");
    expect(resolved.keyId).toBe("key-2");
  });

  it("advances to the next entry when the active entry's secret is gone", async () => {
    const { deps } = poolDeps({
      secrets: { "secret-2": apiKeySecret("sk-second") },
      entries: twoKeys,
    });
    const resolved = await resolveModelKey(
      deps,
      "user-1",
      "space-1",
      credential("secret-1"),
      "openai",
      "gpt-5.1",
    );
    expect(resolved.apiKey).toBe("sk-second");
    expect(resolved.keyId).toBe("key-2");
  });

  it("advances past a corrupt entry secret", async () => {
    const { deps } = poolDeps({
      secrets: { "secret-1": '{"kind":"api_key"}', "secret-2": apiKeySecret("sk-second") },
      entries: twoKeys,
    });
    const resolved = await resolveModelKey(
      deps,
      "user-1",
      "space-1",
      credential("secret-1"),
      "openai",
      "gpt-5.1",
    );
    expect(resolved.apiKey).toBe("sk-second");
    expect(resolved.keyId).toBe("key-2");
  });

  it("advances past a retired OAuth account to the next account", async () => {
    const { deps } = poolDeps({
      secrets: {
        "secret-1": serializeModelSecret({ kind: "oauth", reconnectRequired: true }),
        "secret-2": oauthSecret("access-second"),
      },
      entries: twoKeys,
    });
    const resolved = await resolveModelKey(
      deps,
      "user-1",
      "space-1",
      credential("secret-1", "openai-codex"),
      "openai-codex",
      "gpt-6-luna",
    );
    expect(resolved.oauth?.access).toBe("access-second");
    expect(resolved.keyId).toBe("key-2");
  });

  it("registers every tried entry's secrets for redaction", async () => {
    const { deps } = poolDeps({
      secrets: {
        // Codex Spark is not available to subscription sign-ins, so the OAuth
        // entry fails after its tokens were registered; the key entry serves.
        "secret-1": oauthSecret("access-dead", "refresh-dead"),
        "secret-2": apiKeySecret("sk-live"),
      },
      entries: twoKeys,
    });
    const registered: string[] = [];
    const resolved = await resolveModelKey(
      deps,
      "user-1",
      "space-1",
      credential("secret-1", "openai-codex"),
      "openai-codex",
      "gpt-5.3-codex-spark",
      (values) => registered.push(...values),
    );
    expect(resolved.apiKey).toBe("sk-live");
    expect(resolved.keyId).toBe("key-2");
    expect(registered).toContain("access-dead");
    expect(registered).toContain("refresh-dead");
    expect(registered).toContain("sk-live");
    expect(resolved.redact).toContain("sk-live");
  });

  it("does not advance on a secret store outage", async () => {
    const { deps, findFirst } = poolDeps({
      secrets: { "secret-1": apiKeySecret("sk-first"), "secret-2": apiKeySecret("sk-second") },
      entries: twoKeys,
      loadError: (secretId) =>
        secretId === "secret-1" ? new SecretStoreUnavailableError(503, "down") : undefined,
    });
    await expect(
      resolveModelKey(deps, "user-1", "space-1", credential("secret-1"), "openai", "gpt-5.1"),
    ).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(findFirst.mock.calls.map(([arg]) => arg.where.id)).toEqual(["secret-1"]);
  });

  it("resolves exactly the named entry when a keyId is given", async () => {
    const { deps } = poolDeps({
      secrets: { "secret-1": apiKeySecret("sk-first"), "secret-2": apiKeySecret("sk-second") },
      entries: twoKeys,
    });
    const resolved = await resolveModelKey(
      deps,
      "user-1",
      "space-1",
      credential("secret-1"),
      "openai",
      "gpt-5.1",
      undefined,
      { keyId: "key-2" },
    );
    expect(resolved.apiKey).toBe("sk-second");
    expect(resolved.keyId).toBe("key-2");
  });

  it("does not advance when the named entry fails", async () => {
    const { deps, findFirst } = poolDeps({
      secrets: { "secret-1": apiKeySecret("sk-first") },
      entries: twoKeys,
    });
    await expect(
      resolveModelKey(
        deps,
        "user-1",
        "space-1",
        credential("secret-1"),
        "openai",
        "gpt-5.1",
        undefined,
        { keyId: "key-2" },
      ),
    ).rejects.toThrow("Connect that model provider again.");
    expect(findFirst.mock.calls.map(([arg]) => arg.where.id)).toEqual(["secret-2"]);
  });

  it("keeps the single-credential path when the connection has no pool rows", async () => {
    const { deps } = poolDeps({
      secrets: { "secret-1": apiKeySecret("sk-only") },
      entries: [],
    });
    const resolved = await resolveModelKey(
      deps,
      "user-1",
      "space-1",
      credential("secret-1"),
      "openai",
      "gpt-5.1",
    );
    expect(resolved.apiKey).toBe("sk-only");
    expect(resolved.keyId).toBeUndefined();
  });

  it("serves a compatible connection's pooled key with the active entry's endpoint config", async () => {
    const { deps } = poolDeps({
      secrets: {
        "secret-1": serializeModelSecret({
          kind: "openai_compatible",
          baseUrl: "https://llm.invalid/v1",
          apiKey: "sk-endpoint-old",
          enabledModelIds: ["model-1"],
        }),
        "secret-2": apiKeySecret("sk-endpoint-new"),
      },
      entries: twoKeys,
    });
    const resolved = await resolveModelKey(
      deps,
      "user-1",
      "space-1",
      {
        id: "conn-1",
        secretId: "secret-1",
        provider: "openai-compatible",
        defaultModel: "model-1",
      },
      "openai-compatible",
      "model-1",
      undefined,
      { keyId: "key-2" },
    );
    expect(resolved.apiKey).toBe("sk-endpoint-new");
    expect(resolved.baseUrl).toBe("https://llm.invalid/v1");
    expect(resolved.keyId).toBe("key-2");
  });
});
