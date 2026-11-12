import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  loadServiceCredentials,
  loadTelegramOwnerUserIds,
  mergeServiceCredentialsIntoMessagingEnv,
  parseServiceCredentials,
} from "./service-credentials.js";

describe("parseServiceCredentials", () => {
  it("keeps known keys and trims their values", () => {
    expect(
      parseServiceCredentials(
        JSON.stringify({ tinyfishApiKey: "  fish-key ", telegramBotToken: "bot-token" }),
      ),
    ).toEqual({ tinyfishApiKey: "fish-key", telegramBotToken: "bot-token" });
  });

  it("drops unknown keys, blank values and non-strings", () => {
    expect(
      parseServiceCredentials(
        JSON.stringify({
          tinyfishApiKey: "   ",
          naceApiKey: 42,
          whatsappAppSecret: "secret",
          somethingElse: "nope",
        }),
      ),
    ).toEqual({ whatsappAppSecret: "secret" });
  });

  it("returns no credentials for payloads that are not a JSON object", () => {
    expect(parseServiceCredentials("not json")).toEqual({});
    expect(parseServiceCredentials(JSON.stringify(["tinyfishApiKey"]))).toEqual({});
    expect(parseServiceCredentials(JSON.stringify(null))).toEqual({});
  });
});

describe("loadServiceCredentials", () => {
  function makeDeps(cipher: string | null, plaintext?: string) {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn(async () => (cipher ? { serviceCredentialsCipher: cipher } : null)),
      },
    } as unknown as PrismaClient;
    const secrets: Pick<SecretStore, "load"> = {
      load: vi.fn(async () => {
        if (plaintext === undefined) throw new Error("cannot unseal");
        return plaintext;
      }),
    };
    return { prisma, secrets };
  }

  it("unseals the saved record", async () => {
    const { prisma, secrets } = makeDeps("cipher-1", JSON.stringify({ naceApiKey: "nace-key" }));
    await expect(loadServiceCredentials(prisma, secrets)).resolves.toEqual({
      naceApiKey: "nace-key",
    });
    expect(secrets.load).toHaveBeenCalledWith("cipher-1", "deployment-service-credentials");
  });

  it("returns no credentials when nothing is saved", async () => {
    const { prisma, secrets } = makeDeps(null);
    await expect(loadServiceCredentials(prisma, secrets)).resolves.toEqual({});
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it("returns no credentials when the record cannot be unsealed", async () => {
    const { prisma, secrets } = makeDeps("cipher-1");
    await expect(loadServiceCredentials(prisma, secrets)).resolves.toEqual({});
  });
});

describe("mergeServiceCredentialsIntoMessagingEnv", () => {
  const saved = {
    telegramBotToken: "saved-bot-token",
    telegramWebhookSecret: "saved-webhook-secret",
    whatsappAccessToken: "saved-access-token",
    tinyfishApiKey: "not-a-messaging-key",
  };

  it("fills the fields the environment leaves unset", () => {
    expect(mergeServiceCredentialsIntoMessagingEnv({}, saved)).toEqual({
      telegramBotToken: "saved-bot-token",
      telegramWebhookSecret: "saved-webhook-secret",
      whatsappAccessToken: "saved-access-token",
    });
  });

  it("never overrides the environment", () => {
    expect(
      mergeServiceCredentialsIntoMessagingEnv({ telegramBotToken: "env-bot-token" }, saved),
    ).toMatchObject({ telegramBotToken: "env-bot-token" });
  });

  it("treats blank environment values as unset", () => {
    expect(
      mergeServiceCredentialsIntoMessagingEnv({ telegramBotToken: "  " }, saved),
    ).toMatchObject({ telegramBotToken: "saved-bot-token" });
  });

  it("ignores blank saved values", () => {
    expect(mergeServiceCredentialsIntoMessagingEnv({}, { telegramBotToken: "   " })).toEqual({});
  });
});

describe("loadTelegramOwnerUserIds", () => {
  function makePrisma(row: { telegramOwnerUserIds: string } | null, fail = false) {
    return {
      deploymentSettings: {
        findUnique: vi.fn(async () => {
          if (fail) throw new Error("database unavailable");
          return row;
        }),
      },
    } as unknown as PrismaClient;
  }

  it("reads the saved IDs", async () => {
    await expect(
      loadTelegramOwnerUserIds(makePrisma({ telegramOwnerUserIds: "123456789, 987654321" })),
    ).resolves.toEqual(["123456789", "987654321"]);
  });

  it("returns no IDs when nothing is saved", async () => {
    await expect(loadTelegramOwnerUserIds(makePrisma(null))).resolves.toEqual([]);
    await expect(
      loadTelegramOwnerUserIds(makePrisma({ telegramOwnerUserIds: "" })),
    ).resolves.toEqual([]);
  });

  it("keeps only the entries a damaged value parses to", async () => {
    await expect(
      loadTelegramOwnerUserIds(makePrisma({ telegramOwnerUserIds: "abc, 123, ,45x" })),
    ).resolves.toEqual(["123"]);
  });

  it("returns no IDs when the record cannot be read, so the bots stay up", async () => {
    await expect(loadTelegramOwnerUserIds(makePrisma(null, true))).resolves.toEqual([]);
  });
});
