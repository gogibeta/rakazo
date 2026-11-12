import type { AdapterContext, AgentUsage } from "./types.js";

/** A document a bot asks the document service to process: the file's name and its bytes. */
export interface DocumentInput {
  fileName: string;
  bytes: Uint8Array;
}

/** One-based, inclusive range of pages. */
export interface DocumentPageRange {
  start: number;
  end: number;
}

/** A caller-defined label a document, or each of its pages, is scored against. */
export interface DocumentClass {
  id: string;
  label: string;
  description?: string;
}

export interface DocumentParseRequest {
  document: DocumentInput;
  pageRanges?: DocumentPageRange[];
}
export interface DocumentParseResult {
  fileName: string;
  pageCount: number | null;
  markdown: string | null;
  text: string | null;
  ocrApplied: boolean | null;
  usage?: AgentUsage;
}

export interface DocumentExtractRequest {
  document: DocumentInput;
  /** JSON Schema (an object root) naming the fields to fill from the document. */
  schema: Record<string, unknown>;
  instructions?: string;
  pageRanges?: DocumentPageRange[];
}
export interface DocumentExtractCitation {
  page: number | null;
  sourceText: string | null;
}
export interface DocumentExtractField {
  path: string;
  value: unknown;
  status: string;
  confidence: number | null;
  citations: DocumentExtractCitation[];
}
export interface DocumentExtractResult {
  data: Record<string, unknown>;
  fields: DocumentExtractField[];
  usage?: AgentUsage;
}

export interface DocumentClassifyRequest {
  document: DocumentInput;
  classes: DocumentClass[];
  /** Score the whole document once, or return one unit per page. */
  granularity?: "document" | "page";
  pageRanges?: DocumentPageRange[];
}
export interface DocumentClassLabel {
  classId: string;
  label: string;
  confidence: number | null;
  reason: string | null;
}
export interface DocumentClassifyUnit {
  pageRange: DocumentPageRange | null;
  unknown: boolean;
  labels: DocumentClassLabel[];
}
export interface DocumentClassifyResult {
  units: DocumentClassifyUnit[];
  unknownUnits: number | null;
  usage?: AgentUsage;
}

export interface DocumentSplitRequest {
  document: DocumentInput;
  classes: DocumentClass[];
  /** Free-text guidance for where one document ends and the next begins. */
  instructions?: string;
  pageRanges?: DocumentPageRange[];
}
export interface DocumentSegment {
  pageRange: DocumentPageRange;
  status: string;
  classId: string | null;
  classLabel: string | null;
  content: string | null;
}
export interface DocumentSplitResult {
  segments: DocumentSegment[];
  usage?: AgentUsage;
}

export interface DocumentLocateTarget {
  id: string;
  text: string;
  hint?: string;
}
export interface DocumentLocateRequest {
  document: DocumentInput;
  targets: DocumentLocateTarget[];
}
export interface DocumentLocateMatch {
  matchedText: string;
  matchMethod: string | null;
  page: number | null;
  location: Record<string, unknown>;
}
export interface DocumentLocateTargetResult {
  id: string;
  status: string;
  matches: DocumentLocateMatch[];
}
export interface DocumentLocateResult {
  targets: DocumentLocateTargetResult[];
  usage?: AgentUsage;
}

/**
 * Document understanding behind one provider: read a file as Markdown, fill a
 * schema from it, label it, split a packet into its documents, and locate
 * quoted text. Callers own the files and the policy applied to a result.
 */
export interface DocumentProvider {
  parse(request: DocumentParseRequest, context: AdapterContext): Promise<DocumentParseResult>;
  extract(request: DocumentExtractRequest, context: AdapterContext): Promise<DocumentExtractResult>;
  classify(
    request: DocumentClassifyRequest,
    context: AdapterContext,
  ): Promise<DocumentClassifyResult>;
  split(request: DocumentSplitRequest, context: AdapterContext): Promise<DocumentSplitResult>;
  locate(request: DocumentLocateRequest, context: AdapterContext): Promise<DocumentLocateResult>;
}

export interface DocumentProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
}

export class DocumentProviderError extends Error {
  constructor(
    readonly kind:
      | "authentication"
      | "invalid"
      | "invalid_response"
      | "busy"
      | "unavailable"
      | "failed",
    /** The provider's own code for a job that ran and failed, when it gave one. */
    readonly code?: string,
  ) {
    super(
      kind === "failed" && code
        ? `Document job failed (${code})`
        : "Document provider could not complete the request",
    );
  }
}
