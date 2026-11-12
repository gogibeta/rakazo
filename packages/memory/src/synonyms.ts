import { stem } from "./stem.js";

/**
 * A small, hand-curated synonym dictionary for memory search. Each group
 * lists words (and two-word phrases) a person plausibly means interchangeably
 * in their notes; when a query uses one member, the others may stand in for
 * it at a reduced score. The list is deterministic and fixed in code — it is
 * not learned, not an embedding, and not semantic understanding: a topic the
 * list does not name gets no expansion. Groups stay tight on purpose; a
 * loose group would trade precision for recall nobody asked for.
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["budget", "spending", "spend limit", "expenses"],
  ["meeting", "standup", "sync"],
  ["deadline", "due date"],
  ["vacation", "holiday", "time off"],
  ["hiring", "recruiting", "recruitment"],
  ["deployment", "deploy", "release", "rollout"],
];

/** What may stand in for one query term: single stems, or whole phrases. */
export interface TermExpansion {
  stems: ReadonlySet<string>;
  phrases: readonly (readonly string[])[];
}

interface SynonymGroup {
  singles: ReadonlySet<string>;
  phrases: readonly (readonly string[])[];
}

function buildGroup(members: readonly string[]): SynonymGroup {
  const singles = new Set<string>();
  const phrases: string[][] = [];
  for (const member of members) {
    const words = member.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const stems = words.map(stem);
    if (stems.length === 1) singles.add(stems[0]!);
    else if (stems.length > 1) phrases.push(stems);
  }
  return { singles, phrases };
}

const GROUPS: readonly SynonymGroup[] = SYNONYM_GROUPS.map(buildGroup);

/**
 * The expansion for every stemmed query term, in order. A term earns its
 * group's expansion when the term is one of the group's single words, and a
 * two-word member typed in full ("spend limit", "due date") links both of
 * its words to the group, so the group's other members can cover either.
 * Terms in no group get an empty expansion.
 */
export function synonymExpansions(terms: readonly string[]): TermExpansion[] {
  const stems: Set<string>[] = terms.map(() => new Set<string>());
  const phrases: (readonly string[])[][] = terms.map(() => []);
  const addGroup = (index: number, group: SynonymGroup) => {
    for (const single of group.singles) stems[index]!.add(single);
    phrases[index]!.push(...group.phrases);
  };
  terms.forEach((term, index) => {
    for (const group of GROUPS) if (group.singles.has(term)) addGroup(index, group);
  });
  for (let i = 0; i + 1 < terms.length; i += 1) {
    for (const group of GROUPS) {
      for (const phrase of group.phrases) {
        if (phrase.length === 2 && phrase[0] === terms[i] && phrase[1] === terms[i + 1]) {
          addGroup(i, group);
          addGroup(i + 1, group);
        }
      }
    }
  }
  return terms.map((_, index) => ({ stems: stems[index]!, phrases: phrases[index]! }));
}
