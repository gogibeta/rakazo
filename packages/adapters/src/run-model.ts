import type {
  AgentModelOAuthCredential,
  AgentRunRequest,
  AgentRuntime,
  ModelCredentialFailedState,
  ModelCredentialRetireReason,
} from "@rakazo/adapter-kit";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import { listModelCredentialKeys, orderModelCredentialKeysForUse } from "@rakazo/db";
import {
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  CLOUDFLARE_WORKERS_AI_PROVIDER_ID,
  cloudflareModelConfigMessage,
  cloudflareProviderEnv,
} from "./cloudflare-ai-gateway.js";
import { resolveDeploymentModel } from "./deployment-model.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { FleetPrepareDeps } from "./fleet-tools.js";
import {
  kickModelCredentialRefresh,
  persistStoredModelSecret,
  refreshStoredModelCredential,
  resolveStoredModelAuth,
  retireToReconnectMarker,
  withModelCredentialLock,
} from "./model-credential-refresh.js";
import {
  HostedModelCreditsRequiredError,
  hostedModelCreditObserver,
} from "./model-credit-observer.js";
import { resolveMemberMainModel, selectConfiguredModel } from "./model-roles.js";
import type { StoredModelSecret } from "./model-secret.js";
import {
  CORRUPT_MODEL_SECRET_MESSAGE,
  parseModelSecret,
  secretValuesToRedact,
  serializeModelSecret,
} from "./model-secret.js";
import {
  enabledOpenAiCompatibleModelIds,
  findConnectedModelCredential,
  hasHostedModelCredits,
  PINNED_PROVIDER_NOT_CONNECTED,
  UnavailableModelForAuthError,
  validateConnectedModelChoice,
  validateModelAuthAvailability,
} from "./model-selection.js";
import { compatibleModelSeesImages } from "./model-vision.js";
import { assertAllowedOpenAiCompatibleUrl } from "./openai-compatible-url.js";
import { codexLiveModel } from "./pi-codex-catalog.js";
import { toOAuthCredential } from "./pi-credentials.js";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider.js";
import { CHATGPT_OAUTH_PROVIDER, isRetiredModelCredentialError } from "./pi-oauth.js";

export function runtimeFallbackModel(runtime: AgentRuntime) {
  return runtime.describe().capabilities.scripted ? { provider: "scripted", id: "scripted" } : null;
}

export function isTerminalModelSetupError(error: unknown): boolean {
  return (
    error instanceof UnavailableModelForAuthError ||
    error instanceof HostedModelCreditsRequiredError ||
    isRetiredModelCredentialError(error) ||
    (error instanceof Error &&
      (error.message === CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE ||
        error.message === cloudflareModelConfigMessage(CLOUDFLARE_WORKERS_AI_PROVIDER_ID)))
  );
}

export async function fleetPrepareDeps(
  deps: ExecutorDeps,
  scope: { userId: string; spaceId: string },
): Promise<FleetPrepareDeps> {
  const hostedProvider = (await modelCreditBillingEnabled(deps))
    ? resolveDeploymentModel().provider
    : undefined;
  return {
    prisma: deps.prisma,
    modelChange: {
      hostedProvider,
      secretStore: deps.secretStore,
      codexCatalog: deps.codexCatalog,
      refreshExpiredCredential: (credentialScope, secretId, provider) =>
        kickModelCredentialRefresh(
          deps.prisma,
          deps.secretStore,
          credentialScope,
          secretId,
          provider,
        ),
      defaultModel: async () => {
        const [main, settings] = await Promise.all([
          resolveMemberMainModel(deps, scope),
          deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
        ]);
        const selected = selectConfiguredModel({
          override: null,
          overrideCredential: null,
          main,
          hostedProvider,
          defaults: {
            settings,
            deployment: deps.deploymentModelConfigured ? resolveDeploymentModel() : null,
          },
        });
        return { provider: selected.provider ?? null, model: selected.id ?? null };
      },
    },
  };
}

/**
 * The deployment key is a bearer credential for exactly one vendor, so it is handed out
 * only when the provider that won the resolution above is that vendor. A provider named
 * by deployment settings or a bot override gets no key rather than another vendor's.
 */
function deploymentKeyFor(deps: ExecutorDeps, provider: string): string | undefined {
  if (!deps.deploymentModelKey) return undefined;
  return provider === resolveDeploymentModel().provider ? deps.deploymentModelKey : undefined;
}

/**
 * A run can afford a longer catalog wait than the models.list read bound — the
 * account answer decides whether a statically excluded model is allowed at all.
 * Still bounded well under the fetch's own abort timeout.
 */
const CODEX_LIVE_RUN_WAIT_MS = 8_000;

// Listed connections serve enabled ids and their space default; legacy connections serve any id.
function assertCompatibleModelEnabled(
  credential: { provider: string; defaultModel?: string | null },
  secret: StoredModelSecret,
  modelId: string,
) {
  if (credential.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) return;
  if (secret.kind !== "openai_compatible") return;
  if (secret.enabledModelIds !== undefined) {
    if (!enabledOpenAiCompatibleModelIds(secret, credential.defaultModel).includes(modelId)) {
      throw new UnavailableModelForAuthError("Unknown model for that provider");
    }
    return;
  }
}

export async function modelCreditBillingEnabled(
  deps: Pick<ExecutorDeps, "prisma" | "billingEnabled">,
): Promise<boolean> {
  if (deps.billingEnabled !== undefined) return deps.billingEnabled;
  return (
    (
      await deps.prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { modelCreditsEnabled: true },
      })
    )?.modelCreditsEnabled === true
  );
}

/**
 * A failure that belongs to one pooled key/account, not to the connection or
 * the deployment: the account is retired, its secret is gone or unreadable, or
 * the provider does not offer the model to it. Store outages and database
 * errors are not entry failures — rotating cannot fix them, so they surface.
 */
function isCredentialEntryFailure(error: unknown): boolean {
  if (error instanceof SecretStoreUnavailableError) return false;
  if (isRetiredModelCredentialError(error)) return true;
  if (error instanceof UnavailableModelForAuthError) return true;
  if (error instanceof SecretNotFoundError) return true;
  return (
    error instanceof Error &&
    (error.message === "Connect that model provider again." ||
      error.message === CORRUPT_MODEL_SECRET_MESSAGE)
  );
}

/**
 * Resolve a connection's key material through its credential pool. Runs try
 * the active entry first (the last one that worked), then the rest in pool
 * order, advancing only on failures that belong to the entry itself; an
 * explicitly named entry resolves alone, because the runtime drives pool
 * advancement at the model-call layer. Connections without pool rows (and any
 * pool read failure) keep the single-credential path exactly as before.
 */
async function resolvePooledModelKeyMaterial(
  args: Parameters<typeof resolveModelKeyMaterial>,
): Promise<Awaited<ReturnType<typeof resolveModelKeyMaterial>>> {
  const [deps, userId, , credential, , , , options] = args;
  if (!credential) return resolveModelKeyMaterial(...args);
  let entries: Awaited<ReturnType<typeof listModelCredentialKeys>>;
  try {
    entries = await listModelCredentialKeys(deps.prisma, {
      userId,
      credentialId: credential.id,
    });
  } catch {
    return resolveModelKeyMaterial(...args);
  }
  if (entries.length === 0) return resolveModelKeyMaterial(...args);
  const attempts = options?.keyId
    ? entries.filter((entry) => entry.id === options.keyId)
    : orderModelCredentialKeysForUse(entries, credential.secretId);
  if (attempts.length === 0) throw new Error("Backup model credential is no longer available");
  let lastError: unknown;
  for (const entry of attempts) {
    const attemptArgs = [...args] as Parameters<typeof resolveModelKeyMaterial>;
    attemptArgs[7] = { ...options, keyEntry: { id: entry.id, secretId: entry.secretId } };
    try {
      return await resolveModelKeyMaterial(...attemptArgs);
    } catch (error) {
      if (options?.keyId || !isCredentialEntryFailure(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export async function resolveModelKey(...args: Parameters<typeof resolveModelKeyMaterial>) {
  const [deps, userId, spaceId, , provider] = args;
  const billingEnabled = await modelCreditBillingEnabled(deps);
  const scope = { userId, spaceId };
  if (billingEnabled && (await hasHostedModelCredits(deps.prisma, scope, provider))) {
    args[3] = null;
    // Funded managed backups use deployment credentials just like the primary.
    args[7] = { ...args[7], requireStoredSecret: false };
  }
  const credential = args[3];
  const material = await resolvePooledModelKeyMaterial(args);
  const deployment = resolveDeploymentModel();
  // Local and compatible endpoints can intentionally be keyless. Host auth is
  // allowed only for the deployment provider that explicitly opted into it.
  const keyless =
    provider === LOCAL_PROVIDER_ID ||
    (provider === OPENAI_COMPATIBLE_PROVIDER_ID && Boolean(material.baseUrl)) ||
    (provider === "scripted" && deps.runtime?.describe().capabilities.scripted) ||
    (!credential && deployment.provider === provider && deployment.hostCredentials);
  // Match Pi's OpenRouter fallback only when no explicit key overrides it.
  const runtimeKey =
    material.apiKey === undefined && (provider === "openrouter" || provider === "scripted")
      ? process.env.OPENROUTER_API_KEY
      : undefined;
  if (!material.apiKey?.trim() && !runtimeKey?.trim() && !keyless) {
    throw new UnavailableModelForAuthError(MISSING_MODEL_RUN_ERROR);
  }
  const callObserver =
    !credential && billingEnabled ? await hostedModelCreditObserver(deps.prisma, scope) : undefined;
  return { ...material, apiKey: material.apiKey ?? runtimeKey, callObserver };
}

/**
 * A pooled entry's secret carries auth material only; the connection's limits
 * (output ceiling, cache capabilities, context window) come from the active
 * entry's secret so every key in the pool serves the connection as configured.
 */
function overlayConnectionLimits<T extends StoredModelSecret>(
  secret: T,
  active: StoredModelSecret,
): T {
  if (secret.kind === "oauth") {
    return {
      ...secret,
      ...(active.maxTokens !== undefined ? { maxTokens: active.maxTokens } : {}),
    };
  }
  if (secret.kind === "api_key" && active.kind !== "oauth") {
    return {
      ...secret,
      ...(active.maxTokens !== undefined ? { maxTokens: active.maxTokens } : {}),
      cacheCapabilities: active.cacheCapabilities,
      contextWindow: active.contextWindow,
    };
  }
  return secret;
}

async function resolveModelKeyMaterial(
  deps: ExecutorDeps,
  userId: string,
  spaceId: string,
  credential: {
    id: string;
    secretId: string;
    provider: string;
    defaultModel?: string | null;
    supportsImages?: boolean;
  } | null,
  provider: string,
  modelId: string,
  registerSecrets?: (values: string[]) => void,
  {
    requireStoredSecret = false,
    keyEntry,
  }: {
    requireStoredSecret?: boolean;
    /** Resolve exactly this pool entry; consumed by the pool loop above. */
    keyId?: string;
    keyEntry?: { id: string; secretId: string } | null;
  } = {},
): Promise<{
  /** The pool entry that served this resolution, when the connection pools keys. */
  keyId?: string;
  apiKey?: string;
  accountId?: string;
  gatewayId?: string;
  baseUrl?: string;
  apiProtocol?: AgentRunRequest["model"]["apiProtocol"];
  headers?: Record<string, string>;
  allowPrivateEndpoint?: boolean;
  cacheCapabilities?: AgentRunRequest["model"]["cacheCapabilities"];
  contextWindow?: number;
  reasoning?: boolean;
  maxTokens?: number;
  thinkingLevel?: AgentRunRequest["model"]["thinkingLevel"];
  acceptsImages?: boolean;
  maxImagesPerPrompt?: number;
  oauth?: AgentModelOAuthCredential;
  persistOAuth?: (credential: AgentModelOAuthCredential) => Promise<void>;
  refreshOAuth?: NonNullable<NonNullable<AgentRunRequest["model"]["oauth"]>["refresh"]>;
  retireOAuth?: (
    reason: ModelCredentialRetireReason,
    detail?: string,
    failed?: ModelCredentialFailedState,
  ) => Promise<boolean | undefined>;
  /** The key is the user's own stored connection, not the deployment's. */
  ownCredential?: true;
  redact: string[];
}> {
  if (credential) {
    // A pool entry resolves under its own secret: refresh, persist and retire
    // all stay scoped to that entry, while the connection keeps pointing at
    // the active one. Without an entry this is the connection's own secret.
    const secretId = keyEntry?.secretId ?? credential.secretId;
    const effectiveCredential = keyEntry
      ? { ...credential, secretId, keyId: keyEntry.id }
      : credential;
    return withModelCredentialLock(secretId, async () => {
      const row = await deps.prisma.secret.findFirst({
        where: { id: secretId, userId, spaceId: null },
      });
      if (!row) {
        if (keyEntry) throw new Error("Connect that model provider again.");
        if (await modelCreditBillingEnabled(deps))
          throw new Error("Connect that model provider again.");
        if (requireStoredSecret) throw new Error("Backup model credential is no longer available");
        if (credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
          throw new UnavailableModelForAuthError("Unknown model for that provider");
        }
        cloudflareProviderEnv({ provider });
        return { apiKey: deploymentKeyFor(deps, provider), redact: [] };
      }
      let plaintext = await deps.secretStore.load(row.ciphertext, row.id);
      registerSecrets?.(secretValuesToRedact(parseModelSecret(plaintext)));
      // Pool entries hold auth material only. The connection's settings —
      // endpoint config and limits — live on the active entry's secret, so a
      // non-active entry borrows them: a compatible entry's key merges into
      // the active secret's endpoint config, and limits overlay below. The
      // active secret is only read here, never written, so it needs no lock.
      let activeSecret: StoredModelSecret | undefined;
      if (keyEntry && keyEntry.secretId !== credential.secretId) {
        const activeRow = await deps.prisma.secret.findFirst({
          where: { id: credential.secretId, userId, spaceId: null },
        });
        if (activeRow) {
          try {
            const activePlaintext = await deps.secretStore.load(activeRow.ciphertext, activeRow.id);
            activeSecret = parseModelSecret(activePlaintext);
            registerSecrets?.(secretValuesToRedact(activeSecret));
          } catch {
            activeSecret = undefined;
          }
        }
        const entrySecret = parseModelSecret(plaintext);
        if (entrySecret.kind === "api_key" && activeSecret?.kind === "openai_compatible") {
          plaintext = serializeModelSecret({ ...activeSecret, apiKey: entrySecret.key });
        }
      }
      const persist = persistStoredModelSecret(
        deps.prisma,
        deps.secretStore,
        { userId, spaceId },
        row.id,
      );
      const retire = retireToReconnectMarker(
        deps.prisma,
        deps.secretStore,
        { userId, spaceId },
        effectiveCredential,
        activeSecret?.maxTokens ?? parseModelSecret(plaintext).maxTokens,
      );
      const resolveAuth = () =>
        resolveStoredModelAuth(
          deps.prisma,
          deps.secretStore,
          { userId, spaceId },
          effectiveCredential,
          plaintext,
          credential.provider,
        );
      let resolved: Awaited<ReturnType<typeof resolveAuth>> | undefined;
      let liveCodex: Awaited<ReturnType<typeof codexLiveModel>> | undefined;
      const authError = validateModelAuthAvailability(provider, modelId, plaintext);
      if (authError) {
        // A statically excluded Codex model may still run when the backend's
        // per-account catalog lists it for this credential. The catalog path
        // never refreshes or writes credentials, so resolve inside this lock
        // first — rotating a stale token the way any run would — then ask.
        if (deps.codexCatalog && parseModelSecret(plaintext).kind === "oauth") {
          resolved = await resolveAuth();
          liveCodex = await codexLiveModel(deps.codexCatalog, userId, resolved.secret, modelId, {
            waitMs: CODEX_LIVE_RUN_WAIT_MS,
          });
        }
        if (!liveCodex) throw new UnavailableModelForAuthError(authError);
      }
      resolved ??= await resolveAuth();
      if (
        !liveCodex &&
        deps.codexCatalog &&
        provider === CHATGPT_OAUTH_PROVIDER &&
        resolved.secret.kind === "oauth"
      ) {
        liveCodex = await codexLiveModel(deps.codexCatalog, userId, resolved.secret, modelId, {
          waitMs: CODEX_LIVE_RUN_WAIT_MS,
        });
      }
      if (activeSecret && resolved.secret.kind !== "openai_compatible") {
        resolved = {
          ...resolved,
          secret: overlayConnectionLimits(resolved.secret, activeSecret),
        };
      }
      assertCompatibleModelEnabled(credential, resolved.secret, modelId);
      const oauth = resolved.secret.kind === "oauth" ? resolved.secret.credential : undefined;
      const baseUrl =
        resolved.secret.kind === "openai_compatible" ? resolved.secret.baseUrl : undefined;
      // Recheck operator configuration for saved private connections on every run.
      const allowPrivateEndpoint = baseUrl ? deps.mcpAllowPrivateEndpoint === true : undefined;
      if (baseUrl) {
        try {
          // The public gate stays with the request-time fetch guard.
          assertAllowedOpenAiCompatibleUrl(baseUrl, {
            allowPublic: true,
            allowPrivate: allowPrivateEndpoint,
          });
        } catch (error) {
          throw new UnavailableModelForAuthError((error as Error).message);
        }
      }
      const acceptsImages =
        credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID &&
        resolved.secret.kind === "openai_compatible"
          ? compatibleModelSeesImages(credential, resolved.secret, modelId)
          : liveCodex?.supportsImages;
      const accountId = resolved.secret.kind === "api_key" ? resolved.secret.accountId : undefined;
      const gatewayId = resolved.secret.kind === "api_key" ? resolved.secret.gatewayId : undefined;
      cloudflareProviderEnv({ provider, accountId, gatewayId });
      return {
        apiKey: resolved.apiKey,
        accountId,
        gatewayId,
        baseUrl,
        apiProtocol:
          resolved.secret.kind === "openai_compatible" ? resolved.secret.apiProtocol : undefined,
        headers: resolved.secret.kind === "openai_compatible" ? resolved.secret.headers : undefined,
        allowPrivateEndpoint,
        cacheCapabilities:
          resolved.secret.kind !== "oauth" ? resolved.secret.cacheCapabilities : undefined,
        contextWindow: resolved.secret.kind !== "oauth" ? resolved.secret.contextWindow : undefined,
        reasoning:
          resolved.secret.kind === "openai_compatible" ? resolved.secret.reasoning : undefined,
        maxTokens: resolved.secret.maxTokens,
        thinkingLevel:
          resolved.secret.kind === "openai_compatible" ? resolved.secret.thinkingLevel : undefined,
        acceptsImages,
        maxImagesPerPrompt:
          resolved.secret.kind === "openai_compatible"
            ? resolved.secret.maxImagesPerPrompt
            : undefined,
        oauth,
        persistOAuth: oauth
          ? async (next) => {
              await withModelCredentialLock(secretId, async () => {
                const currentRow = await deps.prisma.secret.findFirst({
                  where: { id: secretId, userId, spaceId: null },
                });
                if (!currentRow) return;
                const current = parseModelSecret(
                  await deps.secretStore.load(currentRow.ciphertext, currentRow.id),
                );
                if (current.kind === "oauth" && !current.reconnectRequired) {
                  const stored = current.credential;
                  if (stored.expires > next.expires) return;
                  if (
                    stored.access === next.access &&
                    stored.refresh === next.refresh &&
                    stored.expires === next.expires
                  ) {
                    return;
                  }
                }
                await persist(
                  serializeModelSecret({
                    kind: "oauth",
                    credential: toOAuthCredential(next),
                    ...(current.maxTokens !== undefined ? { maxTokens: current.maxTokens } : {}),
                  }),
                );
              });
            }
          : undefined,
        refreshOAuth: oauth
          ? refreshStoredModelCredential(
              deps.prisma,
              deps.secretStore,
              { userId, spaceId },
              effectiveCredential,
              credential.provider,
            )
          : undefined,
        retireOAuth: retire,
        ownCredential: true,
        ...(keyEntry ? { keyId: keyEntry.id } : {}),
        redact: [...secretValuesToRedact(resolved.secret), resolved.apiKey].filter(
          (value): value is string => Boolean(value),
        ),
      };
    });
  }
  if (requireStoredSecret) throw new Error("Backup model credential is no longer available");
  cloudflareProviderEnv({ provider });
  return { apiKey: deploymentKeyFor(deps, provider), redact: [] };
}

/** Translate resolved credentials and capabilities consistently for every run path. */
export function resolvedModelRunFields(
  resolved: Awaited<ReturnType<typeof resolveModelKey>>,
): Omit<AgentRunRequest["model"], "provider" | "id" | "connectionId" | "thinkingLevel"> {
  return {
    apiKey: resolved.oauth ? undefined : resolved.apiKey,
    ...(resolved.keyId ? { keyId: resolved.keyId } : {}),
    callObserver: resolved.callObserver,
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
    ...(resolved.gatewayId ? { gatewayId: resolved.gatewayId } : {}),
    baseUrl: resolved.baseUrl,
    apiProtocol: resolved.apiProtocol,
    headers: resolved.headers,
    allowPrivateEndpoint: resolved.allowPrivateEndpoint,
    cacheCapabilities: resolved.cacheCapabilities,
    contextWindow: resolved.contextWindow,
    reasoning: resolved.reasoning,
    maxTokens: resolved.maxTokens,
    acceptsImages: resolved.acceptsImages,
    maxImagesPerPrompt: resolved.maxImagesPerPrompt,
    oauth: resolved.oauth
      ? {
          credential: resolved.oauth,
          persist: resolved.persistOAuth,
          refresh: resolved.refreshOAuth,
          retire: resolved.retireOAuth,
        }
      : undefined,
  };
}

/**
 * A role row's model on its own connection, or on the deployment's for its funded provider.
 * The connection is returned with the key so a run can record which one served it.
 */
export async function resolveConnectedModelKey(
  deps: ExecutorDeps,
  scope: { userId: string; spaceId: string },
  provider: string,
  modelId: string,
  registerSecrets?: (values: string[]) => void,
  requireStoredSecret = false,
  credentialId?: string,
  /** Resolve one pooled key/account of the connection instead of the active one. */
  keyId?: string,
) {
  const hostedProvider = (await modelCreditBillingEnabled(deps))
    ? resolveDeploymentModel().provider
    : undefined;
  const validationError = await validateConnectedModelChoice(
    deps.prisma,
    deps.secretStore,
    scope,
    provider,
    modelId,
    { hostedProvider, credentialId, codexCatalog: deps.codexCatalog },
  );
  if (validationError) throw new Error(validationError);
  const credential = await findConnectedModelCredential(
    deps.prisma,
    deps.secretStore,
    scope,
    provider,
    modelId,
    { credentialId },
  );
  if (!credential && provider !== hostedProvider) throw new Error(PINNED_PROVIDER_NOT_CONNECTED);
  const resolved = await resolveModelKey(
    deps,
    scope.userId,
    scope.spaceId,
    credential,
    provider,
    modelId,
    registerSecrets,
    { requireStoredSecret, ...(keyId ? { keyId } : {}) },
  );
  return { credential, resolved };
}

export async function resolveConnectedRunModel(
  deps: ExecutorDeps,
  scope: { userId: string; spaceId: string },
  provider: string,
  modelId: string,
  registerSecrets?: (values: string[]) => void,
  requireStoredSecret = false,
  /** A fallback's own effort from its role list. */
  thinkingLevel?: string | null,
  /** The connection a role row is pinned to. */
  credentialId?: string,
  /** The pooled key/account of that connection to serve this resolution. */
  keyId?: string,
): Promise<AgentRunRequest["model"]> {
  const { credential, resolved } = await resolveConnectedModelKey(
    deps,
    scope,
    provider,
    modelId,
    registerSecrets,
    requireStoredSecret,
    credentialId,
    keyId,
  );
  return {
    provider,
    id: modelId,
    ...(credentialId ? { connectionId: credentialId } : {}),
    ...resolvedModelRunFields(resolved),
    thinkingLevel:
      ((thinkingLevel !== undefined
        ? thinkingLevel
        : credential?.defaultModel === modelId
          ? credential?.thinkingLevel
          : null) as AgentRunRequest["model"]["thinkingLevel"]) ??
      resolved.thinkingLevel ??
      null,
  };
}

export async function resolveRunModel(
  deps: ExecutorDeps,
  scope: {
    userId: string;
    spaceId: string;
    botId?: string;
  },
): Promise<AgentRunRequest["model"]> {
  // The bot's model is shared config; the credential that runs it stays the run user's.
  const override = scope.botId
    ? await deps.prisma.bot.findFirst({
        where: { id: scope.botId, spaceId: scope.spaceId },
        select: { modelProvider: true, modelId: true, thinkingLevel: true },
      })
    : null;
  const hasOverride = Boolean(override?.modelProvider && override.modelId);
  const [overrideCredential, main, settings] = await Promise.all([
    hasOverride
      ? findConnectedModelCredential(
          deps.prisma,
          deps.secretStore,
          scope,
          override!.modelProvider!,
          override!.modelId,
        )
      : Promise.resolve(null),
    resolveMemberMainModel(deps, scope),
    deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
    }),
  ]);
  const selected = selectConfiguredModel({
    override,
    overrideCredential,
    main,
    hostedProvider: (await modelCreditBillingEnabled(deps))
      ? resolveDeploymentModel().provider
      : undefined,
    defaults: {
      settings,
      deployment: deps.deploymentModelConfigured ? resolveDeploymentModel() : null,
    },
  });
  const { credential, thinkingLevel } = selected;
  let { provider, id } = selected;
  if (!provider || !id) {
    const runtimeFallback = runtimeFallbackModel(deps.runtime);
    provider ??= runtimeFallback?.provider;
    id ??= runtimeFallback?.id ?? null;
  }
  if (!provider || !id) throw new Error(MISSING_MODEL_RUN_ERROR);
  // The key is resolved for the provider that won above, not before it is known.
  const resolved = await resolveModelKey(
    deps,
    scope.userId,
    scope.spaceId,
    credential,
    provider,
    id,
  );
  return {
    provider,
    id,
    ...resolvedModelRunFields(resolved),
    thinkingLevel: thinkingLevel ?? resolved.thinkingLevel ?? null,
  };
}
