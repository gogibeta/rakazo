import type { HostRestarter } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeploymentHostDeps } from "./deployment-host.js";
import { getDeploymentHostStatus, restartDeploymentHost } from "./deployment-host.js";

const adminActor = { userId: "admin-1", spaceId: "space-1", email: "admin@example.com" } as never;
const memberActor = { userId: "user-2", spaceId: "space-1", email: "member@example.com" } as never;

function makeDeps(options: { restarter?: HostRestarter } = {}): DeploymentHostDeps {
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "admin-1"
          ? { email: "admin@example.com", emailVerified: true }
          : { email: "member@example.com", emailVerified: true },
      ),
    },
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    env: { adminEmails: ["admin@example.com"] },
    hostRestarter: options.restarter,
  };
}

describe("deployment host restart", () => {
  it("reports disabled when the deployment is not pointed at its own host", async () => {
    const deps = makeDeps();
    await expect(getDeploymentHostStatus(deps, adminActor)).resolves.toEqual({
      restartConfigured: false,
    });
    await expect(restartDeploymentHost(deps, adminActor)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("restarts through the configured restarter and reports configured", async () => {
    const restarter: HostRestarter = { restart: vi.fn(async () => undefined) };
    const deps = makeDeps({ restarter });
    await expect(getDeploymentHostStatus(deps, adminActor)).resolves.toEqual({
      restartConfigured: true,
    });
    await expect(restartDeploymentHost(deps, adminActor)).resolves.toEqual({ initiated: true });
    expect(restarter.restart).toHaveBeenCalledTimes(1);
  });

  it("is forbidden to non-admins, who never reach the restarter", async () => {
    const restarter: HostRestarter = { restart: vi.fn(async () => undefined) };
    const deps = makeDeps({ restarter });
    await expect(getDeploymentHostStatus(deps, memberActor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(restartDeploymentHost(deps, memberActor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(restarter.restart).not.toHaveBeenCalled();
  });

  it("builds a restarter from the environment config when both values are set", async () => {
    const deps = makeDeps();
    deps.env.instaboxApiKey = "key-123";
    deps.env.instaboxMachineId = "m_abc";
    await expect(getDeploymentHostStatus(deps, adminActor)).resolves.toEqual({
      restartConfigured: true,
    });
    deps.env.instaboxMachineId = undefined;
    await expect(getDeploymentHostStatus(deps, adminActor)).resolves.toEqual({
      restartConfigured: false,
    });
  });

  it("builds a restarter from the remote config when both of its values are set", async () => {
    const deps = makeDeps();
    deps.env.hostRestartUrl = "https://restarter.example.com/restart";
    deps.env.hostRestartSecret = "test-secret";
    await expect(getDeploymentHostStatus(deps, adminActor)).resolves.toEqual({
      restartConfigured: true,
    });
    deps.env.hostRestartSecret = undefined;
    await expect(getDeploymentHostStatus(deps, adminActor)).resolves.toEqual({
      restartConfigured: false,
    });
  });

  describe("with a stubbed global fetch", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("prefers the remote restarter when both configurations exist", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url, init });
          return { ok: true, status: 202, text: async () => "" } as unknown as Response;
        }),
      );
      const deps = makeDeps();
      deps.env.hostRestartUrl = "https://restarter.example.com/restart";
      deps.env.hostRestartSecret = "test-secret";
      deps.env.instaboxApiKey = "key-123";
      deps.env.instaboxMachineId = "m_abc";
      await expect(restartDeploymentHost(deps, adminActor)).resolves.toEqual({ initiated: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://restarter.example.com/restart");
      const headers = calls[0]!.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer test-secret");
    });

    it("falls back to the direct restarter when only its pair exists", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url, init });
          return { ok: true, status: 202, text: async () => "" } as unknown as Response;
        }),
      );
      const deps = makeDeps();
      deps.env.instaboxApiKey = "key-123";
      deps.env.instaboxMachineId = "m_abc";
      await expect(restartDeploymentHost(deps, adminActor)).resolves.toEqual({ initiated: true });
      expect(calls).toHaveLength(2);
      expect(calls[0]!.url).toBe("https://api.instabox.sh/v1/machines/m_abc/stop");
      expect(calls[1]!.url).toBe("https://api.instabox.sh/v1/machines/m_abc/start");
    });
  });
});
