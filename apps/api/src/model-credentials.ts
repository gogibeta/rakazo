import { ORPCError } from "@orpc/server";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { CodexLiveCatalog, PiOAuthConnected } from "@rakazo/adapters";
import {
  buildModelConnectPlaintext,
  CHATGPT_OAUTH_PROVIDER,
  codexLiveListsModel,
  compatibleThinkingLevels,
  defaultCatalogModelId,
  modelCredentialDto,
  oauthCredentialEmail,
  parseModelSecret,
  prepareAllowedThinkingLevels as prepareModelThinkingLevels,
  providerCatalogCache,
  resolveCodexOAuthDefaultModel,
  serializeModelSecret,
  validateModelAuthAvailability,
  verifyCatalogProviderApiKey,
  verifyOpenAiCompatibleApiKey,
} from "@rakazo/adapters";
import type {
  Actor,
  ModelConnectInput,
  ModelCredential,
  ModelCredentialKey,
  SettingsScope,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  storedPiProviderIds,
  usableModelId,
} from "@rakazo/contracts";
import { clampCatalogThinkingLevel } from "@rakazo/core";
import {
  addModelCredentialKey,
  deleteUnreferencedCredentialSecret,
  findNewestUserModelCredential,
  getModelRole,
  listModelCredentialKeys,
  modelCredentialProviderFilter,
  modelRoleTarget,
  orderModelCredentialKeysForUse,
  Prisma,
  removeModelCredentialKey,
  saveModelPreference,
  withTransactionRetry,
  writeModelRole,
} from "@rakazo/db";
import { mayUsePrivateEndpoint } from "./mcp-servers.js";
import { assertNoDanglingModelPins } from "./model-pins.js";
import type { RouterDeps } from "./router.js";

export function prepareAllowedThinkingLevels(
  deps: RouterDeps,
  actor: Actor,
  provider: string,
  modelId: string,
  resolution?: { credentialId?: string | null },
) {
  return prepareModelThinkingLevels(
    { prisma: deps.prisma, secretStore: deps.secrets },
    actor,
    provider,
    modelId,
    resolution,
  );
}

async function allowedThinkingLevels(
  ...args: Parameters<typeof prepareAllowedThinkingLevels>
): Promise<string[] | undefined> {
  return (await prepareAllowedThinkingLevels(...args)).allowed;
}

/**
 * The connection a save updates: the named one, none for a new one, or the provider's
 * newest for apps that predate several connections per provider.
 */
export async function modelConnectionTarget(
  deps: RouterDeps,
  actor: Actor,
  provider: string,
  credentialId: string | null | undefined,
) {
  if (credentialId === null) return null;
  if (credentialId === undefined)
    return findNewestUserModelCredential(deps.prisma, actor.userId, provider);
  const credential = await deps.prisma.userModelCredential.findFirst({
    where: {
      id: credentialId,
      userId: actor.userId,
      provider: modelCredentialProviderFilter(provider),
    },
  });
  if (!credential) throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
  return credential;
}

/** `base`, or `base 2`, `base 3`… when another connection already has that name. */
export function nextConnectionLabel(base: string, taken: readonly string[]): string {
  const names = new Set(taken.map((label) => label.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let index = 2;
  while (names.has(`${base} ${index}`.toLowerCase())) index += 1;
  return `${base} ${index}`;
}

type ModelCredentialInput = {
  provider: string;
  /** The connection to update, or null to add one. */
  credentialId: string | null;
  plaintext: string;
  label?: string;
  modelId?: string;
  thinkingLevel?: string | null;
  /** False keeps the current main model. */
  makeDefault?: boolean;
  /** Which copy of the member's models makeDefault sets; omitted means the one that applies. */
  scope?: SettingsScope;
  supportsImages?: boolean;
  signal?: AbortSignal;
  /** Becomes the main model only while there is none. */
  keepExistingDefault?: boolean;
};

export async function prepareModelCredential(
  deps: RouterDeps,
  actor: Actor,
  input: ModelCredentialInput,
  codexCatalog: CodexLiveCatalog,
) {
  throwIfAborted(input.signal);
  const parsedSecret = parseModelSecret(input.plaintext);
  const requestedModelId = usableModelId(input.modelId);
  const resolvedCodexModelId =
    canonicalPiProviderId(input.provider) === CHATGPT_OAUTH_PROVIDER &&
    parsedSecret.kind === "oauth"
      ? await resolveCodexOAuthDefaultModel(
          codexCatalog,
          actor.userId,
          parsedSecret,
          requestedModelId,
        )
      : requestedModelId;
  const authError = resolvedCodexModelId
    ? validateModelAuthAvailability(input.provider, resolvedCodexModelId, input.plaintext)
    : undefined;
  // The backend's live catalog can clear a static OAuth exclusion for the
  // account this credential signs into (e.g. Codex Spark on ChatGPT plans).
  if (
    authError &&
    resolvedCodexModelId &&
    !(await codexLiveListsModel(codexCatalog, actor.userId, parsedSecret, resolvedCodexModelId))
  ) {
    throw new ORPCError("BAD_REQUEST", { message: authError });
  }
  const defaultModel =
    resolvedCodexModelId ??
    defaultCatalogModelId(input.provider, input.plaintext) ??
    usableModelId(deps.env.defaultModel);
  // A compatible connect may enable its new default, so judge it by the secret being saved.
  const allowedThinking = !defaultModel
    ? undefined
    : input.provider === OPENAI_COMPATIBLE_PROVIDER_ID
      ? compatibleThinkingLevels(
          { id: "", provider: input.provider, label: "", defaultModel },
          input.plaintext,
          defaultModel,
        ).allowed
      : await allowedThinkingLevels(deps, actor, input.provider, defaultModel);
  const stored = await deps.secrets.put(input.plaintext, {
    operationId: "cred",
    traceId: "cred",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: input.signal ?? new AbortController().signal,
  });
  return { stored, defaultModel, allowedThinking };
}

/** Create-only: null when the provider is already connected. */
export async function createImportedModelCredential(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: ModelCredentialInput,
  prepared: Awaited<ReturnType<typeof prepareModelCredential>>,
) {
  const existing = await tx.userModelCredential.findFirst({
    where: { userId: actor.userId, provider: { in: storedPiProviderIds(input.provider) } },
    select: { id: true },
  });
  if (existing) return null;
  return writeModelCredential(tx, actor, input, prepared);
}

async function writeModelCredential(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: ModelCredentialInput,
  prepared: Awaited<ReturnType<typeof prepareModelCredential>>,
) {
  const { stored, defaultModel, allowedThinking } = prepared;
  throwIfAborted(input.signal);
  const existing = input.credentialId
    ? await tx.userModelCredential.findFirst({
        where: {
          id: input.credentialId,
          userId: actor.userId,
          provider: { in: storedPiProviderIds(input.provider) },
        },
      })
    : null;
  // A connection removed while this save was in flight stays removed.
  if (input.credentialId && !existing)
    throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
  throwIfAborted(input.signal);
  const secret = await tx.secret.create({
    data: {
      id: stored.id,
      userId: actor.userId,
      spaceId: null,
      kind: "model",
      ciphertext: stored.ciphertext,
    },
  });
  throwIfAborted(input.signal);
  const credential = !existing
    ? await tx.userModelCredential.create({
        data: {
          userId: actor.userId,
          provider: input.provider,
          label: nextConnectionLabel(
            input.label?.trim() || input.provider,
            (
              await tx.userModelCredential.findMany({
                where: { userId: actor.userId },
                select: { label: true },
              })
            ).map((row) => row.label),
          ),
          secretId: secret.id,
          supportsImages: input.supportsImages ?? false,
        },
      })
    : await tx.userModelCredential.update({
        where: { id: existing.id },
        // A new key or sign-in keeps the connection's name.
        data: {
          secretId: secret.id,
          ...(input.supportsImages !== undefined ? { supportsImages: input.supportsImages } : {}),
        },
      });
  // Keep the credential pool in step: a new connection's secret is its first
  // entry, and a replaced secret moves the entry that held the old one, so the
  // active entry always points at the connection's own secret.
  if (!existing) {
    await addModelCredentialKey(tx, {
      userId: actor.userId,
      credentialId: credential.id,
      label: "",
      secretId: secret.id,
    });
  } else {
    await tx.userModelCredentialKey.updateMany({
      where: { credentialId: existing.id, secretId: existing.secretId },
      data: { secretId: secret.id },
    });
  }
  throwIfAborted(input.signal);
  // Connect and limit saves can still carry an effort chosen for the previous
  // model. Keep it only when this model supports it; otherwise clamp or clear.
  const thinkingLevel =
    input.thinkingLevel === undefined
      ? undefined
      : defaultModel
        ? clampCatalogThinkingLevel(input.thinkingLevel, allowedThinking)
        : null;
  const target = await modelRoleTarget(tx, actor, input.scope);
  const mainRole = await getModelRole(tx, target, "main");
  const runsMain = mainRole.primary?.credentialId === credential.id;
  // Only an explicit main-model connect changes a role. Omitted means yes for older apps.
  const becomesMain =
    input.makeDefault !== false &&
    Boolean(defaultModel) &&
    (!input.keepExistingDefault || !mainRole.primary);
  // A main-model connect keeps the effort its model already had.
  const ownThinking = becomesMain
    ? ((
        await writeModelRole(tx, target, "main", {
          primary: {
            provider: input.provider,
            modelId: defaultModel!,
            thinkingLevel: thinkingLevel as ThinkingLevel | null | undefined,
            credentialId: credential.id,
          },
        })
      ).primary?.thinkingLevel ?? null)
    : (thinkingLevel ?? null);
  // The connection's own model; a save for another purpose keeps the one running chat.
  if (becomesMain || !runsMain)
    await saveModelPreference(tx, actor, credential.id, defaultModel, ownThinking);
  throwIfAborted(input.signal);
  if (existing) {
    await deleteUnreferencedCredentialSecret(tx, {
      credentialKind: "model",
      credentialId: existing.id,
      secretId: existing.secretId,
    });
    throwIfAborted(input.signal);
  }
  return { ...credential, isDefault: becomesMain || runsMain, defaultModel };
}

export async function persistModelCredential(
  deps: RouterDeps,
  actor: Actor,
  input: ModelCredentialInput,
  codexCatalog: CodexLiveCatalog,
) {
  const prepared = await prepareModelCredential(deps, actor, input, codexCatalog);
  throwIfAborted(input.signal);
  const cred = await withTransactionRetry(() =>
    deps.prisma.$transaction((tx) => writeModelCredential(tx, actor, input, prepared), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }),
  );
  (deps.providerCatalog ?? providerCatalogCache).invalidate(canonicalPiProviderId(input.provider));
  return modelCredentialDto(cred, input.plaintext);
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
}

/**
 * A connection's pooled keys and accounts as the settings screens show them:
 * labels and status only — no secret material ever leaves through this DTO.
 * The active entry (the one the connection's own secret points at) comes
 * first, then the rest in pool order.
 */
export async function modelCredentialKeysDto(
  deps: RouterDeps,
  actor: Actor,
  credentialId: string,
): Promise<ModelCredentialKey[]> {
  // The pool is an optional view of the connection: a read failure shows the
  // connection without its keys rather than failing the whole list.
  const credential = await deps.prisma.userModelCredential
    .findFirst({
      where: { id: credentialId, userId: actor.userId },
      select: { id: true, secretId: true },
    })
    .catch(() => null);
  if (!credential) return [];
  const entries = await listModelCredentialKeys(deps.prisma, {
    userId: actor.userId,
    credentialId,
  }).catch(() => []);
  if (entries.length === 0) return [];
  const secrets = await deps.prisma.secret.findMany({
    where: {
      id: { in: entries.map((entry) => entry.secretId) },
      userId: actor.userId,
      spaceId: null,
    },
    select: { id: true, ciphertext: true },
  });
  const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  const parsedById = new Map<string, ReturnType<typeof parseModelSecret>>();
  for (const entry of entries) {
    const ciphertext = ciphertextById.get(entry.secretId);
    if (!ciphertext) continue;
    try {
      parsedById.set(
        entry.id,
        parseModelSecret(await deps.secrets.load(ciphertext, entry.secretId)),
      );
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError)
        throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
      // An unreadable secret shows without a kind, like the connection itself.
    }
  }
  return orderModelCredentialKeysForUse(entries, credential.secretId).map((entry, index) => {
    const parsed = parsedById.get(entry.id);
    return {
      id: entry.id,
      label:
        entry.label || (parsed?.kind === "oauth" ? `Account ${index + 1}` : `Key ${index + 1}`),
      ...(parsed ? { authKind: parsed.kind } : {}),
      active: entry.secretId === credential.secretId,
      ...(parsed?.kind === "oauth" && parsed.reconnectRequired ? { reconnectRequired: true } : {}),
      ...(entry.lastFailedAt ? { lastFailedAt: entry.lastFailedAt.toISOString() } : {}),
    };
  });
}

/** The connection DTO the key/account mutations answer with, pool included. */
async function modelCredentialResponse(
  deps: RouterDeps,
  actor: Actor,
  credential: {
    id: string;
    provider: string;
    label: string;
    secretId: string;
    supportsImages: boolean;
  },
): Promise<ModelCredential> {
  const [preference, secretRow] = await Promise.all([
    deps.prisma.userModelPreference.findFirst({
      where: { userId: actor.userId, credentialId: credential.id },
    }),
    deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: actor.userId, spaceId: null },
      select: { ciphertext: true },
    }),
  ]);
  let plaintext: string | undefined;
  if (secretRow) {
    try {
      plaintext = await deps.secrets.load(secretRow.ciphertext, credential.secretId);
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError)
        throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
    }
  }
  const dto = modelCredentialDto(
    {
      ...credential,
      defaultModel: preference?.modelId ?? null,
      thinkingLevel: preference?.thinkingLevel ?? null,
    },
    plaintext,
  );
  return { ...dto, keys: await modelCredentialKeysDto(deps, actor, credential.id) };
}

async function loadConnectionSecret(
  deps: RouterDeps,
  actor: Actor,
  credential: { secretId: string },
): Promise<string | undefined> {
  const row = await deps.prisma.secret.findFirst({
    where: { id: credential.secretId, userId: actor.userId, spaceId: null },
    select: { ciphertext: true },
  });
  if (!row) return undefined;
  try {
    return await deps.secrets.load(row.ciphertext, credential.secretId);
  } catch {
    return undefined;
  }
}

/**
 * Add one API key to a connection's pool. The key is verified the way connect
 * verifies it, then stored as its own secret; the connection's settings stay
 * on the active entry, so the new key serves the connection as configured.
 */
export async function addModelConnectionKey(
  deps: RouterDeps,
  actor: Actor,
  input: {
    credentialId: string;
    apiKey: string;
    label?: string;
    accountId?: string;
    gatewayId?: string;
  },
  signal?: AbortSignal,
): Promise<ModelCredential> {
  const credential = await deps.prisma.userModelCredential.findFirst({
    where: { id: input.credentialId, userId: actor.userId },
  });
  if (!credential) throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
  const activePlaintext = await loadConnectionSecret(deps, actor, credential);
  let plaintext: string;
  try {
    if (credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      const active = activePlaintext ? parseModelSecret(activePlaintext) : undefined;
      if (active?.kind !== "openai_compatible")
        throw new Error("Connect that model provider again.");
      await verifyOpenAiCompatibleApiKey(
        { ...active, apiKey: input.apiKey },
        deps.modelConnectionFetch,
        signal,
      );
      plaintext = serializeModelSecret({ kind: "api_key", key: input.apiKey });
    } else {
      await verifyCatalogProviderApiKey(
        { provider: credential.provider, apiKey: input.apiKey },
        deps.modelConnectionFetch,
        signal,
      );
      plaintext = serializeModelSecret({
        kind: "api_key",
        key: input.apiKey,
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.gatewayId ? { gatewayId: input.gatewayId } : {}),
      });
      const saved = parseModelSecret(plaintext);
      const preference = await deps.prisma.userModelPreference.findFirst({
        where: { userId: actor.userId, credentialId: credential.id },
        select: { modelId: true },
      });
      const modelId =
        usableModelId(preference?.modelId) ??
        defaultCatalogModelId(credential.provider, activePlaintext ?? plaintext);
      if (saved.kind === "api_key" && modelId && deps.modelConnectionCheck) {
        await deps.modelConnectionCheck(
          {
            provider: credential.provider,
            id: modelId,
            apiKey: saved.key,
            accountId: saved.accountId,
            gatewayId: saved.gatewayId,
          },
          { fetch: deps.modelConnectionFetch, signal },
        );
      }
    }
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Invalid model connection",
    });
  }
  const stored = await deps.secrets.put(plaintext, {
    operationId: "cred",
    traceId: "cred",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  });
  await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: null,
            kind: "model",
            ciphertext: stored.ciphertext,
          },
        });
        await addModelCredentialKey(tx, {
          userId: actor.userId,
          credentialId: credential.id,
          label: input.label?.trim() ?? "",
          secretId: secret.id,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  (deps.providerCatalog ?? providerCatalogCache).invalidate(
    canonicalPiProviderId(credential.provider),
  );
  return modelCredentialResponse(deps, actor, credential);
}

/** Remove one key or account from a connection's pool. */
export async function removeModelConnectionKey(
  deps: RouterDeps,
  actor: Actor,
  input: { credentialId: string; keyId: string },
): Promise<ModelCredential> {
  const credential = await deps.prisma.userModelCredential.findFirst({
    where: { id: input.credentialId, userId: actor.userId },
  });
  if (!credential) throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
  let removed: Awaited<ReturnType<typeof removeModelCredentialKey>>;
  try {
    removed = await removeModelCredentialKey(deps.prisma, {
      userId: actor.userId,
      credentialId: credential.id,
      keyId: input.keyId,
    });
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Could not remove the key",
    });
  }
  if (!removed) throw new ORPCError("NOT_FOUND", { message: "Key not found" });
  await deleteUnreferencedCredentialSecret(deps.prisma, {
    credentialKind: "model",
    credentialId: credential.id,
    secretId: removed.secretId,
  });
  (deps.providerCatalog ?? providerCatalogCache).invalidate(
    canonicalPiProviderId(credential.provider),
  );
  return modelCredentialResponse(deps, actor, credential);
}

/**
 * Finish an add-account sign-in: the account joins the connection's pool as a
 * new entry. The connection's own sign-in, models and roles are untouched.
 */
export async function appendOAuthConnectionKey(
  deps: RouterDeps,
  actor: Actor,
  login: PiOAuthConnected,
): Promise<ModelCredential> {
  const target = await modelConnectionTarget(deps, actor, login.provider, login.credentialId);
  if (!target) throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
  const plaintext = serializeModelSecret({ kind: "oauth", credential: login.credential });
  const stored = await deps.secrets.put(plaintext, {
    operationId: "cred",
    traceId: "cred",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: login.signal ?? new AbortController().signal,
  });
  await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: null,
            kind: "model",
            ciphertext: stored.ciphertext,
          },
        });
        await addModelCredentialKey(tx, {
          userId: actor.userId,
          credentialId: target.id,
          label: oauthCredentialEmail(login.credential) ?? login.label ?? "",
          secretId: secret.id,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  (deps.providerCatalog ?? providerCatalogCache).invalidate(canonicalPiProviderId(login.provider));
  return modelCredentialResponse(deps, actor, target);
}

export function createModelConnector(deps: RouterDeps, codexCatalog: CodexLiveCatalog) {
  const verifyModelConnection = async (
    actor: Actor,
    input: ModelConnectInput,
    signal: AbortSignal | undefined,
  ) => {
    const credential = await modelConnectionTarget(deps, actor, input.provider, input.credentialId);
    let plaintext: string;
    try {
      let previousPlaintext: string | undefined;
      let omitVisionModelIds = false;
      if (credential) {
        const secret = await deps.prisma.secret.findFirst({
          where: { id: credential.secretId, userId: actor.userId, spaceId: null },
          select: { ciphertext: true },
        });
        if (secret) {
          try {
            previousPlaintext = await deps.secrets.load(secret.ciphertext, credential.secretId);
          } catch (error) {
            // Explicit key replacement must still succeed when the prior ciphertext is
            // unreadable. Omitting visionModelIds keeps a partial one-model list from
            // wiping other enabled models.
            if (input.apiKey === undefined) throw error;
            if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
              omitVisionModelIds = true;
            }
          }
        }
      }
      plaintext = buildModelConnectPlaintext(input, previousPlaintext, {
        omitVisionModelIds,
        allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
      });
      if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
        const saved = parseModelSecret(plaintext);
        if (saved.kind === "openai_compatible") {
          await verifyOpenAiCompatibleApiKey(saved, deps.modelConnectionFetch, signal);
        }
      }
      if (input.apiKey?.trim()) {
        await verifyCatalogProviderApiKey(
          { provider: input.provider, apiKey: input.apiKey },
          deps.modelConnectionFetch,
          signal,
        );
        const saved = parseModelSecret(plaintext);
        const modelId =
          usableModelId(input.modelId) ?? defaultCatalogModelId(input.provider, plaintext);
        if (saved.kind === "api_key" && modelId && deps.modelConnectionCheck) {
          await deps.modelConnectionCheck(
            {
              provider: input.provider,
              id: modelId,
              apiKey: saved.key,
              accountId: saved.accountId,
              gatewayId: saved.gatewayId,
              maxTokens: saved.maxTokens,
            },
            { fetch: deps.modelConnectionFetch, signal },
          );
        }
      }
    } catch (error) {
      throw new ORPCError("BAD_REQUEST", {
        message: error instanceof Error ? error.message : "Invalid model connection",
      });
    }
    if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      // Known race: this runs before persistModelCredential's transaction, so a pin saved in
      // between can fall outside the stored list and fail at run time. Concurrent saves of
      // the same connection are last-write-wins.
      const saved = parseModelSecret(plaintext);
      if (credential)
        await assertNoDanglingModelPins(deps, actor, credential, saved, input.modelId ?? "");
    }
    return { plaintext, credential };
  };
  const connectModelCredential = async (
    actor: Actor,
    input: ModelConnectInput,
    signal: AbortSignal | undefined,
  ) => {
    const { plaintext, credential } = await verifyModelConnection(actor, input, signal);
    return persistModelCredential(
      deps,
      actor,
      {
        provider: input.provider,
        credentialId: credential?.id ?? null,
        plaintext,
        label: input.label,
        modelId: input.modelId,
        // openai-compatible keeps its effort inside the stored endpoint
        // secret; catalog providers store it on the space preference.
        thinkingLevel:
          input.provider === OPENAI_COMPATIBLE_PROVIDER_ID ? undefined : input.thinkingLevel,
        makeDefault: input.makeDefault,
        scope: input.scope,
        supportsImages: input.supportsImages,
        signal,
      },
      codexCatalog,
    );
  };
  return { verifyModelConnection, connectModelCredential };
}
