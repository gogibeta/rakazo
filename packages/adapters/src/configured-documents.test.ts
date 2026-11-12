import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredDocuments } from "./configured-documents.js";

const context: AdapterContext = {
  operationId: "documents",
  traceId: "trace",
  userId: "user",
  spaceId: "space",
  runId: "run",
  signal: new AbortController().signal,
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });

/** A document service stub that records the key each call carried. */
function stubService() {
  const authorizations: Array<string | undefined> = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.endsWith("/documents/upload-grants")) {
      authorizations.push(headers.Authorization);
      return json({
        workspace_id: "ws_1",
        upload_url: "https://uploads.example.test/file",
        token: "upload-token",
      });
    }
    if (url === "https://uploads.example.test/file")
      return json({
        status: "succeeded",
        result: { file: { workspace_id: "ws_1", file_id: "f_1" } },
      });
    if (url.includes("/documents/parse?"))
      return json({
        job_id: "job_1",
        status: "succeeded",
        result: {
          result_type: "parse",
          document: { page_count: 1, markdown: "# Hi", text: "Hi" },
          ocr_applied: false,
        },
      });
    if (init?.method === "DELETE") return json({ status: "deleted" });
    throw new Error(`unexpected call ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { authorizations };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createConfiguredDocuments", () => {
  it("is unconfigured when neither the environment nor Settings has a Nace key", () => {
    expect(createConfiguredDocuments({})).toBeUndefined();
    expect(createConfiguredDocuments({}, {})).toBeUndefined();
    expect(createConfiguredDocuments({}, { naceApiKey: "   " })).toBeUndefined();
    // A TypeSafe key configures decisions, never documents.
    expect(createConfiguredDocuments({ TYPESAFE_API_KEY: "typesafe-key" })).toBeUndefined();
  });

  it("uses the saved Nace key when the environment has none", async () => {
    const { authorizations } = stubService();
    const provider = createConfiguredDocuments({}, { naceApiKey: "saved-nace-key" });
    if (!provider) throw new Error("expected a configured document provider");
    const result = await provider.parse(
      { document: { fileName: "a.pdf", bytes: new Uint8Array([1]) } },
      context,
    );
    expect(result.markdown).toBe("# Hi");
    expect(authorizations).toEqual(["Bearer saved-nace-key"]);
  });

  it("prefers the environment's Nace key over the saved one", async () => {
    const { authorizations } = stubService();
    const provider = createConfiguredDocuments(
      { NACE_API_KEY: "env-nace-key" },
      { naceApiKey: "saved-nace-key" },
    );
    if (!provider) throw new Error("expected a configured document provider");
    await provider.parse({ document: { fileName: "a.pdf", bytes: new Uint8Array([1]) } }, context);
    expect(authorizations).toEqual(["Bearer env-nace-key"]);
  });
});
