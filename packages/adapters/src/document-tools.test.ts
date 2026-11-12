import type {
  AdapterContext,
  DocumentClassifyRequest,
  DocumentExtractRequest,
  DocumentLocateRequest,
  DocumentParseRequest,
  DocumentProvider,
  DocumentSplitRequest,
} from "@rakazo/adapter-kit";
import { DocumentProviderError } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { DocumentFileReader } from "./document-tools.js";
import { documentFromTool } from "./document-tools.js";

const context: AdapterContext = {
  operationId: "documents",
  traceId: "trace",
  userId: "user",
  spaceId: "space",
  runId: "run",
  signal: new AbortController().signal,
};

const files: DocumentFileReader = {
  async read(path) {
    if (path === "missing.pdf") return { error: "could not read the file" };
    return { bytes: new Uint8Array([37, 80, 68, 70]) };
  },
};

function fakeProvider() {
  const calls: { operation: string; request: unknown }[] = [];
  const provider: DocumentProvider = {
    async parse(request: DocumentParseRequest) {
      calls.push({ operation: "parse", request });
      return {
        fileName: request.document.fileName,
        pageCount: 12,
        markdown: "# Report",
        text: "Report",
        ocrApplied: false,
      };
    },
    async extract(request: DocumentExtractRequest) {
      calls.push({ operation: "extract", request });
      return { data: { total: 42 }, fields: [] };
    },
    async classify(request: DocumentClassifyRequest) {
      calls.push({ operation: "classify", request });
      return { units: [], unknownUnits: 0 };
    },
    async split(request: DocumentSplitRequest) {
      calls.push({ operation: "split", request });
      return { segments: [] };
    },
    async locate(request: DocumentLocateRequest) {
      calls.push({ operation: "locate", request });
      return { targets: [] };
    },
  };
  return { provider, calls };
}

describe("documentFromTool", () => {
  it("reads the named file and maps page ranges onto the parse request", async () => {
    const { provider, calls } = fakeProvider();
    const result = await documentFromTool(provider, files, context, "parse", {
      path: "docs/report.pdf",
      page_ranges: [{ start: 2, end: 4 }],
    });
    expect(result).toMatchObject({
      path: "docs/report.pdf",
      pageCount: 12,
      markdown: "# Report",
    });
    const request = calls[0]?.request as DocumentParseRequest;
    expect(request.document.fileName).toBe("report.pdf");
    expect(request.pageRanges).toEqual([{ start: 2, end: 4 }]);
  });

  it("clips long parse output and says how to read the rest", async () => {
    const { provider } = fakeProvider();
    provider.parse = async () => ({
      fileName: "big.pdf",
      pageCount: 90,
      markdown: "x".repeat(25_000),
      text: null,
      ocrApplied: true,
    });
    const result = await documentFromTool(provider, files, context, "parse", {
      path: "big.pdf",
    });
    expect(result).toMatchObject({ path: "big.pdf" });
    if (!("markdown" in result) || typeof result.markdown !== "string")
      throw new Error("expected markdown");
    expect(result.markdown.length).toBe(10_000);
    expect("note" in result && result.note).toContain("page_ranges");
  });

  it("builds the extract schema from the field list", async () => {
    const { provider, calls } = fakeProvider();
    await documentFromTool(provider, files, context, "extract", {
      path: "invoice.pdf",
      fields: [
        {
          name: "total",
          type: "number",
          required: true,
          description: "Invoice total",
        },
        { name: "tags", type: "array", items: "string" },
        { name: "kind", enum: ["sale", "refund"] },
      ],
    });
    const request = calls[0]?.request as DocumentExtractRequest;
    expect(request.schema).toEqual({
      type: "object",
      properties: {
        total: { type: "number", description: "Invoice total" },
        tags: { type: "array", items: { type: "string" } },
        kind: { type: "string", enum: ["sale", "refund"] },
      },
      required: ["total"],
    });
  });

  it("defaults a class id to its label and assigns locate target ids", async () => {
    const { provider, calls } = fakeProvider();
    await documentFromTool(provider, files, context, "classify", {
      path: "scan.pdf",
      classes: [{ label: "Invoice", description: "A supplier invoice" }],
      per_page: true,
    });
    const classify = calls[0]?.request as DocumentClassifyRequest;
    expect(classify.classes).toEqual([
      { id: "Invoice", label: "Invoice", description: "A supplier invoice" },
    ]);
    expect(classify.granularity).toBe("page");
    await documentFromTool(provider, files, context, "locate", {
      path: "scan.pdf",
      targets: [{ text: "Total" }, { id: "supplier", text: "Acme" }],
    });
    const locate = calls[1]?.request as DocumentLocateRequest;
    expect(locate.targets).toEqual([
      { id: "target_1", text: "Total" },
      { id: "supplier", text: "Acme" },
    ]);
  });

  it("rejects malformed calls without reaching the provider", async () => {
    const { provider, calls } = fakeProvider();
    await expect(documentFromTool(provider, files, context, "parse", {})).resolves.toEqual({
      error: "path is required",
    });
    await expect(
      documentFromTool(provider, files, context, "extract", {
        path: "invoice.pdf",
        fields: [{ name: "total" }, { name: "total" }],
      }),
    ).resolves.toEqual({ error: 'duplicate field "total"' });
    await expect(
      documentFromTool(provider, files, context, "classify", {
        path: "scan.pdf",
        classes: [{ label: "Invoice" }, { label: "Invoice" }],
      }),
    ).resolves.toEqual({ error: 'duplicate class id "Invoice"' });
    await expect(
      documentFromTool(provider, files, context, "parse", {
        path: "scan.pdf",
        page_ranges: [{ start: 5, end: 2 }],
      }),
    ).resolves.toEqual({
      error: "page ranges are one-based and inclusive: end must not precede start",
    });
    expect(calls).toHaveLength(0);
  });

  it("surfaces an unreadable file and provider failures as tool errors", async () => {
    const { provider } = fakeProvider();
    await expect(
      documentFromTool(provider, files, context, "parse", {
        path: "missing.pdf",
      }),
    ).resolves.toEqual({
      error: "could not read the file",
      path: "missing.pdf",
    });
    provider.parse = async () => {
      throw new DocumentProviderError("failed", "unsupported_file");
    };
    await expect(
      documentFromTool(provider, files, context, "parse", { path: "scan.pdf" }),
    ).resolves.toEqual({ error: "Document job failed (unsupported_file)" });
  });
});
