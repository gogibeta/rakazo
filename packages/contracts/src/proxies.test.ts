import { describe, expect, it } from "vitest";
import {
  composeProxyUrl,
  ProxyAddInput,
  parseProxyUrl,
  proxyPartsFromInput,
  proxyUsername,
} from "./proxies.js";

describe("composeProxyUrl", () => {
  it("composes a bare proxy without credentials", () => {
    expect(composeProxyUrl({ protocol: "http", host: "proxy.example.com", port: 8080 })).toBe(
      "http://proxy.example.com:8080",
    );
  });

  it("URL-encodes the credentials", () => {
    expect(
      composeProxyUrl({
        protocol: "socks5",
        host: "10.0.0.9",
        port: 1080,
        username: "user name",
        password: "p@ss:word",
      }),
    ).toBe("socks5://user%20name:p%40ss%3Aword@10.0.0.9:1080");
  });

  it("brackets an IPv6 host", () => {
    expect(composeProxyUrl({ protocol: "http", host: "::1", port: 3128 })).toBe(
      "http://[::1]:3128",
    );
  });

  it("composes the country into the username", () => {
    expect(proxyUsername({ username: "customer-42", country: "in" })).toBe("customer-42-cc-IN");
    expect(proxyUsername({ username: "customer-42", country: null })).toBe("customer-42");
    expect(proxyUsername({ username: null, country: "IN" })).toBeNull();
    expect(
      composeProxyUrl({
        protocol: "http",
        host: "pr.example.com",
        port: 7777,
        username: "customer-42",
        password: "pw",
        country: "IN",
      }),
    ).toBe("http://customer-42-cc-IN:pw@pr.example.com:7777");
  });
});

describe("parseProxyUrl", () => {
  it("parses a full URL and splits the country suffix back out", () => {
    expect(parseProxyUrl("http://customer-42-cc-in:pw@pr.example.com:7777")).toEqual({
      protocol: "http",
      host: "pr.example.com",
      port: 7777,
      country: "IN",
      username: "customer-42",
      password: "pw",
    });
  });

  it("round-trips through composeProxyUrl", () => {
    const parts = {
      protocol: "https" as const,
      host: "proxy.example.com",
      port: 8443,
      country: "DE",
      username: "user name",
      password: "p@ss:word",
    };
    expect(parseProxyUrl(composeProxyUrl(parts))).toEqual(parts);
  });

  it("defaults the port by protocol", () => {
    expect(parseProxyUrl("socks5://proxy.example.com").port).toBe(1080);
    expect(parseProxyUrl("http://proxy.example.com").port).toBe(80);
  });

  it("rejects other protocols, credentials without a username, and internal hosts", () => {
    expect(() => parseProxyUrl("ftp://proxy.example.com:21")).toThrow(/http/);
    expect(() => parseProxyUrl("http://:pw@proxy.example.com:8080")).toThrow(/username/);
    expect(() => parseProxyUrl("http://169.254.169.254:8080")).toThrow(/public/);
    expect(() => parseProxyUrl("http://localhost:8080")).toThrow(/public/);
    expect(() => parseProxyUrl("not a url")).toThrow(/invalid/);
  });
});

describe("ProxyAddInput", () => {
  it("accepts the structured fields and normalizes the country", () => {
    const input = ProxyAddInput.parse({
      name: "Mumbai",
      protocol: "http",
      host: "pr.example.com",
      port: 7777,
      country: "in",
      username: "customer-42",
      password: "pw",
    });
    expect(proxyPartsFromInput(input)).toEqual({
      protocol: "http",
      host: "pr.example.com",
      port: 7777,
      country: "IN",
      username: "customer-42",
      password: "pw",
    });
  });

  it("accepts a pasted URL instead of the fields", () => {
    const input = ProxyAddInput.parse({
      name: "Frankfurt",
      url: "socks5://user:pw@proxy.example.com:1080",
    });
    expect(proxyPartsFromInput(input)).toEqual({
      protocol: "socks5",
      host: "proxy.example.com",
      port: 1080,
      country: null,
      username: "user",
      password: "pw",
    });
  });

  it("rejects a password without a username and a missing port", () => {
    expect(
      ProxyAddInput.safeParse({ name: "x", host: "pr.example.com", port: 8080, password: "pw" })
        .success,
    ).toBe(false);
    expect(ProxyAddInput.safeParse({ name: "x", host: "pr.example.com" }).success).toBe(false);
    expect(ProxyAddInput.safeParse({ name: "x", host: "10.0.0.9", port: 8080 }).success).toBe(
      false,
    );
  });
});
