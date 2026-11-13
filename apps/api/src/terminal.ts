import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { TERMINAL_PATH } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

/** A terminal left alone this long is closed; the shell does not linger. */
export const TERMINAL_IDLE_TIMEOUT_MS = 15 * 60_000;

export interface TerminalUpgradeDeps {
  /** The signed-in user behind a raw upgrade request, from its session cookie. */
  sessionUserId: (request: IncomingMessage) => Promise<string | undefined>;
  isAdmin: (userId: string) => Promise<boolean>;
  /** Test seam: how a session's shell starts. Defaults to the API process's own shell. */
  spawnShell?: () => ChildProcess;
}

export interface TerminalServer {
  /** Node `upgrade` listener for the terminal path. Returns false for any other path. */
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => void;
}

interface TerminalSession {
  socket: WebSocket;
  child: ChildProcess;
  idle: NodeJS.Timeout;
}

/**
 * The admin terminal: one interactive shell per admin, spawned in the API's
 * own process environment and piped over a WebSocket. There is no PTY — the
 * shell runs on pipes, which line-based tools handle fine. Admin is checked
 * at upgrade time from the session cookie; nothing here trusts the client.
 */
export function createTerminalServer(deps: TerminalUpgradeDeps): TerminalServer {
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<string, TerminalSession>();
  let closed = false;

  const endSession = (userId: string) => {
    const session = sessions.get(userId);
    if (!session) return;
    sessions.delete(userId);
    clearTimeout(session.idle);
    session.child.kill("SIGTERM");
    if (session.socket.readyState === session.socket.OPEN) session.socket.close(1000);
  };

  const attach = (userId: string, socket: WebSocket) => {
    endSession(userId);
    const child = (deps.spawnShell ?? defaultShell)();
    const session: TerminalSession = {
      socket,
      child,
      idle: setTimeout(() => endSession(userId), TERMINAL_IDLE_TIMEOUT_MS),
    };
    sessions.set(userId, session);
    const keepAlive = () => {
      clearTimeout(session.idle);
      session.idle = setTimeout(() => endSession(userId), TERMINAL_IDLE_TIMEOUT_MS);
    };
    const send = (data: Buffer) => {
      keepAlive();
      if (socket.readyState === socket.OPEN) socket.send(data.toString("utf8"));
    };
    child.stdout?.on("data", send);
    child.stderr?.on("data", send);
    child.on("exit", () => {
      if (sessions.get(userId) === session) endSession(userId);
    });
    child.on("error", (error) => {
      getLogger().warn("terminal shell failed", { error });
      endSession(userId);
    });
    socket.on("message", (data) => {
      keepAlive();
      child.stdin?.write(data.toString());
    });
    socket.on("close", () => endSession(userId));
    socket.on("error", () => endSession(userId));
  };

  return {
    handleUpgrade(request, socket, head) {
      const path = new URL(request.url ?? "/", "http://api").pathname;
      if (path !== TERMINAL_PATH) return false;
      // Until ws takes over, a client reset would otherwise crash the process.
      const onError = (error: Error) =>
        getLogger().warn("terminal upgrade socket error", { error });
      socket.on("error", onError);
      const reject = (status: number, text: string) => {
        socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (closed) {
        reject(503, "Service Unavailable");
        return true;
      }
      void (async () => {
        const userId = await deps.sessionUserId(request);
        if (!userId) return reject(401, "Unauthorized");
        if (!(await deps.isAdmin(userId))) return reject(403, "Forbidden");
        socket.off("error", onError);
        wss.handleUpgrade(request, socket, head, (ws) => attach(userId, ws));
      })().catch((error) => {
        getLogger().error("terminal upgrade failed", error);
        reject(500, "Internal Server Error");
      });
      return true;
    },
    close() {
      closed = true;
      for (const userId of [...sessions.keys()]) endSession(userId);
      wss.close();
    },
  };
}

/** The API's own shell: bash where the image ships it, sh everywhere. */
function defaultShell(): ChildProcess {
  const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  return spawn(shell, [], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
