import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  clearServiceCredentials,
  getServiceCredentials,
  updateServiceCredentials,
} from "./service-credentials-config.js";

const actor = { userId: "user-1", spaceId: "space-1", email: "admin@example.com" } as never;

const EMPTY_STATUS = {
  tinyfishApiKey: false,
  naceApiKey: false,
  telegramBotToken: false,
  telegramWebhookSecret: false,
  whatsappAccessToken: false,
  whatsappPhoneNumberId: false,
  whatsappAppSecret: false,
  whatsappVerifyToken: false,
};

/** An in-memory deployment settings row and secret table behind the calls the config makes. */
function makeDeps(options: { admin?: boolean } = {}) {
  const state = {
    settings: null as null | { serviceCredentialsCipher: string | null },
    secrets: new Map<string, string>(),
  };
  let nextSecret = 0;
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ email: "admin@example.com", emailVerified: true })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => state.settings),
      upsert: vi.fn(async ({ update }: { update: { serviceCredentialsCipher: string | null } }) => {
        state.settings = { serviceCredentialsCipher: null, ...state.settings, ...update };
        return state.settings;
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: {
      put: vi.fn(async (plaintext: string) => {
        const id = `secret-${++nextSecret}`;
        state.secrets.set(id, plaintext);
        return { id, ref: id, ciphertext: id };
      }),
      load: vi.fn(async (ciphertext: string) => {
        const plaintext = state.secrets.get(ciphertext);
        if (plaintext === undefined) throw new Error("unknown secret");
        return plaintext;
      }),
      delete: vi.fn(async (ciphertext: string) => {
        state.secrets.delete(ciphertext);
      }),
    },
    env: { adminEmails: options.admin === false ? [] : ["admin@example.com"] },
  };
  return { deps, state };
}

describe("service credentials settings", () => {
  it("is for admins only", async () => {
    const { deps } = makeDeps({ admin: false });
    await expect(getServiceCredentials(deps, actor)).rejects.toThrow("Admins only");
    await expect(updateServiceCredentials(deps, actor, { tinyfishApiKey: "key" })).rejects.toThrow(
      "Admins only",
    );
    await expect(
      clearServiceCredentials(deps, actor, { keys: ["tinyfishApiKey"] }),
    ).rejects.toThrow("Admins only");
  });

  it("reports nothing saved before any key is set", async () => {
    const { deps } = makeDeps();
    await expect(getServiceCredentials(deps, actor)).resolves.toEqual(EMPTY_STATUS);
  });

  it("saves keys sealed and reports only which are set", async () => {
    const { deps, state } = makeDeps();
    const status = await updateServiceCredentials(deps, actor, {
      tinyfishApiKey: "fish-key",
      telegramBotToken: "bot-token",
    });
    expect(status).toEqual({ ...EMPTY_STATUS, tinyfishApiKey: true, telegramBotToken: true });
    expect(state.settings?.serviceCredentialsCipher).toBe("secret-1");
    // The row holds a reference, never a key; the sealed payload holds the keys.
    expect(JSON.stringify(state.settings)).not.toContain("fish-key");
    expect([...state.secrets.values()]).toEqual([
      JSON.stringify({ tinyfishApiKey: "fish-key", telegramBotToken: "bot-token" }),
    ]);
    await expect(getServiceCredentials(deps, actor)).resolves.toEqual(status);
  });

  it("trims values and keeps the saved key when a field comes back blank", async () => {
    const { deps, state } = makeDeps();
    await updateServiceCredentials(deps, actor, { naceApiKey: "  nace-key  " });
    const status = await updateServiceCredentials(deps, actor, {
      naceApiKey: "",
      tinyfishApiKey: "fish-key",
    });
    expect(status).toEqual({ ...EMPTY_STATUS, naceApiKey: true, tinyfishApiKey: true });
    expect([...state.secrets.values()]).toEqual([
      JSON.stringify({ naceApiKey: "nace-key", tinyfishApiKey: "fish-key" }),
    ]);
  });

  it("replaces the sealed record and forgets the one it replaced", async () => {
    const { deps, state } = makeDeps();
    await updateServiceCredentials(deps, actor, { naceApiKey: "first" });
    await updateServiceCredentials(deps, actor, { naceApiKey: "second" });
    expect(state.settings?.serviceCredentialsCipher).toBe("secret-2");
    expect([...state.secrets.values()]).toEqual([JSON.stringify({ naceApiKey: "second" })]);
  });

  it("clears one key and keeps the rest", async () => {
    const { deps } = makeDeps();
    await updateServiceCredentials(deps, actor, {
      tinyfishApiKey: "fish-key",
      naceApiKey: "nace-key",
    });
    const status = await clearServiceCredentials(deps, actor, { keys: ["tinyfishApiKey"] });
    expect(status).toEqual({ ...EMPTY_STATUS, naceApiKey: true });
  });

  it("clearing the last key removes the record entirely", async () => {
    const { deps, state } = makeDeps();
    await updateServiceCredentials(deps, actor, { tinyfishApiKey: "fish-key" });
    const status = await clearServiceCredentials(deps, actor, { keys: ["tinyfishApiKey"] });
    expect(status).toEqual(EMPTY_STATUS);
    expect(state.settings?.serviceCredentialsCipher).toBeNull();
    expect(state.secrets.size).toBe(0);
  });
});
