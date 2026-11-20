import { resolveSupervisorToken } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { supervisorApp } from "./index.js";

const token = resolveSupervisorToken(process.env);

function request(path: string, init: { method?: string; authorization?: string } = {}) {
  return supervisorApp.request(path, {
    method: init.method ?? "GET",
    headers: init.authorization ? { authorization: init.authorization } : {},
  });
}

describe("supervisor denies unknown routes by default", () => {
  it("serves the health check without a token", async () => {
    // The container probe has no token to send, so this path must stay open.
    const response = await request("/health");
    expect(response.status).toBe(200);
  });

  it("rejects an unlisted path instead of letting it through unauthenticated", async () => {
    // Every route today lives under /computers, so the old prefix guards happened to cover them.
    // This proves the guard is not prefix-based: a path outside that prefix is refused rather
    // than inheriting an open door.
    const response = await request("/not-a-route");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects an unlisted path even by a non-GET method", async () => {
    const response = await request("/not-a-route", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("still requires a token on a real route", async () => {
    const response = await request("/computers/example");
    expect(response.status).toBe(401);
  });

  it("rejects a wrong token on an unlisted path", async () => {
    const response = await request("/not-a-route", { authorization: "Bearer wrong-token" });
    expect(response.status).toBe(401);
  });

  it("lets a valid token past the guard on an unlisted path", async () => {
    // Not 401 means the guard admitted the request; Hono's own 404 then answers.
    const response = await request("/not-a-route", { authorization: `Bearer ${token}` });
    expect(response.status).toBe(404);
  });
});
