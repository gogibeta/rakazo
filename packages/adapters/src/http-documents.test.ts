import type { AdapterContext } from "@rakazo/adapter-kit";
import { DocumentProviderError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { HttpDocumentProvider } from "./http-documents.js";

const context: AdapterContext = {
  operationId: "documents",
  traceId: "trace",
  userId: "user",
  spaceId: "space",
  runId: "run",
  signal: new AbortController().signal,
};

const document = { fileName: "invoice.pdf", bytes: new Uint8Array([37, 80, 68, 70]) };

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * A stubbed document service: grants and uploads always succeed, deletes are
 * accepted, and each test scripts the create and job-read responses.
 */
function stubService(script: {
  create: (operation: string, body: Record<string, unknown>) => Response;
  job?: (jobId: string) => Response;
}) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    };
    calls.push(call);
    if (url.endsWith("/documents/upload-grants"))
      return json({
        workspace_id: "ws_1",
        upload_url: "https://uploads.example.test/file",
        token: "upload-token",
        expires_at: "2030-01-01T00:00:00Z",
        max_bytes: null,
      });
    if (url === "https://uploads.example.test/file")
      return json({
        job_id: "upload_1",
        status: "succeeded",
        result: { file: { workspace_id: "ws_1", file_id: "file_1" } },
      });
    const create = url.match(/\/documents\/(parse|extract|classify|split|ground)\?/);
    if (create?.[1])
      return script.create(
        create[1],
        JSON.parse(typeof call.body === "string" ? call.body : "{}") as Record<string, unknown>,
      );
    const job = url.match(/\/documents\/jobs\/(\w+)/);
    if (job?.[1] && script.job) return script.job(job[1]);
    if (call.method === "DELETE") return json({ status: "deleted" });
    throw new Error(`unexpected call ${call.method} ${url}`);
  });
  return { fetchMock, calls };
}

function provider(fetchMock: typeof fetch) {
  return new HttpDocumentProvider({
    apiKey: "fake-document-key",
    fetch: fetchMock,
    pollIntervalMs: 1,
  });
}

describe("HttpDocumentProvider", () => {
  it("uploads, parses and deletes the upload, reporting the job's cost", async () => {
    const { fetchMock, calls } = stubService({
      create: () =>
        json({
          job_id: "job_1",
          kind: "parse",
          status: "succeeded",
          result: {
            result_type: "parse",
            file_name: "invoice.pdf",
            document: { page_count: 2, markdown: "# Invoice", text: "Invoice" },
            ocr_applied: false,
          },
          cost: { total_usd: "0.02" },
        }),
    });
    const result = await provider(fetchMock).parse({ document }, context);
    expect(result.markdown).toBe("# Invoice");
    expect(result.pageCount).toBe(2);
    expect(result.ocrApplied).toBe(false);
    expect(result.usage?.costUsd).toBe(0.02);
    expect(result.usage?.providerRequestId).toBe("job_1");

    const grant = calls.find((call) => call.url.endsWith("/documents/upload-grants"));
    expect(grant?.headers.Authorization).toBe("Bearer fake-document-key");
    const upload = calls.find((call) => call.url === "https://uploads.example.test/file");
    expect(upload?.headers["X-Upload-Token"]).toBe("upload-token");
    expect(upload?.headers.Authorization).toBeUndefined();
    expect(upload?.body).toBeInstanceOf(FormData);
    const create = calls.find((call) => call.url.includes("/documents/parse?"));
    const createBody = JSON.parse(create?.body as string) as Record<string, unknown>;
    expect(createBody.source).toEqual({
      type: "workspace_file",
      workspace_id: "ws_1",
      file_id: "file_1",
    });
    expect(createBody.output).toEqual({ formats: ["markdown", "text"] });
    expect(create?.headers["Idempotency-Key"]).toBeTruthy();
    const deletion = calls.find((call) => call.method === "DELETE");
    expect(deletion?.url).toBe("https://console.nace.ai/v1/documents/workspaces/ws_1/files/file_1");
  });

  it("polls a running job until it succeeds and maps the extract result", async () => {
    const { fetchMock } = stubService({
      create: () =>
        json({ job_id: "job_2", kind: "extract", status: "running", result: null }, 202),
      job: () =>
        json({
          job_id: "job_2",
          kind: "extract",
          status: "succeeded",
          result: {
            result_type: "extract",
            data: { total: 42 },
            fields: [
              {
                path: "/total",
                value: 42,
                status: "found",
                confidence: 0.9,
                citations: [
                  {
                    location: { kind: "page_region", page: 1, polygons: [] },
                    source_text: "Total 42",
                  },
                ],
              },
            ],
          },
        }),
    });
    const result = await provider(fetchMock).extract(
      { document, schema: { type: "object", properties: { total: { type: "number" } } } },
      context,
    );
    expect(result.data).toEqual({ total: 42 });
    expect(result.fields).toEqual([
      {
        path: "/total",
        value: 42,
        status: "found",
        confidence: 0.9,
        citations: [{ page: 1, sourceText: "Total 42" }],
      },
    ]);
  });

  it("maps classify, split and locate results", async () => {
    const { fetchMock } = stubService({
      create: (operation) => {
        if (operation === "classify")
          return json({
            job_id: "job_3",
            status: "succeeded",
            result: {
              units: [
                {
                  granularity: "document",
                  page_range: null,
                  unknown: false,
                  labels: [
                    {
                      rank: 1,
                      class_id: "invoice",
                      label: "Invoice",
                      confidence: 0.97,
                      reason: "Has a total",
                    },
                  ],
                },
              ],
              unknown_units: 0,
            },
          });
        if (operation === "split")
          return json({
            job_id: "job_4",
            status: "succeeded",
            result: {
              segments: [
                {
                  id: "seg_1",
                  sequence: 0,
                  start_page: 1,
                  end_page: 2,
                  status: "matched",
                  class: { id: "invoice", label: "Invoice" },
                  content: "# Invoice",
                },
              ],
            },
          });
        return json({
          job_id: "job_5",
          status: "succeeded",
          result: {
            result_type: "ground",
            targets: [
              {
                id: "total",
                status: "found",
                matches: [
                  {
                    rank: 1,
                    matched_text: "42",
                    match_method: "exact",
                    location: { kind: "text_span", page: 1, char_start: 10, char_end: 12 },
                  },
                ],
              },
            ],
          },
        });
      },
    });
    const http = provider(fetchMock);
    const classified = await http.classify(
      { document, classes: [{ id: "invoice", label: "Invoice" }] },
      context,
    );
    expect(classified.units[0]?.labels[0]).toEqual({
      classId: "invoice",
      label: "Invoice",
      confidence: 0.97,
      reason: "Has a total",
    });
    const split = await http.split(
      { document, classes: [{ id: "invoice", label: "Invoice" }] },
      context,
    );
    expect(split.segments[0]).toEqual({
      pageRange: { start: 1, end: 2 },
      status: "matched",
      classId: "invoice",
      classLabel: "Invoice",
      content: "# Invoice",
    });
    const located = await http.locate(
      { document, targets: [{ id: "total", text: "42" }] },
      context,
    );
    expect(located.targets[0]?.matches[0]?.matchedText).toBe("42");
    expect(located.targets[0]?.matches[0]?.page).toBe(1);
  });

  it("surfaces a failed job with the provider's error code", async () => {
    const { fetchMock } = stubService({
      create: () => json({ job_id: "job_6", status: "running", result: null }, 202),
      job: () =>
        json({
          job_id: "job_6",
          status: "failed",
          result: null,
          error: { code: "unsupported_file", message: "Cannot read this file" },
        }),
    });
    const failure = await provider(fetchMock)
      .parse({ document }, context)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DocumentProviderError);
    expect((failure as DocumentProviderError).kind).toBe("failed");
    expect((failure as DocumentProviderError).code).toBe("unsupported_file");
    expect((failure as Error).message).toBe("Document job failed (unsupported_file)");
  });

  it("maps a rejected key to an authentication error", async () => {
    const { fetchMock } = stubService({
      create: () => json({ error: { type: "authentication_error" } }, 401),
    });
    const failure = await provider(fetchMock)
      .parse({ document }, context)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DocumentProviderError);
    expect((failure as DocumentProviderError).kind).toBe("authentication");
  });

  it("rejects a malformed job response as an invalid response", async () => {
    const { fetchMock } = stubService({
      create: () => json({ unexpected: true }),
    });
    const failure = await provider(fetchMock)
      .parse({ document }, context)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DocumentProviderError);
    expect((failure as DocumentProviderError).kind).toBe("invalid_response");
  });
});
