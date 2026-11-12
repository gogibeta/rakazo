/**
 * The Porter stemming algorithm (Porter, 1980), the same stemming the
 * 'english' text-search configuration approximates. Memory search stems in
 * process because memory content is sealed at rest: the database only ever
 * holds ciphertext, so the store ranks the decrypted documents itself and
 * both the documents and the query pass through this one stemmer.
 */

function isConsonant(word: string, index: number): boolean {
  const char = word[index]!;
  if ("aeiou".includes(char)) return false;
  if (char === "y") return index === 0 ? true : !isConsonant(word, index - 1);
  return true;
}

/** The measure m of [C](VC)^m[V]: how many vowel-consonant sequences follow the leading consonants. */
function measure(word: string): number {
  let m = 0;
  let i = 0;
  while (i < word.length && isConsonant(word, i)) i += 1;
  while (i < word.length) {
    while (i < word.length && !isConsonant(word, i)) i += 1;
    if (i >= word.length) break;
    m += 1;
    while (i < word.length && isConsonant(word, i)) i += 1;
  }
  return m;
}

function hasVowel(word: string): boolean {
  for (let i = 0; i < word.length; i += 1) if (!isConsonant(word, i)) return true;
  return false;
}

function endsDoubleConsonant(word: string): boolean {
  const n = word.length;
  return n >= 2 && word[n - 1] === word[n - 2] && isConsonant(word, n - 1);
}

function endsCvc(word: string): boolean {
  const n = word.length;
  if (n < 3) return false;
  return (
    isConsonant(word, n - 3) &&
    !isConsonant(word, n - 2) &&
    isConsonant(word, n - 1) &&
    !"wxy".includes(word[n - 1]!)
  );
}

function replaceSuffix(word: string, suffix: string, replacement: string): string {
  return word.slice(0, word.length - suffix.length) + replacement;
}

/** Longest listed suffix the word ends with, or undefined. */
function longestSuffix(word: string, suffixes: string[]): string | undefined {
  let best: string | undefined;
  for (const suffix of suffixes)
    if (word.endsWith(suffix) && (!best || suffix.length > best.length)) best = suffix;
  return best;
}

const STEP2: Record<string, string> = {
  ational: "ate",
  tional: "tion",
  enci: "ence",
  anci: "ance",
  izer: "ize",
  bli: "ble",
  alli: "al",
  entli: "ent",
  eli: "e",
  ousli: "ous",
  ization: "ize",
  ation: "ate",
  ator: "ate",
  alism: "al",
  iveness: "ive",
  fulness: "ful",
  ousness: "ous",
  aliti: "al",
  iviti: "ive",
  biliti: "ble",
  logi: "log",
};

const STEP3: Record<string, string> = {
  icate: "ic",
  ative: "",
  alize: "al",
  iciti: "ic",
  ical: "ic",
  ful: "",
  ness: "",
};

const STEP4 = [
  "al",
  "ance",
  "ence",
  "er",
  "ic",
  "able",
  "ible",
  "ant",
  "ement",
  "ment",
  "ent",
  "ion",
  "ou",
];

/** Stem one already-normalised word (lowercase letters/digits, as tokenize produces). */
export function stem(word: string): string {
  if (word.length <= 2) return word;
  let w = word;

  // Step 1a: plurals.
  if (w.endsWith("sses")) w = replaceSuffix(w, "sses", "ss");
  else if (w.endsWith("ies")) w = replaceSuffix(w, "ies", "i");
  else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);

  // Step 1b: -eed, -ed, -ing.
  if (w.endsWith("eed")) {
    if (measure(w.slice(0, -3)) > 0) w = replaceSuffix(w, "eed", "ee");
  } else {
    let stemmed: string | undefined;
    if (w.endsWith("ed") && hasVowel(w.slice(0, -2))) stemmed = w.slice(0, -2);
    else if (w.endsWith("ing") && hasVowel(w.slice(0, -3))) stemmed = w.slice(0, -3);
    if (stemmed !== undefined) {
      w = stemmed;
      if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
      else if (endsDoubleConsonant(w) && !"lsz".includes(w[w.length - 1]!)) w = w.slice(0, -1);
      else if (measure(w) === 1 && endsCvc(w)) w += "e";
    }
  }

  // Step 1c: terminal y to i when the stem holds a vowel.
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = replaceSuffix(w, "y", "i");

  // Step 2: double suffixes to single ones, where the stem's measure is positive.
  const step2 = longestSuffix(w, Object.keys(STEP2));
  if (step2 && measure(w.slice(0, -step2.length)) > 0) w = replaceSuffix(w, step2, STEP2[step2]!);

  // Step 3: -icate, -ative, -alize and friends, same condition.
  const step3 = longestSuffix(w, Object.keys(STEP3));
  if (step3 && measure(w.slice(0, -step3.length)) > 0) w = replaceSuffix(w, step3, STEP3[step3]!);

  // Step 4: residual suffixes where the stem's measure exceeds one; -ion
  // additionally needs a stem ending in s or t.
  const step4 = longestSuffix(w, STEP4);
  if (step4) {
    const base = w.slice(0, -step4.length);
    if (measure(base) > 1 && (step4 !== "ion" || base.endsWith("s") || base.endsWith("t")))
      w = base;
  }

  // Step 5a: a final e goes when the stem is heavy enough, or when keeping it
  // is the only thing making a short stem look complete.
  if (w.endsWith("e")) {
    const base = w.slice(0, -1);
    if (measure(base) > 1) w = base;
    else if (measure(base) === 1 && !endsCvc(base)) w = base;
  }

  // Step 5b: a final double l reduces when the measure exceeds one.
  if (measure(w) > 1 && endsDoubleConsonant(w) && w.endsWith("l")) w = w.slice(0, -1);

  return w;
}
