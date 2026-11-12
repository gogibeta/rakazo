import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCheckedProxyDispatcher } from "./proxy-dispatcher.js";
import { fetchSafeWebText } from "./web-ssrf.js";

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

const servers: Array<{ close(done: () => void): void }> = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

async function listen<
  T extends {
    listen(port: number, host: string, done: () => void): void;
    on(event: "connection", listener: (socket: Socket) => void): void;
  },
>(server: T): Promise<number> {
  servers.push(server as never);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(0))).then(
    () => ((server as unknown as { address(): AddressInfo }).address() as AddressInfo).port,
  );
}

async function startTarget(): Promise<number> {
  const target = createHttpServer((request, response) => {
    response.end(`ok:${request.headers.host ?? ""}`);
  });
  return listen(target);
}

describe("a run's chosen HTTP proxy", () => {
  it("tunnels to the checked address and keeps the original host", async () => {
    const targetPort = await startTarget();
    const proxied: string[] = [];
    const proxy = createHttpServer((_request, response) => {
      response.writeHead(405).end();
    });
    proxy.on("connect", (request, client) => {
      proxied.push(request.url ?? "");
      const upstream = new Socket();
      upstream.connect(targetPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client).pipe(upstream);
      });
    });
    const proxyPort = await listen(proxy);

    const response = await fetchSafeWebText("http://example.test/page", {
      resolveHostname: publicResolver,
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
    });

    expect(response.body).toBe("ok:example.test");
    expect(proxied).toEqual(["203.0.113.10:80"]);
  });

  it("replaces the environment proxy instead of chaining it", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("http_proxy", "http://127.0.0.1:1");
    expect(() =>
      createCheckedProxyDispatcher(
        publicResolver,
        () => undefined,
        undefined,
        undefined,
        "gopher://proxy.example.com:70",
      ),
    ).toThrow("Only HTTP and SOCKS5 proxies are supported");
  });
});

/** A minimal SOCKS5 server: records the CONNECT address, then pipes to the local target. */
async function startSocksProxy(options: {
  username?: string;
  password?: string;
  targetPort: number;
  seen: { auth: string[]; connects: string[] };
}): Promise<number> {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage: "greeting" | "auth" | "request" | "tunnel" = "greeting";
    socket.on("data", (chunk) => {
      if (stage === "tunnel") return;
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === "greeting") {
          if (buffer.length < 2) return;
          const count = buffer[1]!;
          if (buffer.length < 2 + count) return;
          buffer = buffer.subarray(2 + count);
          const method = options.username ? 0x02 : 0x00;
          socket.write(Buffer.from([0x05, method]));
          stage = options.username ? "auth" : "request";
        } else if (stage === "auth") {
          if (buffer.length < 2) return;
          const userLength = buffer[1]!;
          if (buffer.length < 2 + userLength + 1) return;
          const username = buffer.subarray(2, 2 + userLength).toString();
          const passLength = buffer[2 + userLength]!;
          if (buffer.length < 2 + userLength + 1 + passLength) return;
          const passcode = buffer
            .subarray(2 + userLength + 1, 2 + userLength + 1 + passLength)
            .toString();
          buffer = buffer.subarray(2 + userLength + 1 + passLength);
          options.seen.auth.push([username, passcode].join(":"));
          const ok = username === options.username && passcode === options.password;
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0xff]));
          if (!ok) {
            socket.destroy();
            return;
          }
          stage = "request";
        } else {
          if (buffer.length < 4) return;
          const atyp = buffer[3]!;
          const addressLength = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : buffer[4]! + 1;
          const total = 4 + addressLength + 2;
          if (buffer.length < total) return;
          const addressBytes = buffer.subarray(4, 4 + addressLength);
          const address =
            atyp === 0x01 ? [...addressBytes].join(".") : addressBytes.toString("hex");
          const port = buffer.readUInt16BE(4 + addressLength);
          options.seen.connects.push(`${address}:${port}`);
          const rest = buffer.subarray(total);
          buffer = Buffer.alloc(0);
          stage = "tunnel";
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          const upstream = new Socket();
          upstream.connect(options.targetPort, "127.0.0.1", () => {
            if (rest.length) upstream.write(rest);
            upstream.pipe(socket).pipe(upstream);
          });
          socket.removeAllListeners("data");
          return;
        }
      }
    });
  });
  return listen(server);
}

describe("a run's chosen SOCKS5 proxy", () => {
  it("authenticates and CONNECTs to the checked address, never the hostname", async () => {
    const targetPort = await startTarget();
    const seen = { auth: [] as string[], connects: [] as string[] };
    const proxyPort = await startSocksProxy({
      username: "user-cc-IN",
      password: "secret",
      targetPort,
      seen,
    });

    const response = await fetchSafeWebText("http://example.test/page", {
      resolveHostname: publicResolver,
      proxyUrl: `socks5://user-cc-IN:secret@127.0.0.1:${proxyPort}`,
    });

    expect(response.body).toBe("ok:example.test");
    expect(seen.auth).toEqual(["user-cc-IN:secret"]);
    expect(seen.connects).toEqual(["203.0.113.10:80"]);
  });

  it("fails the fetch when the proxy rejects the password", async () => {
    const targetPort = await startTarget();
    const seen = { auth: [] as string[], connects: [] as string[] };
    const proxyPort = await startSocksProxy({
      username: "user",
      password: "right",
      targetPort,
      seen,
    });

    await expect(
      fetchSafeWebText("http://example.test/page", {
        resolveHostname: publicResolver,
        proxyUrl: `socks5://user:wrong@127.0.0.1:${proxyPort}`,
      }),
    ).rejects.toThrow();
    expect(seen.connects).toEqual([]);
  });
});
