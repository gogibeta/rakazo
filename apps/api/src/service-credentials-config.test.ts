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
  telegramOwnerUserIds: [] as string[],
  signupsEnabled: true,
};

/** An in-memory deployment settings row and secret table behind the calls the config makes. */
function makeDeps(options: { admin?: boolean; envSignupsEnabled?: string } = {}) {
  const state = {
    settings: null as null | {
      serviceCredentialsCipher: string | null;
      telegramOwnerUserIds?: string | null;
      signupsEnabled?: boolean;
      signupPolicyInitialized?: boolean;
    },
    secrets: new Map<string, string>(),
  };
  let nextSecret = 0;
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ email: "admin@example.com", emailVerified: true })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => state.settings),
      upsert: vi.fn(async ({ update }: { update: Record<string, string | null> }) => {
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
    env: {
      adminEmails: options.admin === false ? [] : ["admin@example.com"],
      signupsEnabled: options.envSignupsEnabled,
      signupAllowlist: undefined,
    },
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
    await expect(updateServiceCredentials(deps, actor, { signupsEnabled: false })).rejects.toThrow(
      "Admins only",
    );
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

  it("saves the Telegram owner allowlist in the clear and reports it back", async () => {
    const { deps, state } = makeDeps();
    const status = await updateServiceCredentials(deps, actor, {
      telegramBotToken: "bot-token",
      telegramOwnerUserIds: "123456789, 987654321",
    });
    expect(status).toEqual({
      ...EMPTY_STATUS,
      telegramBotToken: true,
      telegramOwnerUserIds: ["123456789", "987654321"],
    });
    // The IDs sit on the settings row in the clear, never in the sealed record.
    expect(state.settings?.telegramOwnerUserIds).toBe("123456789,987654321");
    expect([...state.secrets.values()].join(" ")).not.toContain("123456789");
    await expect(getServiceCredentials(deps, actor)).resolves.toEqual(status);
  });

  it("leaves the allowlist alone when the field is absent and clears it on empty", async () => {
    const { deps, state } = makeDeps();
    await updateServiceCredentials(deps, actor, { telegramOwnerUserIds: "42" });
    const kept = await updateServiceCredentials(deps, actor, { naceApiKey: "nace-key" });
    expect(kept.telegramOwnerUserIds).toEqual(["42"]);
    const cleared = await updateServiceCredentials(deps, actor, { telegramOwnerUserIds: "" });
    expect(cleared.telegramOwnerUserIds).toEqual([]);
    expect(state.settings?.telegramOwnerUserIds).toBe("");
  });

  it("reports the environment's signup policy until one is saved", async () => {
    const { deps } = makeDeps({ envSignupsEnabled: "false" });
    await expect(getServiceCredentials(deps, actor)).resolves.toEqual({
      ...EMPTY_STATUS,
      signupsEnabled: false,
    });
  });

  it("saves the account-creation switch on the deployment record", async () => {
    const { deps, state } = makeDeps();
    const status = await updateServiceCredentials(deps, actor, { signupsEnabled: false });
    expect(status).toEqual({ ...EMPTY_STATUS, signupsEnabled: false });
    expect(state.settings?.signupsEnabled).toBe(false);
    expect(state.settings?.signupPolicyInitialized).toBe(true);
    // Not a key: nothing about the switch lands in the sealed record.
    expect(state.secrets.size).toBe(0);
    await expect(getServiceCredentials(deps, actor)).resolves.toEqual(status);
  });

  it("a saved switch overrides the environment in both directions", async () => {
    const { deps } = makeDeps({ envSignupsEnabled: "false" });
    const status = await updateServiceCredentials(deps, actor, { signupsEnabled: true });
    expect(status.signupsEnabled).toBe(true);
    await expect(getServiceCredentials(deps, actor)).resolves.toEqual(status);
  });

  it("leaves the switch alone when the field is absent", async () => {
    const { deps } = makeDeps();
    await updateServiceCredentials(deps, actor, { signupsEnabled: false });
    const status = await updateServiceCredentials(deps, actor, { naceApiKey: "nace-key" });
    expect(status.signupsEnabled).toBe(false);
  });

  it("clearing a key keeps the allowlist", async () => {
    const { deps } = makeDeps();
    await updateServiceCredentials(deps, actor, {
      tinyfishApiKey: "fish-key",
      telegramOwnerUserIds: "42",
    });
    const status = await clearServiceCredentials(deps, actor, { keys: ["tinyfishApiKey"] });
    expect(status.telegramOwnerUserIds).toEqual(["42"]);
  });
});
