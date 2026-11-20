import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { TERMINAL_PATH } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createTerminalServer } from "./terminal.js";

const servers: Array<ReturnType<typeof createServer>> = [];

async function serve(
  sessionUserId: string | undefined,
  admin: boolean,
  trustedOrigin = (origin: string) => origin === "https://app.rakazo.test",
) {
  const terminal = createTerminalServer({
    sessionUserId: async () => sessionUserId,
    isAdmin: async () => admin,
    isTrustedOrigin: trustedOrigin,
  });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    if (!terminal.handleUpgrade(request, socket, head)) socket.destroy();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { terminal, url: `ws://127.0.0.1:${port}${TERMINAL_PATH}` };
}

function attempt(url: string, origin?: string) {
  return new Promise<number>((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("error", () => undefined);
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe("terminal upgrade", () => {
  it("rejects anonymous upgrades", async () => {
    const { url } = await serve(undefined, false);
    expect(await attempt(url)).toBe(401);
  });

  it("rejects signed-in non-admins", async () => {
    const { url } = await serve("user-2", false);
    expect(await attempt(url)).toBe(403);
  });

  it("gives an admin a working shell", async () => {
    const { url } = await serve("admin-1", true);
    const ws = new WebSocket(url);
    await once(ws, "open");
    const echoed = new Promise<string>((resolve) => {
      let buffer = "";
      ws.on("message", (data) => {
        buffer += data.toString();
        if (buffer.includes("terminal-ok")) resolve(buffer);
      });
    });
    ws.send("echo terminal-ok\n");
    await expect(echoed).resolves.toContain("terminal-ok");
    ws.close();
  });

  it("ends the shell when the session that opened it is revoked", async () => {
    // The shell is authorized by the session at upgrade time. Revoking that session
    // (sign-out, a password change, an admin revocation) must end it, or an admin
    // shell outlives the credential that justified it.
    const { terminal, url } = await serve("admin-1", true);
    const ws = new WebSocket(url);
    await once(ws, "open");
    const closed = once(ws, "close");
    terminal.endUser("admin-1");
    await expect(closed).resolves.toBeDefined();
  });

  it("leaves another person's shell alone", async () => {
    const { terminal, url } = await serve("admin-1", true);
    const ws = new WebSocket(url);
    await once(ws, "open");
    terminal.endUser("someone-else");
    // Still open: ending one person's shell must not end everyone's.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("rejects an upgrade from a site we do not trust", async () => {
    // A page on another site can make the browser attach this API's cookie to a
    // WebSocket; an upgrade bypasses the CORS checks the HTTP routes apply.
    const { url } = await serve("admin-1", true);
    expect(await attempt(url, "https://evil.test")).toBe(403);
  });

  it("accepts an upgrade from a trusted origin", async () => {
    const { url } = await serve("admin-1", true);
    expect(await attempt(url, "https://app.rakazo.test")).toBe(101);
  });

  it("accepts an upgrade with no Origin at all", async () => {
    // A non-browser client cannot be tricked into sending a cookie, so it is allowed.
    const { url } = await serve("admin-1", true);
    expect(await attempt(url)).toBe(101);
  });

  it("rejects an upgrade whose Origin header is repeated", async () => {
    // Node hands repeated headers over as an array. No browser sends two, so a
    // request shaped that way must not slip past the trust check.
    const { terminal } = await serve("admin-1", true);
    const seen: string[] = [];
    const handled = terminal.handleUpgrade(
      {
        url: TERMINAL_PATH,
        headers: { origin: ["https://app.rakazo.test", "https://evil.test"] },
      } as never,
      {
        on: () => undefined,
        off: () => undefined,
        end: (chunk: string) => seen.push(chunk),
      } as never,
      Buffer.alloc(0),
    );
    expect(handled).toBe(true);
    expect(seen.join("")).toContain("403");
    terminal.close();
  });

  it("leaves other upgrade paths to the next handler", async () => {
    const terminal = createTerminalServer({
      sessionUserId: async () => "admin-1",
      isAdmin: async () => true,
      isTrustedOrigin: () => true,
    });
    const handled = terminal.handleUpgrade(
      { url: "/api/devices/connect", headers: {} } as never,
      { on: () => undefined } as never,
      Buffer.alloc(0),
    );
    expect(handled).toBe(false);
    terminal.close();
  });
});
