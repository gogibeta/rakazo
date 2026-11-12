import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentUsage,
  DocumentClassifyRequest,
  DocumentClassifyResult,
  DocumentExtractRequest,
  DocumentExtractResult,
  DocumentInput,
  DocumentLocateRequest,
  DocumentLocateResult,
  DocumentPageRange,
  DocumentParseRequest,
  DocumentParseResult,
  DocumentProvider,
  DocumentProviderOptions,
  DocumentSplitRequest,
  DocumentSplitResult,
} from "@rakazo/adapter-kit";
import { DocumentProviderError } from "@rakazo/adapter-kit";
import { z } from "zod";
import { readBodyCapped } from "./web-ssrf.js";

const BASE_URL = "https://console.nace.ai/v1";
/** Document jobs are billed per page and can take minutes; the SDK waits up to 600 s. */
const DEFAULT_POLL_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** A finished job carries its whole result; large documents return a preview plus a link. */
const MAX_JOB_BODY_BYTES = 16_000_000;

const jobErrorSchema = z
  .object({ code: z.string().optional(), message: z.string().optional() })
  .passthrough();
const jobSchema = z
  .object({
    job_id: z.string(),
    status: z.string(),
    result: z.unknown().optional(),
    error: jobErrorSchema.nullable().optional(),
    cost: z
      .object({ total_usd: z.union([z.string(), z.number()]).optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
type DocumentJob = z.infer<typeof jobSchema>;

const grantSchema = z.object({ upload_url: z.string(), token: z.string() }).passthrough();
const uploadedFileSchema = z
  .object({ workspace_id: z.string(), file_id: z.string() })
  .passthrough();
const uploadResponseSchema = z
  .object({
    job_id: z.string().optional(),
    status: z.string().optional(),
    result: z.object({ file: uploadedFileSchema }).passthrough().nullable().optional(),
  })
  .passthrough();

const parseResultSchema = z
  .object({
    file_name: z.string().optional(),
    document: z
      .object({
        page_count: z.number().nullable().optional(),
        markdown: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
      })
      .passthrough(),
    ocr_applied: z.boolean().nullable().optional(),
  })
  .passthrough();

const extractResultSchema = z
  .object({
    data: z.record(z.string(), z.unknown()),
    fields: z.array(
      z
        .object({
          path: z.string(),
          value: z.unknown(),
          status: z.string(),
          confidence: z.number().nullable().optional(),
          citations: z
            .array(
              z
                .object({
                  location: z
                    .object({ page: z.number().nullable().optional() })
                    .passthrough()
                    .nullable()
                    .optional(),
                  source_text: z.string().nullable().optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const classifyResultSchema = z
  .object({
    units: z.array(
      z
        .object({
          page_range: z
            .object({ start: z.number(), end: z.number() })
            .passthrough()
            .nullable()
            .optional(),
          unknown: z.boolean().optional(),
          labels: z.array(
            z
              .object({
                class_id: z.string(),
                label: z.string(),
                confidence: z.number().nullable().optional(),
                reason: z.string().nullable().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
    unknown_units: z.number().nullable().optional(),
  })
  .passthrough();

const splitResultSchema = z
  .object({
    segments: z.array(
      z
        .object({
          start_page: z.number(),
          end_page: z.number(),
          status: z.string(),
          class: z
            .object({ id: z.string(), label: z.string() })
            .passthrough()
            .nullable()
            .optional(),
          content: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const groundResultSchema = z
  .object({
    targets: z.array(
      z
        .object({
          id: z.string(),
          status: z.string(),
          matches: z.array(
            z
              .object({
                matched_text: z.string(),
                match_method: z.string().nullable().optional(),
                location: z.record(z.string(), z.unknown()),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

type UploadedSource = { workspaceId: string; fileId: string };

function errorKindForStatus(status: number): DocumentProviderError["kind"] {
  if (status === 401 || status === 403) return "authentication";
  if (status === 422) return "invalid";
  if (status === 429 || status === 529) return "busy";
  return "unavailable";
}

function pageRangesBody(ranges: DocumentPageRange[] | undefined) {
  return ranges?.length
    ? { page_ranges: ranges.map((range) => ({ start: range.start, end: range.end })) }
    : {};
}

function classesBody(classes: DocumentClassifyRequest["classes"]) {
  return classes.map((entry) => ({
    id: entry.id,
    label: entry.label,
    ...(entry.description ? { description: entry.description } : {}),
  }));
}

function jobUsage(job: DocumentJob): AgentUsage | undefined {
  if (!job.cost) return undefined;
  const cost = job.cost.total_usd === undefined ? null : Number(job.cost.total_usd);
  return {
    inputTokens: null,
    outputTokens: null,
    costUsd: cost !== null && Number.isFinite(cost) ? cost : null,
    costSource: job.cost.total_usd === undefined ? null : "provider-reported",
    providerRequestId: job.job_id,
    usageSource: "response",
    operationKind: "retrieval",
  };
}

/**
 * The Nace Perception document service: each call uploads the file, starts an
 * async job, polls it to a terminal status, and deletes the upload afterwards.
 * Endpoint and auth never come from model output.
 */
export class HttpDocumentProvider implements DocumentProvider {
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(
    private readonly options: DocumentProviderOptions & {
      pollIntervalMs?: number;
      pollTimeoutMs?: number;
    },
  ) {
    if (!options.apiKey.trim()) throw new DocumentProviderError("authentication");
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  async parse(
    request: DocumentParseRequest,
    context: AdapterContext,
  ): Promise<DocumentParseResult> {
    const { job, result } = await this.runJob(
      "parse",
      request.document,
      {
        output: { formats: ["markdown", "text"] },
        ...pageRangesBody(request.pageRanges),
      },
      context,
    );
    const parsed = this.parseResult(parseResultSchema, result);
    return {
      fileName: parsed.file_name ?? request.document.fileName,
      pageCount: parsed.document.page_count ?? null,
      markdown: parsed.document.markdown ?? null,
      text: parsed.document.text ?? null,
      ocrApplied: parsed.ocr_applied ?? null,
      usage: jobUsage(job),
    };
  }

  async extract(
    request: DocumentExtractRequest,
    context: AdapterContext,
  ): Promise<DocumentExtractResult> {
    const { job, result } = await this.runJob(
      "extract",
      request.document,
      {
        schema: request.schema,
        ...(request.instructions ? { instructions: request.instructions } : {}),
        ...pageRangesBody(request.pageRanges),
      },
      context,
    );
    const parsed = this.parseResult(extractResultSchema, result);
    return {
      data: parsed.data,
      fields: parsed.fields.map((field) => ({
        path: field.path,
        value: field.value,
        status: field.status,
        confidence: field.confidence ?? null,
        citations: (field.citations ?? []).map((citation) => ({
          page: citation.location?.page ?? null,
          sourceText: citation.source_text ?? null,
        })),
      })),
      usage: jobUsage(job),
    };
  }

  async classify(
    request: DocumentClassifyRequest,
    context: AdapterContext,
  ): Promise<DocumentClassifyResult> {
    const { job, result } = await this.runJob(
      "classify",
      request.document,
      {
        classes: classesBody(request.classes),
        ...(request.granularity ? { granularity: request.granularity } : {}),
        ...pageRangesBody(request.pageRanges),
      },
      context,
    );
    const parsed = this.parseResult(classifyResultSchema, result);
    return {
      units: parsed.units.map((unit) => ({
        pageRange: unit.page_range ?? null,
        unknown: unit.unknown ?? false,
        labels: unit.labels.map((label) => ({
          classId: label.class_id,
          label: label.label,
          confidence: label.confidence ?? null,
          reason: label.reason ?? null,
        })),
      })),
      unknownUnits: parsed.unknown_units ?? null,
      usage: jobUsage(job),
    };
  }

  async split(
    request: DocumentSplitRequest,
    context: AdapterContext,
  ): Promise<DocumentSplitResult> {
    const { job, result } = await this.runJob(
      "split",
      request.document,
      {
        classes: classesBody(request.classes),
        ...(request.instructions ? { split_rules: request.instructions } : {}),
        output: { include_content: true },
        ...pageRangesBody(request.pageRanges),
      },
      context,
    );
    const parsed = this.parseResult(splitResultSchema, result);
    return {
      segments: parsed.segments.map((segment) => ({
        pageRange: { start: segment.start_page, end: segment.end_page },
        status: segment.status,
        classId: segment.class?.id ?? null,
        classLabel: segment.class?.label ?? null,
        content: segment.content ?? null,
      })),
      usage: jobUsage(job),
    };
  }

  async locate(
    request: DocumentLocateRequest,
    context: AdapterContext,
  ): Promise<DocumentLocateResult> {
    const { job, result } = await this.runJob(
      "ground",
      request.document,
      {
        targets: request.targets.map((target) => ({
          id: target.id,
          text: target.text,
          ...(target.hint ? { hint: target.hint } : {}),
        })),
      },
      context,
    );
    const parsed = this.parseResult(groundResultSchema, result);
    return {
      targets: parsed.targets.map((target) => ({
        id: target.id,
        status: target.status,
        matches: target.matches.map((match) => ({
          matchedText: match.matched_text,
          matchMethod: match.match_method ?? null,
          page: typeof match.location.page === "number" ? match.location.page : null,
          location: match.location,
        })),
      })),
      usage: jobUsage(job),
    };
  }

  /** Upload, create, wait, and clean up: one document operation end to end. */
  private async runJob(
    operation: string,
    document: DocumentInput,
    body: Record<string, unknown>,
    context: AdapterContext,
  ): Promise<{ job: DocumentJob; result: unknown }> {
    context.signal.throwIfAborted();
    try {
      const source = await this.upload(document, context);
      try {
        const created = await this.createJob(
          operation,
          { ...body, source: sourceBody(source) },
          context,
        );
        const job = await this.awaitJob(created, context);
        if (job.result === undefined || job.result === null)
          throw new DocumentProviderError("invalid_response");
        return { job, result: job.result };
      } finally {
        await this.deleteUpload(source, context).catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof DocumentProviderError) throw error;
      if (context.signal.aborted) throw error;
      // Transport and validation errors can contain credentials or document content.
      throw new DocumentProviderError("unavailable");
    }
  }

  private async upload(document: DocumentInput, context: AdapterContext): Promise<UploadedSource> {
    // A caller-minted path per upload, so runs never collide at one path.
    const path = `${randomUUID()}/${document.fileName}`;
    const grant = await this.requestJson(
      `${BASE_URL}/documents/upload-grants`,
      { method: "POST", body: JSON.stringify({ path, ttl_seconds: 600 }) },
      context,
      grantSchema,
      64_000,
    );
    const form = new FormData();
    form.append(
      "file",
      new Blob([document.bytes as BlobPart], { type: "application/octet-stream" }),
      document.fileName,
    );
    form.append("metadata", JSON.stringify({ path, total_size_bytes: document.bytes.byteLength }));
    const response = await this.send(
      grant.upload_url,
      {
        method: "POST",
        headers: { "X-Upload-Token": grant.token },
        body: form,
      },
      context,
      false,
    );
    const uploaded = this.parseResult(
      uploadResponseSchema,
      await this.readJson(response, context, MAX_JOB_BODY_BYTES),
    );
    if (uploaded.result?.file)
      return {
        workspaceId: uploaded.result.file.workspace_id,
        fileId: uploaded.result.file.file_id,
      };
    if (uploaded.job_id) {
      const job = await this.awaitJob(
        { job_id: uploaded.job_id, status: uploaded.status ?? "queued" },
        context,
      );
      const file = uploadedFileSchema.safeParse(
        (job.result as { file?: unknown } | null | undefined)?.file,
      );
      if (file.success) return { workspaceId: file.data.workspace_id, fileId: file.data.file_id };
    }
    throw new DocumentProviderError("invalid_response");
  }

  private async createJob(
    operation: string,
    body: Record<string, unknown>,
    context: AdapterContext,
  ): Promise<DocumentJob> {
    return this.requestJson(
      `${BASE_URL}/documents/${operation}?wait_seconds=60`,
      {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify(body),
      },
      context,
      jobSchema,
      MAX_JOB_BODY_BYTES,
    );
  }

  private async getJob(jobId: string, context: AdapterContext): Promise<DocumentJob> {
    return this.requestJson(
      `${BASE_URL}/documents/jobs/${jobId}`,
      { method: "GET" },
      context,
      jobSchema,
      MAX_JOB_BODY_BYTES,
    );
  }

  /** Poll a job the create call left running until it succeeds, fails, or the wait runs out. */
  private async awaitJob(job: DocumentJob, context: AdapterContext): Promise<DocumentJob> {
    let current = job;
    const deadline = Date.now() + this.pollTimeoutMs;
    while (current.status === "queued" || current.status === "running") {
      if (Date.now() > deadline) throw new DocumentProviderError("unavailable");
      await this.sleep(context);
      current = await this.getJob(current.job_id, context);
    }
    if (current.status === "failed" || current.status === "cancelled")
      throw new DocumentProviderError("failed", current.error?.code);
    if (current.status !== "succeeded") throw new DocumentProviderError("invalid_response");
    return current;
  }

  private async deleteUpload(source: UploadedSource, context: AdapterContext): Promise<void> {
    const response = await this.send(
      `${BASE_URL}/documents/workspaces/${source.workspaceId}/files/${source.fileId}`,
      { method: "DELETE" },
      context,
      true,
    );
    void response.body?.cancel().catch(() => undefined);
  }

  private sleep(context: AdapterContext): Promise<void> {
    return new Promise((resolve, reject) => {
      if (context.signal.aborted) {
        reject(context.signal.reason ?? new Error("aborted"));
        return;
      }
      const timer = setTimeout(resolve, this.pollIntervalMs);
      context.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(context.signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  }

  private async requestJson<T>(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    context: AdapterContext,
    schema: z.ZodType<T>,
    maxBytes: number,
  ): Promise<T> {
    const response = await this.send(url, init, context, true);
    return this.parseResult(schema, await this.readJson(response, context, maxBytes));
  }

  private async readJson(
    response: Response,
    context: AdapterContext,
    maxBytes: number,
  ): Promise<unknown> {
    try {
      return JSON.parse(
        new TextDecoder().decode(await readBodyCapped(response, maxBytes, context.signal)),
      ) as unknown;
    } catch {
      throw new DocumentProviderError("invalid_response");
    }
  }

  private parseResult<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new DocumentProviderError("invalid_response");
    return parsed.data;
  }

  private async send(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string | FormData },
    context: AdapterContext,
    authenticated: boolean,
  ): Promise<Response> {
    const response = await (this.options.fetch ?? fetch)(url, {
      method: init.method,
      redirect: "error",
      signal: context.signal,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
        Accept: "application/json",
        ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body,
    }).catch((error: unknown) => {
      if (context.signal.aborted) throw error;
      throw new DocumentProviderError("unavailable");
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new DocumentProviderError(errorKindForStatus(response.status));
    }
    return response;
  }
}

function sourceBody(source: UploadedSource) {
  return { type: "workspace_file", workspace_id: source.workspaceId, file_id: source.fileId };
}
