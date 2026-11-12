import { lookup } from "node:dns/promises";
import type { Socket } from "node:net";
import { createConnection } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  ipVersion,
  isCloudMetadataHost,
  isInternalHostname,
  isNonPublicAddress,
  normalizeHost,
} from "@rakazo/contracts";
import type { Dispatcher } from "undici";
import { Agent, EnvHttpProxyAgent, Pool } from "undici";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import { createAddressCheckedLookup, egressRefused } from "./network-address.js";
import { dispatcherFetch } from "./undici-fetch.js";

type ValidateAddresses = (addresses: ResolvedAddress[], hostname: string) => void;

/**
 * Honors HTTP(S)_PROXY / NO_PROXY. Direct routes connect through the checked lookup; proxied
 * requests are tunneled with CONNECT to the checked IP, so the proxy never resolves the hostname
 * itself and DNS rebinding cannot reach past it.
 *
 * A proxy chosen for one run (`proxyUrl`) replaces the environment's: same checked tunneling
 * for HTTP, and for SOCKS5 the handshake below, which also names the checked IP — a stock
 * SOCKS client would hand the proxy the hostname to resolve, the hole the env path refuses.
 */
export function createCheckedProxyDispatcher(
  resolve: ResolveHostname,
  validate: ValidateAddresses,
  connectTimeout?: number,
  responseTimeouts?: Pick<Agent.Options, "headersTimeout" | "bodyTimeout">,
  proxyUrl?: string,
): Dispatcher {
  const connect = {
    ...(connectTimeout === undefined ? {} : { timeout: connectTimeout }),
    lookup: createAddressCheckedLookup(resolve, validate),
  };
  if (proxyUrl) {
    return chosenProxyDispatcher(proxyUrl, {
      resolve,
      validate,
      connect,
      connectTimeout,
      responseTimeouts,
    });
  }
  const { env } = process;
  const proxies = [env.http_proxy ?? env.HTTP_PROXY, env.https_proxy ?? env.HTTPS_PROXY];
  for (const proxy of proxies) {
    if (proxy && !/^https?:\/\//i.test(proxy)) throw new Error("Only HTTP proxies are supported");
  }
  if (!proxies.some(Boolean)) return new Agent({ ...responseTimeouts, connect });
  return new EnvHttpProxyAgent({
    ...responseTimeouts,
    connect,
    ...(connectTimeout === undefined ? {} : { connectTimeout }),
    proxyTunnel: true,
    clientFactory: checkedClientFactory(resolve, validate),
  });
}

function checkedClientFactory(resolve: ResolveHostname, validate: ValidateAddresses) {
  return (origin: URL, options: object) => {
    const pool = new Pool(origin, options as Pool.Options);
    const connect = pool.connect.bind(pool) as (
      options: Dispatcher.ConnectOptions,
    ) => Promise<Dispatcher.ConnectData>;
    return Object.assign(pool, {
      connect: async (options: Dispatcher.ConnectOptions) => {
        const authority = await checkedAuthority(options.path, resolve, validate);
        return connect({
          ...options,
          path: authority,
          headers: { ...(options.headers as Record<string, string>), host: authority },
        });
      },
    });
  };
}

type ChosenProxy = {
  resolve: ResolveHostname;
  validate: ValidateAddresses;
  connect: { timeout?: number; lookup: ReturnType<typeof createAddressCheckedLookup> };
  connectTimeout?: number;
  responseTimeouts?: Pick<Agent.Options, "headersTimeout" | "bodyTimeout">;
};

function chosenProxyDispatcher(proxyUrl: string, chosen: ChosenProxy): Dispatcher {
  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    throw new Error("Proxy URL is invalid");
  }
  if (proxy.protocol === "socks5:" || proxy.protocol === "socks:") {
    return createSocksProxyDispatcher(proxy, chosen);
  }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error("Only HTTP and SOCKS5 proxies are supported");
  }
  return new EnvHttpProxyAgent({
    ...chosen.responseTimeouts,
    connect: chosen.connect,
    ...(chosen.connectTimeout === undefined ? {} : { connectTimeout: chosen.connectTimeout }),
    httpProxy: proxyUrl,
    httpsProxy: proxyUrl,
    proxyTunnel: true,
    clientFactory: checkedClientFactory(chosen.resolve, chosen.validate),
  });
}

async function checkedAuthority(
  authority: string,
  resolve: ResolveHostname,
  validate: ValidateAddresses,
): Promise<string> {
  const separator = authority.lastIndexOf(":");
  const hostname = authority.slice(0, separator).replace(/^\[|\]$/g, "");
  const family = ipVersion(hostname);
  const addresses = family === 0 ? await resolve(hostname) : [{ address: hostname, family }];
  try {
    validate(addresses, hostname);
  } catch (error) {
    throw egressRefused(hostname, error);
  }
  const address = addresses[0]?.address ?? "";
  const host = ipVersion(address) === 6 ? `[${address}]` : address;
  return `${host}${authority.slice(separator)}`;
}

/**
 * SOCKS5 with the env path's guarantee kept: the proxy itself is dialed through the checked
 * lookup, and the CONNECT names the checked address, never the hostname.
 */
function createSocksProxyDispatcher(proxy: URL, chosen: ChosenProxy): Dispatcher {
  const proxyPort = Number(proxy.port || 1080);
  return new Agent({
    ...chosen.responseTimeouts,
    connect: (options, callback) => {
      connectThroughSocks(proxy, proxyPort, options, chosen).then(
        (socket) => callback(null, socket),
        (error: unknown) =>
          callback(error instanceof Error ? error : new Error(String(error)), null),
      );
    },
  });
}

async function connectThroughSocks(
  proxy: URL,
  proxyPort: number,
  options: { hostname: string; port: string | number; protocol: string; servername?: string },
  chosen: ChosenProxy,
): Promise<Socket> {
  const hostname = options.hostname.replace(/^\[|\]$/g, "");
  // Undici leaves the port empty for a protocol's default port.
  const targetPort = Number(options.port) || (options.protocol === "https:" ? 443 : 80);
  const authority = await checkedAuthority(
    `${hostname}:${targetPort}`,
    chosen.resolve,
    chosen.validate,
  );
  const separator = authority.lastIndexOf(":");
  const address = authority.slice(0, separator).replace(/^\[|\]$/g, "");
  const port = Number(authority.slice(separator + 1));

  const socket = createConnection({
    host: proxy.hostname,
    port: proxyPort,
    lookup: createAddressCheckedLookup(chosen.resolve, chosen.validate),
  });
  const timeoutMs = chosen.connectTimeout ?? 10_000;
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Proxy connection timed out")));
  try {
    await onceConnect(socket);
    await socksHandshake(socket, proxy, address, port);
    socket.setTimeout(0);
    if (options.protocol !== "https:") return socket;
    const tlsSocket = tlsConnect({
      socket,
      servername: options.servername ?? hostname,
      ALPNProtocols: ["http/1.1"],
    });
    await onceSecureConnect(tlsSocket);
    return tlsSocket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function onceConnect(socket: Socket): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    socket.once("connect", resolvePromise);
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("Proxy connection timed out")));
  });
}

function onceSecureConnect(socket: ReturnType<typeof tlsConnect>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    socket.once("secureConnect", resolvePromise);
    socket.once("error", reject);
  });
}

/** Reads exact byte counts off a socket whose later bytes belong to the tunneled stream. */
class SocketReader {
  private buffer = Buffer.alloc(0);
  private pending: {
    length: number;
    resolve: (value: Buffer) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.pump();
  };

  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () => this.fail(new Error("Proxy closed the connection"));

  private fail(error: Error) {
    this.pending?.reject(error);
    this.pending = null;
  }

  private pump() {
    if (!this.pending || this.buffer.length < this.pending.length) return;
    const { length, resolve } = this.pending;
    this.pending = null;
    const value = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    resolve(Buffer.from(value));
  }

  read(length: number): Promise<Buffer> {
    if (this.pending) return Promise.reject(new Error("Concurrent proxy reads"));
    return new Promise((resolve, reject) => {
      this.pending = { length, resolve, reject };
      this.pump();
    });
  }

  /** Hand the socket back: later bytes are the tunneled stream, not the handshake. */
  detach() {
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("error", this.onError);
    this.socket.removeListener("close", this.onClose);
    if (this.buffer.length) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
    this.socket.pause();
  }
}

async function socksHandshake(
  socket: Socket,
  proxy: URL,
  address: string,
  port: number,
): Promise<void> {
  const reader = new SocketReader(socket);
  try {
    const username = proxy.username ? decodeURIComponent(proxy.username) : "";
    const secret = proxy.password ? decodeURIComponent(proxy.password) : "";
    const methods = username ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const greeting = await reader.read(2);
    if (greeting[0] !== 0x05 || greeting[1] === 0xff) {
      throw new Error("Proxy did not accept SOCKS5");
    }
    if (greeting[1] === 0x02) {
      if (!username) throw new Error("Proxy requires a username");
      const userBytes = Buffer.from(username, "utf8");
      const secretBytes = Buffer.from(secret, "utf8");
      socket.write(
        Buffer.concat([
          Buffer.from([0x01, userBytes.length]),
          userBytes,
          Buffer.from([secretBytes.length]),
          secretBytes,
        ]),
      );
      const auth = await reader.read(2);
      if (auth[1] !== 0x00) throw new Error("Proxy authentication failed");
    } else if (greeting[1] !== 0x00) {
      throw new Error("Proxy did not accept SOCKS5");
    }
    const family = ipVersion(address);
    const addressBytes =
      family === 6 ? ipv6ToBytes(address) : Buffer.from(address.split(".").map(Number));
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, family === 6 ? 0x04 : 0x01]),
        addressBytes,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]),
    );
    const reply = await reader.read(4);
    if (reply[0] !== 0x05) throw new Error("Proxy did not accept SOCKS5");
    if (reply[1] !== 0x00) throw new Error(`Proxy refused the connection (error ${reply[1]})`);
    let boundLength: number;
    if (reply[3] === 0x01) boundLength = 4;
    else if (reply[3] === 0x04) boundLength = 16;
    else if (reply[3] === 0x03) boundLength = (await reader.read(1))[0]!;
    else throw new Error("Proxy sent an invalid reply");
    await reader.read(boundLength + 2);
  } finally {
    reader.detach();
  }
}

function ipv6ToBytes(address: string): Buffer {
  const [headPart, tailPart] = address.split("::");
  const head = headPart ? headPart.split(":") : [];
  const tail = tailPart ? tailPart.split(":") : [];
  const groups = [...head];
  if (tailPart !== undefined) {
    for (let missing = 8 - head.length - tail.length; missing > 0; missing--) groups.push("0");
    groups.push(...tail);
  }
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => {
    bytes.writeUInt16BE(parseInt(group || "0", 16) & 0xffff, index * 2);
  });
  return bytes;
}

const defaultResolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function validatePublicTarget(addresses: ResolvedAddress[], hostname: string): void {
  const host = normalizeHost(hostname);
  if (isInternalHostname(host) || isCloudMetadataHost(host)) {
    throw new Error("URL targets a private or internal host");
  }
  if (addresses.length === 0 || addresses.some((entry) => isNonPublicAddress(entry.address))) {
    throw new Error("URL resolves to a private address");
  }
}

const proxiedFetches = new Map<string, typeof globalThis.fetch>();

/**
 * A fetch whose requests all leave through one chosen proxy, for provider API calls that
 * do not go through the guarded fetch. Dispatchers are shared per proxy: a run's provider
 * is built per run, and an agent per run would pile up sockets in a long-lived worker.
 */
export function fetchThroughProxy(proxyUrl: string): typeof globalThis.fetch {
  const cached = proxiedFetches.get(proxyUrl);
  if (cached) return cached;
  const dispatcher = createCheckedProxyDispatcher(
    defaultResolveHostname,
    validatePublicTarget,
    undefined,
    undefined,
    proxyUrl,
  );
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    dispatcherFetch(input, {
      ...init,
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher })) as typeof globalThis.fetch;
  proxiedFetches.set(proxyUrl, fetchImpl);
  return fetchImpl;
}
