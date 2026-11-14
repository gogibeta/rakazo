import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  archiveSession,
  createSession,
  getPrimaryThread,
  resolveMessagingSession,
  unarchiveSession,
} from "./thread-sessions.js";

describe("getPrimaryThread", () => {
  it("looks up the bot's primary session, not an arbitrary thread", async () => {
    const findFirst = vi.fn(async () => ({ id: "thread-1" }));
    const prisma = { thread: { findFirst } } as unknown as Pick<PrismaClient, "thread">;

    await expect(getPrimaryThread(prisma, "bot-1")).resolves.toEqual({ id: "thread-1" });
    expect(findFirst).toHaveBeenCalledWith({ where: { botId: "bot-1", isPrimary: true } });
  });
});

describe("createSession", () => {
  it("inserts a non-primary session by default", async () => {
    const create = vi.fn(async () => ({ id: "thread-2" }));
    const prisma = { thread: { create } } as unknown as Pick<PrismaClient, "thread">;

    await createSession(prisma, {
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      kind: "direct",
      origin: "telegram",
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        groupId: undefined,
        kind: "direct",
        origin: "telegram",
        title: undefined,
        parentThreadId: undefined,
        isPrimary: false,
      },
    });
  });

  it("marks the session primary only when asked (bot creation)", async () => {
    const create = vi.fn(async () => ({ id: "thread-3" }));
    const prisma = { thread: { create } } as unknown as Pick<PrismaClient, "thread">;

    await createSession(prisma, {
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      kind: "direct",
      origin: "web",
      primary: true,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isPrimary: true }) }),
    );
  });
});

describe("resolveMessagingSession", () => {
  const identity = { id: "identity-1", botId: "bot-1", activeThreadId: "thread-active" };

  it("returns the active session while it is a live session of the bot", async () => {
    const findFirst = vi.fn(async () => ({ id: "thread-active" }));
    const update = vi.fn();
    const prisma = {
      thread: { findFirst },
      messagingIdentity: { update },
    } as unknown as Pick<PrismaClient, "thread" | "messagingIdentity">;

    await expect(resolveMessagingSession(prisma, identity)).resolves.toEqual({
      id: "thread-active",
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "thread-active", botId: "bot-1", archivedAt: null },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("falls back to the primary session and repairs the pointer", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "thread-primary" });
    const update = vi.fn(async () => ({}));
    const prisma = {
      thread: { findFirst },
      messagingIdentity: { update },
    } as unknown as Pick<PrismaClient, "thread" | "messagingIdentity">;

    await expect(resolveMessagingSession(prisma, identity)).resolves.toEqual({
      id: "thread-primary",
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "identity-1" },
      data: { activeThreadId: "thread-primary" },
    });
  });

  it("returns null when the bot has no primary session", async () => {
    const findFirst = vi.fn(async () => null);
    const update = vi.fn();
    const prisma = {
      thread: { findFirst },
      messagingIdentity: { update },
    } as unknown as Pick<PrismaClient, "thread" | "messagingIdentity">;

    await expect(
      resolveMessagingSession(prisma, { ...identity, activeThreadId: null }),
    ).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("archiveSession / unarchiveSession", () => {
  it("flips the archive flag and returns the row", async () => {
    const update = vi.fn(async () => ({ id: "thread-1", spaceId: "space-1" }));
    const prisma = { thread: { update } } as unknown as Pick<PrismaClient, "thread">;

    await archiveSession(prisma, { threadId: "thread-1", actorUserId: "user-1" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: { archivedAt: expect.any(Date) },
    });

    update.mockClear();
    await unarchiveSession(prisma, { threadId: "thread-1", actorUserId: "user-1" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: { archivedAt: null },
    });
  });
});
