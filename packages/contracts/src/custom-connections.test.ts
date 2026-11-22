import { describe, expect, it } from "vitest";
import {
  CustomConnectionAddInput,
  CustomConnectionCallInput,
  customConnectionBaseUrlProblem,
  customConnectionPathProblem,
} from "./custom-connections.js";

describe("customConnectionBaseUrlProblem", () => {
  it("accepts a public HTTPS base URL, with or without a path prefix", () => {
    expect(customConnectionBaseUrlProblem("https://api.github.com")).toBeNull();
    expect(customConnectionBaseUrlProblem("https://api.example.com/v1")).toBeNull();
  });

  it("rejects plain HTTP, credentials, and fragments", () => {
    expect(customConnectionBaseUrlProblem("http://api.example.com")).toBe(
      "Base URL must use HTTPS",
    );
    expect(customConnectionBaseUrlProblem("https://user:pw@api.example.com")).toBe(
      "Base URL must not contain credentials",
    );
    expect(customConnectionBaseUrlProblem("https://api.example.com/#frag")).toBe(
      "Base URL must not contain a fragment",
    );
    expect(customConnectionBaseUrlProblem("not a url")).toBe("Base URL is invalid");
  });

  it("rejects private, loopback, link-local and internal hosts", () => {
    for (const url of [
      "https://127.0.0.1",
      "https://10.0.0.5",
      "https://172.16.0.9",
      "https://192.168.1.10",
      "https://169.254.169.254",
      "https://[::1]",
      "https://localhost",
      "https://db.internal",
      "https://metadata.google.internal",
    ]) {
      expect(customConnectionBaseUrlProblem(url), url).toBe("Base URL must be a public host");
    }
  });
});

describe("CustomConnectionAddInput", () => {
  it("requires the header or parameter name for those auth styles only", () => {
    expect(
      CustomConnectionAddInput.safeParse({
        name: "GitHub",
        baseUrl: "https://api.github.com",
        authStyle: "bearer",
        apiKey: "token",
      }).success,
    ).toBe(true);
    expect(
      CustomConnectionAddInput.safeParse({
        name: "Svc",
        baseUrl: "https://api.example.com",
        authStyle: "header",
      }).success,
    ).toBe(false);
    expect(
      CustomConnectionAddInput.safeParse({
        name: "Svc",
        baseUrl: "https://api.example.com",
        authStyle: "header",
        authName: "X-Api-Key",
      }).success,
    ).toBe(true);
    expect(
      CustomConnectionAddInput.safeParse({
        name: "Svc",
        baseUrl: "https://api.example.com",
        authStyle: "query",
        authName: "api key",
      }).success,
    ).toBe(false);
  });

  it("rejects a private base URL at the boundary", () => {
    expect(
      CustomConnectionAddInput.safeParse({
        name: "Svc",
        baseUrl: "https://192.168.0.20",
        authStyle: "bearer",
      }).success,
    ).toBe(false);
  });
});

describe("customConnectionPathProblem and CustomConnectionCallInput", () => {
  it("keeps paths relative to the base URL", () => {
    expect(customConnectionPathProblem("/user/repos")).toBeNull();
    expect(customConnectionPathProblem("items?fixed=1")).toBeNull();
    expect(customConnectionPathProblem("//evil.example.com/x")).not.toBeNull();
    expect(customConnectionPathProblem("https://evil.example.com/x")).not.toBeNull();
  });

  it("parses a call and refuses a body on GET", () => {
    const parsed = CustomConnectionCallInput.safeParse({
      connection: "GitHub",
      method: "POST",
      path: "/repos/o/r/issues",
      body: { title: "Hi" },
    });
    expect(parsed.success).toBe(true);
    expect(
      CustomConnectionCallInput.safeParse({
        connection: "GitHub",
        method: "GET",
        path: "/user",
        body: { nope: true },
      }).success,
    ).toBe(false);
  });
});
