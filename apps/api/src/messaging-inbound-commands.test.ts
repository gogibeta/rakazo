import type { MessagingInboundAction, MessagingInboundMessage } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { MessagingInboundDeps } from "./messaging-inbound.js";
import { answerMessagingPickerAction, createMessagingInboundHandler } from "./messaging-inbound.js";

/**
 * Slash commands (/bot, /new, /queue, /steer, /model, /help) against a
 * fake store: the command effects are the observable writes — identity
 * updates, cleared threads, steering rows, outbound replies — and the
 * model seam is a stub over the app's picker path.
 */

const bots = [
  {
    id: "bot-1",
    name: "Chief",
    userId: "user-1",
    spaceId: "ws-1",
    modelProvider: null as string | null,
    modelId: null as string | null,
    thinkingLevel: null as string | null,
  },
  {
    id: "bot-2",
    name: "Research",
    userId: "user-1",
    spaceId: "ws-1",
    modelProvider: "anthropic",
    modelId: "claude-sonnet-5",
    thinkingLevel: null as string | null,
  },
];

const modelChoices = [
  { provider: "anthropic", id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { provider: "openai", id: "gpt-5.2", label: "GPT-5.2" },
];

function createDeps(
  overrides: {
    identity?: Record<string, unknown> | null;
    activeRun?: boolean;
    identityUpdateError?: Error;
    createTopic?: MessagingInboundDeps["createTopic"] | null;
    withModels?: boolean;
  } = {},
) {
  const identity =
    overrides.identity === null
      ? null
      : {
          id: "mi-1",
          provider: "telegram",
          address: "4242",
          dmThreadId: "telegram:4242",
          userId: "user-1",
          spaceId: "ws-1",
          botId: "bot-1",
          installationId: null,
          outboundSinceInbound: 0,
          lastInboundAt: null,
          ...(overrides.identity ?? {}),
        };
  const outboundRows: Array<Record<string, unknown>> = [];
  const steeringRows: Array<Record<string, unknown>> = [];
  const threadMessages: Array<Record<string, unknown>> = [];
  const channelUpserts: Array<Record<string, unknown>> = [];
  const activeRuns = overrides.activeRun
    ? [
        {
          id: "run-1",
          status: "running",
          trigger: "messaging",
          userId: "user-1",
          startedAt: new Date(),
          firstResponseAt: null,
          leaseOwner: null,
          leaseFence: 1,
          sourceMessage: { blocks: [{ kind: "text", text: "hi" }] },
        },
      ]
    : [];

  const messagingOutbound = {
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      let count = 0;
      for (const item of data) {
        if (outboundRows.some((row) => row.idempotencyKey === item.idempotencyKey)) continue;
        outboundRows.push({ createdAt: new Date(), ...item });
        count += 1;
      }
      return { count };
    }),
    deleteMany: vi.fn(async ({ where }: { where: { idempotencyKey?: string } }) => {
      let count = 0;
      for (let i = outboundRows.length - 1; i >= 0; i -= 1) {
        if (outboundRows[i]!.idempotencyKey === where.idempotencyKey) {
          outboundRows.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    }),
    aggregate: vi.fn(async () => ({ _max: { createdAt: null } })),
    findFirst: vi.fn(async () => null),
  };
  const messagingIdentity = {
    findUnique: vi.fn(
      async ({
        where,
      }: {
        where: {
          provider_address?: { provider: string; address: string };
          id?: string;
          botId?: string;
        };
      }) => {
        if (!identity) return null;
        if (where.provider_address && where.provider_address.address !== identity.address)
          return null;
        if (where.id && where.id !== identity.id) return null;
        if (where.botId && where.botId !== identity.botId) return null;
        return identity;
      },
    ),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (overrides.identityUpdateError) throw overrides.identityUpdateError;
      if (identity) Object.assign(identity, data);
      return identity;
    }),
  };
  const bot = {
    findMany: vi.fn(async () => bots),
    findFirst: vi.fn(
      async ({ where }: { where: { id?: string } }) =>
        bots.find((candidate) => candidate.id === where.id) ?? null,
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        bots.find((candidate) => candidate.id === where.id) ?? null,
    ),
  };
  const channel = {
    id: "ch-1",
    provider: "telegram",
    threadId: "telegram:-100999",
    name: "Study group",
    introPostedAt: new Date(),
    rosterSeenAt: null,
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ bypass: "off", key: "", login: "test" }]),
    $executeRaw: vi.fn(async () => 0),
    space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
    run: {
      findMany: vi.fn(async () => activeRuns),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          activeRuns.find((run) => run.id === where.id) ?? null,
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    thread: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (data.nextMessageSeq) return { nextMessageSeq: 2, spaceId: "ws-1" };
        return { nextEventSeq: 10 };
      }),
    },
    message: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `tm-${threadMessages.length + 1}`, seq: 1, ...data };
        threadMessages.push(row);
        return row;
      }),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => null),
    },
    user: {
      findMany: vi.fn(async () => [{ id: "user-1", name: "Alice Owner" }]),
      findUnique: vi.fn(async () => ({ id: "user-1", name: "Alice Owner", deactivatedAt: null })),
    },
    steeringMessage: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        steeringRows.push(data);
        return data;
      }),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        seq: 9,
        ...data,
      })),
    },
    messagingOutbound,
    messagingIdentity,
    bot,
    messagingChannel: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        channelUpserts.push(args);
        return channel;
      }),
      findMany: vi.fn(async () => [{ id: channel.id }]),
      findUnique: vi.fn(async () => channel),
      findUniqueOrThrow: vi.fn(async () => channel),
      update: vi.fn(async () => channel),
    },
    messagingChannelMember: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { channelId_address: { channelId: string; address: string } };
        }) =>
          identity && where.channelId_address.address === identity.address
            ? {
                id: "member-1",
                channelId: "ch-1",
                address: identity.address,
                identityId: identity.id,
                status: "approved",
              }
            : null,
      ),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      upsert: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    messagingLinkCode: {
      findUnique: vi.fn(async () => null),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    agentConnection: {
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
  };
  const prisma = {
    messagingIdentity,
    bot,
    messagingOutbound,
    messagingLinkCode: tx.messagingLinkCode,
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        name: "Alice Owner",
        deactivatedAt: null,
      })),
    },
    thread: { findFirst: vi.fn(async () => ({ id: "thread-1" })) },
    message: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    run: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
    routine: { findMany: vi.fn(async () => []) },
    messagingChannel: tx.messagingChannel,
    messagingChannelMember: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { channelId_address: { channelId: string; address: string } };
        }) =>
          identity && where.channelId_address.address === identity.address
            ? {
                id: "member-1",
                channelId: "ch-1",
                address: identity.address,
                identityId: identity.id,
                status: "approved",
              }
            : null,
      ),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    $transaction: vi.fn(async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx)),
  };

  const sendUserMessage = vi.fn(async () => ({
    messageId: "msg-1",
    runId: "run-new",
    seq: 4,
  }));
  const clearThread = vi.fn(async () => ({
    event: { seq: 8 },
    cancelledRunIds: ["run-old"],
    historyCompactionGeneration: 3,
  }));
  const enqueue = vi.fn(async () => undefined);
  const apply = vi.fn(async () => ({ ok: true as const }));
  const afterThreadClear = vi.fn(async () => undefined);
  const createTopic =
    overrides.createTopic === null
      ? undefined
      : (overrides.createTopic ?? vi.fn(async () => "telegram:-100999:77"));
  const deps = {
    prisma,
    events: {
      sendUserMessage,
      notify: vi.fn(async () => undefined),
      answerRunInput: vi.fn(async () => true),
      clearThread,
    },
    jobs: { enqueue },
    sandbox: {},
    provision: vi.fn(async (request: { provider: string; address: string }) => ({
      provider: request.provider,
      address: request.address,
      userId: "user-new",
      spaceId: "ws-new",
      botId: "bot-new",
      threadId: "thread-new",
      created: true,
    })),
    openSignup: false,
    signupPolicy: { signupsEnabled: undefined, signupAllowlist: undefined },
    ...(overrides.withModels === false
      ? {}
      : {
          models: {
            choices: vi.fn(async () => modelChoices),
            resolve: vi.fn(
              async (_scope: unknown, query: string) =>
                modelChoices
                  .filter((choice) => choice.id === query || choice.label === query)
                  .map((choice) => ({
                    provider: choice.provider,
                    model: choice.id,
                  }))[0] ?? null,
            ),
            apply,
          },
        }),
    ...(createTopic ? { createTopic } : {}),
    afterThreadClear,
  } as unknown as MessagingInboundDeps & {
    sendUserMessage: typeof sendUserMessage;
    clearThread: typeof clearThread;
    enqueue: typeof enqueue;
    apply: typeof apply;
    afterThreadClear: typeof afterThreadClear;
    outboundRows: typeof outboundRows;
    steeringRows: typeof steeringRows;
    threadMessages: typeof threadMessages;
    channelUpserts: typeof channelUpserts;
    identityUpdates: typeof messagingIdentity.update;
    createTopic: typeof createTopic;
  };
  Object.assign(deps, {
    sendUserMessage,
    clearThread,
    enqueue,
    apply,
    afterThreadClear,
    outboundRows,
    steeringRows,
    threadMessages,
    channelUpserts,
    identityUpdates: messagingIdentity.update,
    createTopic,
  });
  return deps;
}

const dm = (content: string, handle = "h-1"): MessagingInboundMessage => ({
  type: "message",
  provider: "telegram",
  handle,
  threadId: "telegram:4242",
  isDirect: true,
  from: "4242",
  fromLabel: "Alice",
  channelName: null,
  participants: [],
  content,
  mediaUrl: null,
});

const group = (content: string, handle = "h-g1"): MessagingInboundMessage => ({
  type: "message",
  provider: "telegram",
  handle,
  threadId: "telegram:-100999",
  isDirect: false,
  from: "4242",
  fromLabel: "Alice",
  channelName: "Study group",
  participants: [],
  content,
  mediaUrl: null,
});

const tap = (actionId: string, value: string, from = "4242"): MessagingInboundAction => ({
  type: "action",
  provider: "telegram",
  handle: `tap-${actionId}-${value}`,
  threadId: "telegram:4242",
  isDirect: true,
  from,
  fromLabel: "Alice",
  actionId,
  value,
  messageId: "picker-msg-1",
});

describe("messaging slash commands in a DM", () => {
  it("/help answers with the command list and never reaches the bot", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(dm("/help"));
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        idempotencyKey: "command:help:h-1",
        kind: "dm",
        identityId: "mi-1",
        body: expect.stringContaining("/bot"),
      }),
    ]);
  });

  it("ordinary text flows through untouched", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(dm("hello there"));
    expect(deps.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ threadId: "thread-1", trigger: "messaging" }),
    );
    expect(deps.outboundRows).toEqual([]);
  });

  it("a slash word mid-message is a normal message", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(dm("what does /model do?"));
    expect(deps.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(deps.outboundRows).toEqual([]);
  });

  it("/bot offers a picker row the drain turns into buttons", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(dm("/bot"));
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        idempotencyKey: "picker:bot:mi-1:h-1",
        kind: "dm",
        body: expect.stringContaining("Which bot should this chat talk to?"),
      }),
    ]);
    expect(deps.identityUpdates).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "bot-2" }),
      }),
    );
  });

  it("/bot <name> switches the identity through the settings write and confirms", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(dm("/bot Research"));
    expect(deps.identityUpdates).toHaveBeenCalledWith({
      where: { id: "mi-1" },
      data: { botId: "bot-2", spaceId: "ws-1" },
    });
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({ body: "This chat now talks to Research." }),
    ]);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("/bot with an unknown name answers without switching", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(dm("/bot Nobody"));
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        body: expect.stringContaining('No bot named "Nobody"'),
      }),
    ]);
  });

  it("/bot reports a bot already linked to another chat app", async () => {
    const deps = createDeps({
      identityUpdateError: Object.assign(new Error("unique"), {
        code: "P2002",
      }),
    });
    await createMessagingInboundHandler(deps)(dm("/bot Research"));
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        body: "That bot is already linked to a chat app.",
      }),
    ]);
  });

  it("a bot picker tap switches the tapper's identity and receipts", async () => {
    const deps = createDeps();
    const handled = await answerMessagingPickerAction(deps, tap("bot", "bot-2"));
    expect(handled).toBe(true);
    expect(deps.identityUpdates).toHaveBeenCalledWith({
      where: { id: "mi-1" },
      data: { botId: "bot-2", spaceId: "ws-1" },
    });
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({ body: "This chat now talks to Research." }),
    ]);
  });

  it("a picker tap from an unlinked address is claimed but does nothing", async () => {
    const deps = createDeps({ identity: null });
    const handled = await answerMessagingPickerAction(deps, tap("bot", "bot-2", "9999"));
    expect(handled).toBe(true);
    expect(deps.outboundRows).toEqual([]);
  });

  it("an ask tap is not a picker tap", async () => {
    const deps = createDeps();
    const handled = await answerMessagingPickerAction(deps, tap("ask", "m-1:0"));
    expect(handled).toBe(false);
  });

  it("/new clears the conversation through the app's clear path and follows through", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(dm("/new"));
    expect(deps.clearThread).toHaveBeenCalledExactlyOnceWith({
      spaceId: "ws-1",
      threadId: "thread-1",
      botId: "bot-1",
    });
    expect(deps.afterThreadClear).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cancelledRunIds: ["run-old"],
        historyCompactionGeneration: 3,
      }),
    );
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        body: "Started a fresh conversation with Chief.",
      }),
    ]);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("/steer writes an addressed steering row for the run holding the thread", async () => {
    const deps = createDeps({ activeRun: true });
    await createMessagingInboundHandler(deps)(dm("/steer focus on the failing test"));
    expect(deps.steeringRows).toEqual([
      expect.objectContaining({
        botId: "bot-1",
        userId: "user-1",
        runId: "run-1",
        originTrigger: "messaging",
      }),
    ]);
    expect(deps.threadMessages).toEqual([
      expect.objectContaining({
        blocks: [{ kind: "text", text: "focus on the failing test" }],
      }),
    ]);
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        body: expect.stringContaining("Steering noted"),
      }),
    ]);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("/queue writes a pending steering row the follow-up run will claim", async () => {
    const deps = createDeps({ activeRun: true });
    await createMessagingInboundHandler(deps)(dm("/queue then write the summary"));
    expect(deps.steeringRows).toEqual([
      expect.objectContaining({ runId: null, originTrigger: "messaging" }),
    ]);
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({ body: expect.stringContaining("Queued") }),
    ]);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("/queue with nothing running sends the text as a normal message", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(dm("/queue write the summary"));
    expect(deps.steeringRows).toEqual([]);
    expect(deps.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        threadId: "thread-1",
        blocks: [{ kind: "text", text: "write the summary" }],
        trigger: "messaging",
      }),
    );
  });

  it("/queue without text answers with usage", async () => {
    const deps = createDeps({ activeRun: true });
    await createMessagingInboundHandler(deps)(dm("/queue"));
    expect(deps.steeringRows).toEqual([]);
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        body: expect.stringContaining("/queue <message>"),
      }),
    ]);
  });

  it("/model offers a picker row of the connected models", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(dm("/model"));
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        idempotencyKey: "picker:model:mi-1:h-1",
        body: expect.stringContaining("currently uses the deployment default"),
      }),
    ]);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("/model <id> applies through the model seam and confirms with the label", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(dm("/model gpt-5.2"));
    expect(deps.apply).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", spaceId: "ws-1" },
      expect.objectContaining({ id: "bot-1" }),
      { provider: "openai", model: "gpt-5.2" },
    );
    expect(deps.outboundRows).toEqual([expect.objectContaining({ body: "Model set to GPT-5.2." })]);
  });

  it("/model with an unknown id answers without applying", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(dm("/model nope-9000"));
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        body: expect.stringContaining("couldn't find a connected model"),
      }),
    ]);
  });

  it("a model picker tap applies the tapped position from the fresh list", async () => {
    const deps = createDeps();
    const handled = await answerMessagingPickerAction(deps, tap("model", "1"));
    expect(handled).toBe(true);
    expect(deps.apply).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", spaceId: "ws-1" },
      expect.objectContaining({ id: "bot-1" }),
      { provider: "openai", model: "gpt-5.2" },
    );
    expect(deps.outboundRows).toEqual([expect.objectContaining({ body: "Model set to GPT-5.2." })]);
  });

  it("an unlinked sender's /bot is not a command: the line stays silent", async () => {
    const deps = createDeps({ identity: null });
    await createMessagingInboundHandler(deps)(dm("/bot"));
    expect(deps.outboundRows).toEqual([]);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("messaging slash commands in a linked group", () => {
  it("/bot lists the bots as text and is not fanned out", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(group("/bot"));
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        kind: "group",
        threadId: "telegram:-100999",
        body: expect.stringContaining("Chief, Research"),
      }),
    ]);
  });

  it("/bot <name> in a group switches the sender's own identity", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(group("/bot Research"));
    expect(deps.identityUpdates).toHaveBeenCalledWith({
      where: { id: "mi-1" },
      data: { botId: "bot-2", spaceId: "ws-1" },
    });
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        kind: "group",
        body: "This chat now talks to Research.",
      }),
    ]);
  });

  it("/new in a forum group creates a topic, binds its channel row and posts into it", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(group("/new"));
    expect(deps.createTopic).toHaveBeenCalledExactlyOnceWith(
      "telegram",
      "telegram:-100999",
      "New chat · Chief",
    );
    expect(deps.channelUpserts).toContainEqual(
      expect.objectContaining({
        where: { threadId: "telegram:-100999:77" },
        create: expect.objectContaining({ threadId: "telegram:-100999:77" }),
      }),
    );
    expect(deps.outboundRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "group",
          threadId: "telegram:-100999:77",
          body: expect.stringContaining("Fresh conversation started here"),
        }),
        expect.objectContaining({
          kind: "group",
          threadId: "telegram:-100999",
          body: expect.stringContaining("new topic"),
        }),
      ]),
    );
    expect(deps.clearThread).not.toHaveBeenCalled();
  });

  it("/new without topic support says so in the group", async () => {
    const deps = createDeps({ createTopic: null });
    await createMessagingInboundHandler(deps)(group("/new"));
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        kind: "group",
        body: expect.stringContaining("Separate threads aren't available"),
      }),
    ]);
    expect(deps.clearThread).not.toHaveBeenCalled();
  });

  it("/help works in a group too", async () => {
    const deps = createDeps();
    await createMessagingInboundHandler(deps)(group("/help"));
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        kind: "group",
        body: expect.stringContaining("/steer"),
      }),
    ]);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });
});
