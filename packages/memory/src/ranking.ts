import { stem } from "./stem.js";
import type { TermExpansion } from "./synonyms.js";
import { synonymExpansions } from "./synonyms.js";

/**
 * How one document is scored for a search, in process over its decrypted
 * text (the database only ever holds ciphertext, so no SQL index can rank
 * memory content). Two channels fuse into the returned score:
 *
 * - the document channel is the phase-1 score unchanged — stemmed term
 *   frequency over the whole document, length-normalised, plus the verbatim
 *   bonus — and it stays in the blend so a document phase 1 returned can
 *   never drop out of phase 2's results;
 * - the chunk channel scores the document's best chunk (see chunkContent)
 *   with the same shape, so a term concentrated in one section is not
 *   diluted by the rest of a long document. Inside a chunk a query term is
 *   covered by a direct stemmed hit, by a curated synonym (synonyms.ts) at
 *   a flat reduced credit, or by a character-trigram near-match that
 *   tolerates a typo. Synonym and fuzzy coverage only ever flow through
 *   this reduced-weight channel, so they rank below direct hits.
 */

/** The chunk channel's weight in the fused score; the document channel dominates. */
const CHUNK_WEIGHT = 0.6;
/** Flat credit for a query term a chunk covers only through a synonym. */
const SYNONYM_CREDIT = 0.5;
/** Trigram Dice similarity a stem must reach to count as a typo of a query term. */
const FUZZY_THRESHOLD = 0.55;
/** Shorter words are too easily near-matched by chance to fuzz. */
const FUZZY_MIN_LENGTH = 4;
/** Paragraph-packed chunks cap near this many characters. */
const MAX_CHUNK_CHARS = 1200;

/**
 * Words of a text, with the same normalisation the content blind index uses
 * (NFKC, lowercased, runs of letters and digits): "notes/q3-report.pdf"
 * tokenises into words, and a hyphenated identifier into its parts.
 */
export function tokenize(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * Relevance of one document to a search, or undefined when it does not match.
 * A document matches when every query term appears among its stemmed words
 * (content or path) — or when the query appears verbatim, so an exact phrase
 * or identifier hits even if tokenising splits it differently on each side.
 * The score is the matched terms' frequency, dampened by document length,
 * plus a flat bonus for a verbatim hit: in the content first, then the path.
 */
export function scoreDocument(
  doc: { path: string; content: string },
  terms: string[],
  queryLower: string,
): number | undefined {
  const contentHit = doc.content.toLowerCase().includes(queryLower);
  const pathHit = doc.path.toLowerCase().includes(queryLower);
  if (!terms.length) return contentHit ? 1 : pathHit ? 0.5 : undefined;
  const frequencies = new Map<string, number>();
  const contentWords = tokenize(doc.content).map(stem);
  for (const word of contentWords) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  for (const word of tokenize(doc.path).map(stem))
    frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  let frequency = 0;
  for (const term of terms) {
    const count = frequencies.get(term) ?? 0;
    if (count === 0 && !contentHit && !pathHit) return undefined;
    frequency += count;
  }
  return (
    frequency / Math.sqrt(Math.max(1, contentWords.length)) +
    (contentHit ? 1 : 0) +
    (pathHit ? 0.5 : 0)
  );
}

/**
 * A document's fused phase-2 score, or undefined when neither channel
 * matches. The document channel anchors recall (see the header); the chunk
 * channel adds the best chunk's score at a reduced weight.
 */
export function scoreDocumentFused(
  doc: { path: string; content: string },
  terms: string[],
  queryLower: string,
): number | undefined {
  const base = scoreDocument(doc, terms, queryLower);
  if (!terms.length) return base;
  const expansions = synonymExpansions(terms);
  const pathStems = tokenize(doc.path).map(stem);
  let bestChunk: number | undefined;
  for (const chunkText of chunkContent(doc.content)) {
    const stems = tokenize(chunkText).map(stem);
    const frequencies = new Map<string, number>();
    for (const word of stems) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    for (const word of pathStems) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    const score = scoreChunk({ stems, frequencies }, terms, expansions, queryLower, chunkText);
    if (score !== undefined && (bestChunk === undefined || score > bestChunk)) bestChunk = score;
  }
  if (base === undefined && bestChunk === undefined) return undefined;
  return (base ?? 0) + CHUNK_WEIGHT * (bestChunk ?? 0);
}

interface ChunkIndex {
  /** The chunk's stemmed words in order (content only; phrases match against this). */
  stems: string[];
  /** Stem frequencies over the chunk's content plus the document's path, as phase 1 counts a document. */
  frequencies: Map<string, number>;
}

/**
 * One chunk's score, shaped like scoreDocument at chunk scale, or undefined
 * when the chunk does not cover every query term and holds no verbatim hit.
 * Coverage per term, best first: the term's own frequency, a flat synonym
 * credit, or its trigram similarity to the closest chunk stem.
 */
function scoreChunk(
  chunk: ChunkIndex,
  terms: string[],
  expansions: TermExpansion[],
  queryLower: string,
  chunkText: string,
): number | undefined {
  const verbatim = chunkText.toLowerCase().includes(queryLower);
  let credits = 0;
  let covered = true;
  for (let i = 0; i < terms.length; i += 1) {
    const term = terms[i]!;
    const direct = chunk.frequencies.get(term) ?? 0;
    if (direct > 0) {
      credits += direct;
      continue;
    }
    if (synonymHit(expansions[i]!, chunk)) {
      credits += SYNONYM_CREDIT;
      continue;
    }
    const fuzzy = fuzzySimilarity(term, chunk.frequencies);
    if (fuzzy !== undefined) {
      credits += fuzzy;
      continue;
    }
    covered = false;
  }
  if (!covered && !verbatim) return undefined;
  return credits / Math.sqrt(Math.max(1, chunk.stems.length)) + (verbatim ? 1 : 0);
}

function synonymHit(expansion: TermExpansion, chunk: ChunkIndex): boolean {
  for (const candidate of expansion.stems) if (chunk.frequencies.has(candidate)) return true;
  for (const phrase of expansion.phrases) if (containsSequence(chunk.stems, phrase)) return true;
  return false;
}

function containsSequence(stems: string[], phrase: readonly string[]): boolean {
  outer: for (let start = 0; start + phrase.length <= stems.length; start += 1) {
    for (let offset = 0; offset < phrase.length; offset += 1)
      if (stems[start + offset] !== phrase[offset]) continue outer;
    return true;
  }
  return false;
}

/**
 * The best trigram similarity between a query term and the chunk's distinct
 * stems, when it reaches the fuzzy threshold. Only called for terms with no
 * direct or synonym cover, against one small chunk vocabulary at a time.
 */
function fuzzySimilarity(term: string, frequencies: Map<string, number>): number | undefined {
  if (term.length < FUZZY_MIN_LENGTH) return undefined;
  const termGrams = trigrams(term);
  let best = 0;
  for (const candidate of frequencies.keys()) {
    if (candidate.length < FUZZY_MIN_LENGTH || candidate === term) continue;
    const candidateGrams = trigrams(candidate);
    let shared = 0;
    for (const gram of termGrams) if (candidateGrams.has(gram)) shared += 1;
    const similarity = (2 * shared) / (termGrams.size + candidateGrams.size);
    if (similarity > best) best = similarity;
  }
  return best >= FUZZY_THRESHOLD ? best : undefined;
}

/** Character trigrams of a word padded with two spaces at each end. */
function trigrams(word: string): Set<string> {
  const padded = `  ${word}  `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
}

/**
 * A document's chunks: one per markdown heading section, heading line
 * included, with the text before the first heading as its own section. A
 * section longer than the cap is packed from its paragraphs instead, and a
 * single over-long paragraph is split at word boundaries — so heading-less
 * documents chunk by paragraph blocks. Empty chunks are dropped.
 */
export function chunkContent(content: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of content.split("\n")) {
    if (/^#{1,6}\s/.test(line) && current.length) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) sections.push(current.join("\n"));
  const chunks: string[] = [];
  for (const section of sections) chunks.push(...packParagraphs(section));
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

function packParagraphs(section: string): string[] {
  if (section.length <= MAX_CHUNK_CHARS) return [section];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };
  for (const paragraph of section.split(/\n\s*\n/)) {
    if (paragraph.length > MAX_CHUNK_CHARS) {
      flush();
      chunks.push(...splitLong(paragraph));
    } else if (current && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
      flush();
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  flush();
  return chunks;
}

function splitLong(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHUNK_CHARS) {
    let cut = rest.lastIndexOf(" ", MAX_CHUNK_CHARS);
    if (cut < MAX_CHUNK_CHARS / 2) cut = MAX_CHUNK_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
