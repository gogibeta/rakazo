import type {
  AdapterContext,
  DocumentClass,
  DocumentLocateTarget,
  DocumentPageRange,
  DocumentProvider,
} from "@rakazo/adapter-kit";

export type DocumentOperation = "parse" | "extract" | "classify" | "split" | "locate";

/** The most bytes a document tool sends in one call; larger files upload in parts, which the tools do not do. */
export const DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;

/** Tool results stay within the runtime's text limit, so long output is clipped, never cut mid-JSON. */
const MAX_TEXT_CHARS = 10_000;
const MAX_SEGMENT_CHARS = 1_500;

/** Reads a workspace file the model named; the run's own file access owns the sandbox. */
export interface DocumentFileReader {
  read(path: string): Promise<{ bytes: Uint8Array } | { error: string }>;
}

/**
 * Runs one document builtin tool against the deployment's document provider.
 * The bot names a workspace file and the operation's inputs; the file is read
 * by the caller, sent to the provider, and the structured result comes back.
 */
export async function documentFromTool(
  documents: DocumentProvider,
  files: DocumentFileReader,
  context: AdapterContext,
  operation: DocumentOperation,
  args: Record<string, unknown>,
) {
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return { error: "path is required" };
  const read = await files.read(path);
  if ("error" in read) return { error: read.error, path };
  const document = { fileName: fileNameOf(path), bytes: read.bytes };
  const pageRanges = parsePageRanges(args.page_ranges);
  if ("error" in pageRanges) return pageRanges;
  try {
    switch (operation) {
      case "parse": {
        const result = await documents.parse({ document, pageRanges: pageRanges.value }, context);
        const markdown = clip(result.markdown, MAX_TEXT_CHARS);
        const text = result.markdown === null ? clip(result.text, MAX_TEXT_CHARS) : undefined;
        return {
          path,
          pageCount: result.pageCount,
          ocrApplied: result.ocrApplied,
          markdown: markdown.value,
          ...(text ? { text: text.value } : {}),
          ...(markdown.clipped || text?.clipped
            ? {
                note: "Output clipped. Call again with page_ranges to read the rest.",
              }
            : {}),
        };
      }
      case "extract": {
        const schema = parseExtractSchema(args.fields);
        if ("error" in schema) return schema;
        const result = await documents.extract(
          {
            document,
            schema: schema.value,
            instructions: stringArg(args.instructions),
            pageRanges: pageRanges.value,
          },
          context,
        );
        return { path, data: result.data, fields: result.fields };
      }
      case "classify": {
        const classes = parseClasses(args.classes);
        if ("error" in classes) return classes;
        const result = await documents.classify(
          {
            document,
            classes: classes.value,
            granularity: args.per_page === true ? "page" : "document",
            pageRanges: pageRanges.value,
          },
          context,
        );
        return { path, units: result.units, unknownUnits: result.unknownUnits };
      }
      case "split": {
        const classes = parseClasses(args.classes);
        if ("error" in classes) return classes;
        const result = await documents.split(
          {
            document,
            classes: classes.value,
            instructions: stringArg(args.instructions),
            pageRanges: pageRanges.value,
          },
          context,
        );
        return {
          path,
          segments: result.segments.map((segment) => ({
            ...segment,
            content:
              segment.content === null ? null : clip(segment.content, MAX_SEGMENT_CHARS).value,
          })),
        };
      }
      case "locate": {
        const targets = parseTargets(args.targets);
        if ("error" in targets) return targets;
        const result = await documents.locate({ document, targets: targets.value }, context);
        return { path, targets: result.targets };
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function fileNameOf(path: string): string {
  const name = path.split("/").filter(Boolean).at(-1);
  return name ?? "document";
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clip(value: string | null, max: number): { value: string | null; clipped: boolean } {
  if (value === null || value.length <= max) return { value, clipped: false };
  return { value: value.slice(0, max), clipped: true };
}

function parsePageRanges(
  raw: unknown,
): { value: DocumentPageRange[] | undefined } | { error: string } {
  if (raw === undefined || raw === null) return { value: undefined };
  if (!Array.isArray(raw) || !raw.length)
    return { error: "page_ranges must be a non-empty array of { start, end }" };
  if (raw.length > 200) return { error: "at most 200 page ranges per call" };
  const ranges: DocumentPageRange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { error: "each page range must be an object" };
    const { start, end } = item as Record<string, unknown>;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start
    )
      return {
        error: "page ranges are one-based and inclusive: end must not precede start",
      };
    ranges.push({ start, end });
  }
  return { value: ranges };
}

/** Classes are labels with optional ids and descriptions; the label doubles as the id. */
function parseClasses(raw: unknown): { value: DocumentClass[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: "classes are required" };
  if (raw.length > 20) return { error: "at most 20 classes per call" };
  const classes: DocumentClass[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") return { error: "each class must be an object" };
    const { id, label, description } = item as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim()) return { error: "each class needs a label" };
    const classId = typeof id === "string" && id.trim() ? id.trim() : label.trim();
    if (classId.includes("/")) return { error: `class id "${classId}" must not contain "/"` };
    if (seen.has(classId)) return { error: `duplicate class id "${classId}"` };
    seen.add(classId);
    classes.push({
      id: classId,
      label: label.trim(),
      ...(typeof description === "string" && description.trim()
        ? { description: description.trim() }
        : {}),
    });
  }
  return { value: classes };
}

const FIELD_TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;

/** The model's field list becomes the JSON Schema the extract call fills. */
function parseExtractSchema(raw: unknown): { value: Record<string, unknown> } | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: "fields are required" };
  if (raw.length > 50) return { error: "at most 50 fields per call" };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { error: "each field must be an object" };
    const {
      name,
      type,
      description,
      required: isRequired,
      enum: values,
      items,
    } = item as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) return { error: "each field needs a name" };
    if (Object.hasOwn(properties, name)) return { error: `duplicate field "${name}"` };
    const fieldType = type === undefined ? "string" : type;
    if (typeof fieldType !== "string" || !(FIELD_TYPES as readonly string[]).includes(fieldType))
      return { error: `field "${name}" has an unsupported type` };
    const property: Record<string, unknown> = { type: fieldType };
    if (typeof description === "string" && description.trim())
      property.description = description.trim();
    if (values !== undefined) {
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.some((value) => !["string", "number", "boolean"].includes(typeof value))
      )
        return {
          error: `field "${name}" enum must be a non-empty array of values`,
        };
      property.enum = values;
    }
    if (items !== undefined) {
      if (
        fieldType !== "array" ||
        typeof items !== "string" ||
        !(FIELD_TYPES as readonly string[]).includes(items) ||
        items === "array" ||
        items === "object"
      )
        return {
          error: `field "${name}" items must name the element type of an array field`,
        };
      property.items = { type: items };
    }
    properties[name] = property;
    if (isRequired === true) required.push(name);
  }
  return {
    value: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    },
  };
}

function parseTargets(raw: unknown): { value: DocumentLocateTarget[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: "targets are required" };
  if (raw.length > 30) return { error: "at most 30 targets per call" };
  const targets: DocumentLocateTarget[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object") return { error: "each target must be an object" };
    const { id, text, hint } = item as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim())
      return { error: "each target needs the text to find" };
    const targetId = typeof id === "string" && id.trim() ? id.trim() : `target_${index + 1}`;
    if (seen.has(targetId)) return { error: `duplicate target id "${targetId}"` };
    seen.add(targetId);
    targets.push({
      id: targetId,
      text: text.trim(),
      ...(typeof hint === "string" && hint.trim() ? { hint: hint.trim() } : {}),
    });
  }
  return { value: targets };
}
