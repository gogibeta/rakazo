import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { TERMINAL_PATH } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createTerminalServer } from "./terminal.js";

const servers: Array<ReturnType<typeof createServer>> = [];

async function serve(sessionUserId: string | undefined, admin: boolean) {
  const terminal = createTerminalServer({
    sessionUserId: async () => sessionUserId,
    isAdmin: async () => admin,
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

function attempt(url: string) {
  return new Promise<number>((resolve) => {
    const ws = new WebSocket(url);
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

  it("leaves other upgrade paths to the next handler", async () => {
    const terminal = createTerminalServer({
      sessionUserId: async () => "admin-1",
      isAdmin: async () => true,
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
