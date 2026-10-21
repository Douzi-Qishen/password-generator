import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzePassword,
  chunkPassword,
  generatePassword,
  getKeyInfo,
  getPolicyStats,
  KEYBOARD_COST_MODEL,
  SYMBOLS,
} from "./generator.js";

const STANDARD_SYMBOLS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" + STANDARD_SYMBOLS;
const CONSONANTS = "bcdfghjklmnprstvwz";
const WORD_TOKENS = {
  O: CONSONANTS + "y", E: CONSONANTS + "x", V: "aeiou",
  Q: "q", U: "u", A: "aeio",
};
const WORD_FORMATS = ["OVE", "OVOV", "QUA", "QUAE"];
const TOKEN_SETS = { ...WORD_TOKENS, D: "0123456789", S: STANDARD_SYMBOLS };
const POLICIES = [true, false].flatMap((friendly) =>
  [true, false].map((memorable) => ({ friendly, memorable })),
);

// Independent inclusion-exclusion for unrestricted four-category strings.
function standardRandomCount(length) {
  const sizes = [26, 26, 10, STANDARD_SYMBOLS.length];
  let result = 0n;
  for (let missing = 0; missing < 16; missing += 1) {
    let available = 0;
    let sign = 1n;
    sizes.forEach((size, index) => {
      if (missing & (1 << index)) sign = -sign;
      else available += size;
    });
    result += sign * BigInt(available) ** BigInt(length);
  }
  return result;
}

// Independent closed form: three mark-block locations, two nontrivial case
// categories, and all digit/symbol strings except those missing a category.
function standardMemorableCount(length) {
  let result = 0n;
  for (const firstLength of [3, 4]) {
    for (const secondLength of [3, 4]) {
      const marksLength = length - firstLength - secondLength;
      if (marksLength < 2) continue;
      // Three letters: onset-vowel-coda or qu-vowel. Four letters:
      // two onset-vowel syllables or qu-vowel-coda. These languages are disjoint.
      const wordsByLength = { 3: 19n * 5n * 19n + 4n, 4: 19n * 5n * 19n * 5n + 4n * 19n };
      const firstWords = wordsByLength[firstLength];
      const secondWords = wordsByLength[secondLength];
      const cases = 2n ** BigInt(firstLength + secondLength) - 2n;
      const marks = 42n ** BigInt(marksLength)
        - 10n ** BigInt(marksLength) - 32n ** BigInt(marksLength);
      result += 3n * firstWords * secondWords * cases * marks;
    }
  }
  return result;
}

function testTemplates(length, memorable) {
  if (!memorable) return [{ pattern: "R".repeat(length), sizes: [3, 3, length - 6], markIndex: -1 }];
  const result = [];
  for (const first of WORD_FORMATS) {
    for (const second of WORD_FORMATS) {
      const marksLength = length - first.length - second.length;
      if (marksLength < 2) continue;
      for (let markMask = 1; markMask < 2 ** marksLength - 1; markMask += 1) {
        const marks = markMask.toString(2).padStart(marksLength, "0").replaceAll("0", "D").replaceAll("1", "S");
        for (let markIndex = 0; markIndex < 3; markIndex += 1) {
          const parts = [first, second];
          parts.splice(markIndex, 0, marks);
          result.push({ pattern: parts.join(""), sizes: parts.map((part) => part.length), markIndex });
        }
      }
    }
  }
  return result;
}

function standardTemplateCount(pattern) {
  const letters = [...pattern].filter((token) => token in WORD_TOKENS).length;
  return [...pattern].reduce((count, token) => count * BigInt(TOKEN_SETS[token].length), 1n)
    * (2n ** BigInt(letters) - 2n);
}

function matchesPattern(value, pattern) {
  return value.length === pattern.length && [...value.toLowerCase()]
    .every((character, index) => TOKEN_SETS[pattern[index]].includes(character));
}

function wordFormat(value) {
  const formats = WORD_FORMATS.filter((format) => matchesPattern(value, format));
  assert.equal(formats.length, 1, "every generated word has one unambiguous pronunciation pattern");
  return formats[0];
}

// Reference scorer intentionally uses individual physical characters, its own
// keyboard table, and no generator groups, transition cache, or cost constants.
const REFERENCE_KEYS = new Map();
for (const [row, left, right] of [
  [0, "`12345", "67890-="],
  [1, "qwert", "yuiop[]\\"],
  [2, "asdfg", "hjkl;'"],
  [3, "zxcvb", "nm,./"],
]) {
  for (const [hand, characters] of [[0, left], [1, right]]) {
    for (const key of characters) {
      REFERENCE_KEYS.set(key, { key, hand, row, pinky: "`1qaz0-=p[]\\;'/".includes(key) });
    }
  }
}
const SHIFT_PAIRS = new Map(
  [...'~!@#$%^&*()_+{}|:"<>?'].map((character, index) =>
    [character, [..."`1234567890-=[]\\;',./"][index]],
  ),
);

function referenceAnalysis(value) {
  const rows = [2, 2];
  const metrics = {
    sameHandTransitions: 0, shiftPresses: 0, shiftSideSwitches: 0,
    rowTravel: 0, pinkyKeyCount: 0, repeatedKeyCount: 0,
  };
  let previous = null;
  for (const character of value) {
    const key = SHIFT_PAIRS.get(character) ?? character.toLowerCase();
    const info = REFERENCE_KEYS.get(key);
    assert.ok(info, "reference fixtures use modeled ASCII keys");
    const shift = SHIFT_PAIRS.has(character) || /[A-Z]/.test(character);
    if (previous) {
      metrics.sameHandTransitions += Number(previous.hand === info.hand);
      metrics.repeatedKeyCount += Number(previous.key === key);
      metrics.shiftSideSwitches += Number(shift && previous.shift && previous.hand !== info.hand);
    }
    metrics.shiftPresses += Number(shift && (!previous?.shift || previous.hand !== info.hand));
    metrics.rowTravel += Math.abs(rows[info.hand] - info.row);
    rows[info.hand] = info.row;
    metrics.pinkyKeyCount += Number(info.pinky);
    previous = { ...info, shift };
  }
  metrics.costBreakdown = {
    sameHand: metrics.sameHandTransitions * 3,
    shiftPress: metrics.shiftPresses * 2,
    shiftSwitch: metrics.shiftSideSwitches * 3,
    rowTravel: metrics.rowTravel,
    pinky: metrics.pinkyKeyCount * 2,
  };
  metrics.ergonomicCost = Object.values(metrics.costBreakdown).reduce((sum, value) => sum + value, 0);
  return metrics;
}

function patternOf(generated) {
  return generated.segments.map((segment) => segment.kind === "word"
    ? wordFormat(segment.text)
    : [...segment.text].map((character) => /[0-9]/.test(character) ? "D" : "S").join("")
  ).join("");
}

function lowerBound(low, high, predicate) {
  while (low < high) {
    const middle = (low + high) / 2n;
    if (predicate(middle)) high = middle;
    else low = middle + 1n;
  }
  return low;
}

const rangeCache = new Map();
function templateRanges(options) {
  const cacheKey = JSON.stringify(options);
  if (rangeCache.has(cacheKey)) return rangeCache.get(cacheKey);
  const templates = testTemplates(options.length, true);
  const total = BigInt(getPolicyStats(options).spaceSize);
  const indexes = new Map(templates.map((template, index) => [template.pattern, index]));
  let start = 0n;
  const ranges = templates.map((template, index) => {
    const end = options.friendly
      ? lowerBound(start, total, (rank) => indexes.get(patternOf(generatedAtRank(options, rank))) > index)
      : start + standardTemplateCount(template.pattern);
    const range = { ...template, start, end, count: end - start };
    start = end;
    return range;
  });
  assert.equal(start, total);
  rangeCache.set(cacheKey, ranges);
  return ranges;
}

function withCrypto(value, callback) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value, configurable: true });
  try {
    return callback();
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else delete globalThis.crypto;
  }
}

function bytesForRank(rank, target) {
  target.fill(0);
  for (let index = target.length - 1; index >= 0; index -= 1) {
    target[index] = Number(rank & 255n);
    rank >>= 8n;
  }
  assert.equal(rank, 0n, "test rank must fit the requested buffer");
  return target;
}

function generatedAtRank(options, rank) {
  return withCrypto(
    { getRandomValues: (target) => bytesForRank(rank, target) },
    () => generatePassword(options),
  );
}

function candidatesForPattern(pattern) {
  let candidates = [""];
  for (const token of pattern) {
    const alphabet = TOKEN_SETS[token] + (token in WORD_TOKENS ? TOKEN_SETS[token].toUpperCase() : "");
    candidates = candidates.flatMap((prefix) => [...alphabet].map((character) => prefix + character));
  }
  return candidates;
}

function findCharacterRank(options, range, position, target) {
  const targetIndex = ALPHABET.indexOf(target);
  function visit(start, end, depth) {
    if (depth === position) {
      const rank = lowerBound(start, end, (candidate) =>
        ALPHABET.indexOf(generatedAtRank(options, candidate).password[position]) >= targetIndex);
      return rank < end && generatedAtRank(options, rank).password[position] === target ? rank : null;
    }
    let rank = start;
    while (rank < end) {
      const prefix = generatedAtRank(options, rank).password.slice(0, depth + 1);
      const next = lowerBound(rank + 1n, end,
        (candidate) => !generatedAtRank(options, candidate).password.startsWith(prefix));
      const found = visit(rank, next, depth + 1);
      if (found !== null) return found;
      rank = next;
    }
    return null;
  }
  return visit(range.start, range.end, 0);
}

function assertSuffixSubtree(options, range, pivot, suffixLength) {
  const prefix = generatedAtRank(options, pivot).password.slice(0, -suffixLength);
  const start = lowerBound(range.start, pivot,
    (rank) => generatedAtRank(options, rank).password.startsWith(prefix));
  const end = lowerBound(pivot + 1n, range.end,
    (rank) => !generatedAtRank(options, rank).password.startsWith(prefix));
  const expected = new Set();
  for (const suffix of candidatesForPattern(range.pattern.slice(-suffixLength))) {
    const value = prefix + suffix;
    if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) continue;
    const reference = referenceAnalysis(value);
    if (reference.repeatedKeyCount === 0 && reference.ergonomicCost <= options.length * 2) expected.add(value);
  }
  assert.equal(end - start, BigInt(expected.size), "overlapping token alphabets must count individual valid suffixes exactly");
  const actual = new Set();
  for (let rank = start; rank < end; rank += 1n) {
    const generated = generatedAtRank(options, rank);
    assertPolicy(generated, options);
    assert.ok(expected.has(generated.password), "rank must select a valid character-level completion");
    assert.ok(!actual.has(generated.password), "no completion may receive two ranks");
    actual.add(generated.password);
  }
  assert.equal(actual.size, expected.size);
}

function assertPolicy(generated, options) {
  const { length, friendly, memorable } = options;
  const { password, segments } = generated;
  // Never include generated secrets in assertion diagnostics.
  assert.ok(password.length === length, "generated length must match");
  assert.ok(/[a-z]/.test(password), "must contain lowercase");
  assert.ok(/[A-Z]/.test(password), "must contain uppercase");
  assert.ok(/[0-9]/.test(password), "must contain digit");
  const symbols = STANDARD_SYMBOLS;
  assert.ok([...password].some((c) => symbols.includes(c)), "must contain symbol");
  const allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" + symbols;
  assert.ok([...password].every((c) => allowed.includes(c)), "must use allowed alphabet");
  assert.equal(segments.length, 3, "all modes have three display segments");
  assert.ok(segments.map((segment) => segment.text).join("") === password, "segments preserve password exactly");

  if (memorable) {
    const words = segments.filter((segment) => segment.kind === "word");
    const marks = segments.filter((segment) => segment.kind === "marks");
    assert.equal(words.length, 2);
    assert.equal(marks.length, 1);
    for (const word of words) {
      assert.ok(word.text.length === 3 || word.text.length === 4, "word has three or four letters");
      assert.ok(word.reading === word.text.toLowerCase(), "reading ignores casing without modifying password");
      const format = wordFormat(word.text);
      const expectedReadingParts = format === "OVOV"
        ? [word.reading.slice(0, 2), word.reading.slice(2)] : [word.reading];
      assert.ok(Array.isArray(word.readingParts), "word reading is split into pronunciation units");
      assert.ok(JSON.stringify(word.readingParts) === JSON.stringify(expectedReadingParts), "qu remains one reading unit and onset-vowel syllables split 2+2");
      for (const [index, character] of [...word.reading].entries()) {
        if (character === "q") assert.ok(index === 0 && word.reading[index + 1] === "u", "q occurs only in a leading qu unit");
        if (character === "x") assert.equal(index, word.reading.length - 1, "x is a word-final coda");
        if (character === "y") assert.ok(index === 0 || (format === "OVOV" && index === 2), "y starts a syllable");
      }
    }
    assert.ok(marks[0].text.length >= 2 && marks[0].text.length <= 4, "mark block has two to four characters");
    assert.ok(/\d/.test(marks[0].text), "mark block includes digits");
    assert.ok([...marks[0].text].some((character) => symbols.includes(character)), "mark block includes symbols");
    assert.ok([...marks[0].text].every((character) => ("0123456789" + symbols).includes(character)), "mark block contains only digits and symbols");
    assert.equal(marks[0].reading, null);
    assert.equal(marks[0].readingParts, null);
  } else {
    assert.deepEqual(segments.map((segment) => segment.text.length), [3, 3, length - 6]);
    assert.ok(segments.every((segment) => segment.kind === "random" && segment.reading === null && segment.readingParts === null));
  }

  if (friendly) {
    const analysis = analyzePassword(password);
    const reference = referenceAnalysis(password);
    assert.equal(analysis.repeatedKeyCount, 0, "adjacent physical keys cannot repeat, including Shift variants");
    assert.equal(analysis.ergonomicCost, reference.ergonomicCost);
    assert.ok(reference.ergonomicCost <= length * 2, "the combined typing cost must fit the selected length's budget");
    assert.equal(generated.friendlyCostLimit, length * 2);
  } else {
    assert.equal(generated.friendlyCostLimit, null);
  }
}

test("all four policies have exact independently verified counts at every supported length", () => {
  // Verified with a separate prototype using physical-key groups constructed
  // from row-order keys, a different alphabet ordering, and numeric DP states.
  const knownFriendlyMemorable = [2122894250n, 100164735413n, 2610728100298n];
  const knownFriendlyRandom = [4032776469320n, 233921916750392n, 12996919461080128n];
  for (const policy of POLICIES) {
    for (const length of [8, 9, 10]) {
      const stats = getPolicyStats({ length, ...policy });
      const expected = policy.friendly
        ? (policy.memorable ? knownFriendlyMemorable : knownFriendlyRandom)[length - 8]
        : policy.memorable ? standardMemorableCount(length) : standardRandomCount(length);
      assert.equal(stats.spaceSize, expected.toString());
      assert.equal(stats.entropyBits, Math.log2(Number(expected)));
      assert.equal(stats.friendlyCostLimit, policy.friendly ? length * 2 : null);
    }
  }
});

test("memorable template spaces are disjoint by per-position alphabet intersections", () => {
  for (const length of [8, 9, 10]) {
    const templates = testTemplates(length, true);
    assert.equal(templates.length, [24, 120, 336][length - 8]);
    for (let first = 0; first < templates.length; first += 1) {
      for (let second = first + 1; second < templates.length; second += 1) {
        assert.ok([...templates[first].pattern].some((token, index) =>
          ![...TOKEN_SETS[token]].some((character) => TOKEN_SETS[templates[second].pattern[index]].includes(character))),
        "every pair needs an empty position intersection, including overlapping O/E and U/A/V alphabets");
      }
    }
  }
});

test("expanded word counts have an independent closed form and retain every old word", () => {
  assert.equal(19n * 5n * 19n + 4n, 1809n);
  assert.equal(19n * 5n * 19n * 5n + 4n * 19n, 9101n);
  const knownCounts = [389556138240n, 32507837671680n, 1791935209178880n];
  for (const length of [8, 9, 10]) {
    assert.equal(standardMemorableCount(length), knownCounts[length - 8]);
    assert.equal(getPolicyStats({ length, friendly: false, memorable: true }).spaceSize, knownCounts[length - 8].toString());
  }
  let oldWords = 0;
  for (const oldFormat of ["CVC", "CVCV"]) {
    let words = [""];
    for (const token of oldFormat) {
      words = words.flatMap((prefix) => [...(token === "C" ? CONSONANTS : "aeiou")].map((character) => prefix + character));
    }
    for (const word of words) {
      assert.equal(wordFormat(word), oldFormat.length === 3 ? "OVE" : "OVOV");
      assert.ok(matchesPattern(word.toUpperCase(), oldFormat.length === 3 ? "OVE" : "OVOV"));
      oldWords += 1;
    }
  }
  assert.equal(oldWords, 1620 + 8100, "all old lowercase words and all of their case variants remain grammatical");
  // The digit/symbol alphabets, case rules, segment placements and ergonomic
  // constraints are unchanged, so the word-language inclusion extends to all
  // formerly valid complete passwords in both typing settings.
  for (const [length, previousSpace] of [[8, 1713785151n], [9, 82554895215n], [10, 2165642674774n]]) {
    assert.ok(BigInt(getPolicyStats({ length, friendly: true, memorable: true }).spaceSize) > previousSpace);
  }
});

test("q Q x X y Y are reachable at every mnemonic length with valid pronunciation positions", () => {
  for (const friendly of [true, false]) {
    for (const length of [8, 9, 10]) {
      const options = { length, friendly, memorable: true };
      const ranges = templateRanges(options);
      for (const target of "qQxXyY") {
        const position = /[xX]/.test(target) ? 2 : 0;
        const prefixFormat = /[qQ]/.test(target) ? "QUA" : "OVE";
        const range = ranges.find((candidate) => candidate.pattern.startsWith(prefixFormat) && candidate.count > 0n);
        assert.ok(range, "the expanded word grammar has a valid template for each new letter");
        const rank = findCharacterRank(options, range, position, target);
        assert.ok(rank !== null, `new letter ${target} is reachable at length ${length} with friendly=${friendly}`);
        const generated = generatedAtRank(options, rank);
        assertPolicy(generated, options);
        assert.ok(generated.password[position] === target, "the rank witness contains the intended case-specific letter");
      }
    }
  }
});

test("mnemonic U A E and overlapping vowel alphabets match character-level suffix enumeration", () => {
  for (const [length, pattern, suffixLength] of [
    [8, "DSOVEQUA", 2], [9, "DSOVEQUAE", 3],
    [9, "DSOVOVOVE", 2], [10, "DSOVOVOVOV", 2],
  ]) {
    const options = { length, friendly: true, memorable: true };
    const range = templateRanges(options).find((candidate) => candidate.pattern === pattern);
    assert.ok(range && range.count > 0n);
    for (const pivot of [range.start, (range.start + range.end) / 2n, range.end - 1n]) {
      assertSuffixSubtree(options, range, pivot, suffixLength);
    }
  }
});

test("all lengths and all four policies satisfy rules with real Web Crypto", () => {
  for (const policy of POLICIES) {
    for (const length of [8, 9, 10]) {
      const options = { length, ...policy };
      const stats = getPolicyStats(options);
      for (let iteration = 0; iteration < 80; iteration += 1) {
        const generated = generatePassword(options);
        assertPolicy(generated, options);
        assert.equal(generated.spaceSize, stats.spaceSize);
        assert.equal(generated.entropyBits, stats.entropyBits);
      }
    }
  }
});

test("deterministic ranks allow varying uppercase counts and bottom-row uppercase keys", () => {
  const bottomRowPolicies = new Set();
  let hasMultipleSameHandTransitions = false;
  let hasThreeKeyHandRun = false;
  for (const policy of POLICIES) {
    for (const length of [8, 9, 10]) {
      const options = { length, ...policy };
      const size = BigInt(getPolicyStats(options).spaceSize);
      const upperCounts = new Set();
      for (let sample = 0; sample < 64; sample += 1) {
        const generated = generatedAtRank(options, (size - 1n) * BigInt(sample) / 63n);
        assertPolicy(generated, options);
        const analysis = analyzePassword(generated.password);
        upperCounts.add(analysis.upperCount);
        if (policy.friendly) {
          hasMultipleSameHandTransitions ||= analysis.sameHandTransitions > 1;
          hasThreeKeyHandRun ||= analysis.maxSameHandRun >= 3;
        }
        if (/[ZXCVBNM]/.test(generated.password)) bottomRowPolicies.add(JSON.stringify(policy));
      }
      assert.ok(upperCounts.size > 1, "uppercase count is not fixed");
      assert.ok([...upperCounts].some((count) => count > 1), "multiple uppercase letters remain possible");
    }
  }
  assert.equal(bottomRowPolicies.size, POLICIES.length, "all policies permit bottom-row uppercase letters");
  assert.ok(hasMultipleSameHandTransitions, "combined cost replaces the former one-same-hand hard cap");
  assert.ok(hasThreeKeyHandRun, "three same-hand main keys are permitted when the total budget allows them");
});

test("all 32 symbols remain reachable in both typing settings and both generation modes", () => {
  assert.equal(SYMBOLS, STANDARD_SYMBOLS);
  assert.equal(new Set(SYMBOLS).size, 32);
  for (const policy of POLICIES) {
    const options = { length: 8, ...policy };
    const total = BigInt(getPolicyStats(options).spaceSize);
    const range = policy.memorable
      ? templateRanges(options).find((template) => template.pattern === "SDOVEOVE")
      : { start: 0n, end: total };
    assert.ok(range && range.end > range.start);
    const seen = new Set();
    let rank = range.start;
    while (rank < range.end) {
      const generated = generatedAtRank(options, rank);
      assertPolicy(generated, options);
      const leading = generated.password[0];
      if (STANDARD_SYMBOLS.includes(leading)) seen.add(leading);
      // Every prefix is one contiguous subtree of this template's rank space.
      rank = lowerBound(rank + 1n, range.end,
        (candidate) => generatedAtRank(options, candidate).password[0] !== leading);
    }
    assert.equal(seen.size, 32, "cost scoring must not silently exclude any symbol from the alphabet");
    assert.ok([...STANDARD_SYMBOLS].every((symbol) => seen.has(symbol)));
  }
});

test("friendly suffix rank subtrees match independent exhaustive character enumeration", () => {
  const options = { length: 8, friendly: true, memorable: false };
  const size = BigInt(getPolicyStats(options).spaceSize);
  for (const pivot of [0n, size / 4n, size / 2n, size * 3n / 4n, size - 1n]) {
    const prefix = generatedAtRank(options, pivot).password.slice(0, 6);
    const start = lowerBound(0n, pivot,
      (rank) => generatedAtRank(options, rank).password.startsWith(prefix));
    const end = lowerBound(pivot + 1n, size,
      (rank) => !generatedAtRank(options, rank).password.startsWith(prefix));
    const expected = new Set();
    for (const first of ALPHABET) {
      for (const second of ALPHABET) {
        const value = prefix + first + second;
        if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)
          || ![...value].some((character) => STANDARD_SYMBOLS.includes(character))) continue;
        const reference = referenceAnalysis(value);
        if (reference.repeatedKeyCount === 0 && reference.ergonomicCost <= 16) expected.add(value);
      }
    }
    assert.equal(end - start, BigInt(expected.size), "a prefix subtree must count every valid completion once");
    const actual = new Set();
    for (let rank = start; rank < end; rank += 1n) {
      const generated = generatedAtRank(options, rank);
      assert.ok(expected.has(generated.password), "every rank maps to a permitted completion");
      assert.ok(!actual.has(generated.password), "no two ranks map to the same completion");
      actual.add(generated.password);
    }
    assert.equal(actual.size, expected.size);
  }
});

test("every weighted template boundary decodes to its own segment layout without collisions", () => {
  for (const friendly of [true, false]) {
    for (const length of [8, 9, 10]) {
      const options = { length, friendly, memorable: true };
      const seen = new Set();
      for (const template of templateRanges(options)) {
        if (template.count === 0n) continue;
        assert.ok(template.count > 1n);
        for (const rank of [template.start, template.end - 1n]) {
          const generated = generatedAtRank(options, rank);
          assertPolicy(generated, options);
          assert.ok(patternOf(generated) === template.pattern, "rank must remain within its selected character-class template");
          assert.deepEqual(generated.segments.map((segment) => segment.text.length), template.sizes);
          assert.equal(generated.segments.findIndex((segment) => segment.kind === "marks"), template.markIndex);
          assert.ok(!seen.has(generated.password), "different ranks must produce different passwords");
          seen.add(generated.password);
        }
      }
    }
  }
});

test("first, last, adjacent and middle random-mode ranks decode without collisions", () => {
  for (const friendly of [true, false]) {
    for (const length of [8, 9, 10]) {
      const options = { length, friendly, memorable: false };
      const size = BigInt(getPolicyStats(options).spaceSize);
      const ranks = [0n, 1n, 2n, size / 2n, size - 2n, size - 1n];
      const generated = ranks.map((rank) => generatedAtRank(options, rank));
      for (const value of generated) assertPolicy(value, options);
      assert.equal(new Set(generated.map((value) => value.password)).size, ranks.length);
    }
  }
});

test("mark counts and block locations are not restricted to one fixed layout", () => {
  for (const friendly of [true, false]) {
    const options = { length: 10, friendly, memorable: true };
    const markPositions = new Set();
    const digitCounts = new Set();
    const symbolCounts = new Set();
    for (const template of templateRanges(options)) {
      if (template.count === 0n) continue;
      const generated = generatedAtRank(options, template.start);
      const analysis = analyzePassword(generated.password);
      markPositions.add(generated.segments.findIndex((segment) => segment.kind === "marks"));
      digitCounts.add(analysis.digitCount);
      symbolCounts.add(analysis.symbolCount);
    }
    assert.equal(markPositions.size, 3);
    assert.ok(digitCounts.size > 1 && symbolCounts.size > 1, "digit and symbol counts vary");
  }
});

test("out-of-range random ranks are rejected, including exactly the upper bound", () => {
  for (const policy of POLICIES) {
    const options = { length: 10, ...policy };
    const size = BigInt(getPolicyStats(options).spaceSize);
    const expected = generatedAtRank(options, 0n).password;
    let calls = 0;
    const generated = withCrypto(
      {
        getRandomValues(target) {
          calls += 1;
          if (calls === 1) return target.fill(255);
          return bytesForRank(calls === 2 ? size : 0n, target);
        },
      },
      () => generatePassword(options),
    );
    assert.equal(calls, 3);
    assert.ok(generated.password === expected, "rejected values must not be reduced modulo the bound");
  }
});

test("the secure random provider retains its receiver and Math.random is never used", () => {
  const originalRandom = Math.random;
  Math.random = () => { throw new Error("Math.random must not be used"); };
  try {
    const provider = {
      getRandomValues(target) {
        assert.equal(this, provider);
        return target.fill(0);
      },
    };
    withCrypto(provider, () => {
      for (const policy of POLICIES) {
        const options = { length: 10, ...policy };
        assertPolicy(generatePassword(options), options);
      }
    });
  } finally {
    Math.random = originalRandom;
  }
});

test("missing, invalid and failed secure random providers fail closed", () => {
  for (const provider of [undefined, null, {}, { getRandomValues: 1 }]) {
    withCrypto(provider, () => {
      assert.throws(() => generatePassword(), /Web Crypto/);
      assert.ok(getPolicyStats().entropyBits > 0, "policy counting needs no randomness");
    });
  }
  const failure = new Error("test random source failure");
  withCrypto(
    { getRandomValues() { throw failure; } },
    () => assert.throws(() => generatePassword(), (error) => error === failure),
  );
});

test("only integer lengths 8–10 and boolean policy flags are accepted", () => {
  for (const length of [0, 7, 11, 8.5, "10", NaN, Infinity, null]) {
    assert.throws(() => getPolicyStats({ length }), RangeError);
    assert.throws(() => generatePassword({ length }), RangeError);
  }
  for (const flag of ["friendly", "memorable"]) {
    for (const value of [0, 1, "true", null]) {
      assert.throws(() => getPolicyStats({ [flag]: value }), TypeError);
      assert.throws(() => generatePassword({ [flag]: value }), TypeError);
    }
  }
  for (const options of [null, [], "10", 10]) {
    assert.throws(() => getPolicyStats(options), TypeError);
    assert.throws(() => generatePassword(options), TypeError);
  }
  assert.deepEqual(getPolicyStats(), getPolicyStats({ length: 10, friendly: true, memorable: true }));
});

test("ANSI US keyboard mapping includes shifted symbols and opposite Shift hands", () => {
  assert.deepEqual(getKeyInfo("Z"), {
    key: "z", hand: "left", finger: "小指", row: 3, shift: true, shiftHand: "right",
  });
  assert.deepEqual(getKeyInfo("?"), {
    key: "/", hand: "right", finger: "小指", row: 3, shift: true, shiftHand: "left",
  });
  assert.deepEqual(getKeyInfo("@"), {
    key: "2", hand: "left", finger: "无名指", row: 0, shift: true, shiftHand: "right",
  });
  for (const symbol of STANDARD_SYMBOLS) assert.ok(getKeyInfo(symbol));
  assert.equal(getKeyInfo("'").shift, false);
  assert.equal(getKeyInfo('"').shift, true);
  assert.equal(getKeyInfo("\\").row, 1);
  assert.equal(getKeyInfo("f").row, 2);
  assert.equal(getKeyInfo("B").hand, "left");
  assert.equal(getKeyInfo("6").hand, "right");
  assert.equal(getKeyInfo("🙂"), null);
  assert.equal(getKeyInfo(""), null);
  assert.equal(getKeyInfo("aa"), null);
});

test("cost components account for opposite Shift, per-hand rows and pinkies", () => {
  assert.deepEqual(KEYBOARD_COST_MODEL, {
    sameHand: 3, shiftPress: 2, shiftSwitch: 3, rowTravel: 1,
    pinky: 2, costPerCharacter: 2, homeRow: 2,
  });
  for (const [value, expectedCost] of [
    ["fJ", 2], ["Fj", 2], ["FJ", 7], ["FD", 5], ["FDF", 8],
    ["fjf", 0], ["fyv", 2], ["fyu", 4], ["1a", 11],
    ["dD", 5], ["2@", 7], [";:", 9], ["AA", 9],
  ]) {
    const reference = referenceAnalysis(value);
    assert.equal(reference.ergonomicCost, expectedCost);
    const actual = analyzePassword(value);
    for (const [metric, expected] of Object.entries(reference)) {
      assert.deepEqual(actual[metric], expected, `analysis metric ${metric} must match the independent scorer`);
    }
  }
  const unknown = analyzePassword("f你J");
  assert.equal(unknown.knownKeyboard, false);
  assert.equal(unknown.ergonomicCost, null);
  assert.equal(unknown.costBreakdown, null);
  assert.equal(analyzePassword("").ergonomicCost, 0);
});

test("analysis detects physical repeats, hand runs and Shift characters", () => {
  const analysis = analyzePassword("aAZXC?/9");
  assert.equal(analysis.shiftCount, 5);
  assert.equal(analysis.shiftPresses, 2);
  assert.equal(analysis.repeatedKeyCount, 2);
  assert.equal(analysis.maxSameHandRun, 5);
  assert.equal(analysis.handSwitchCount, 1);
  assert.equal(analysis.knownKeyboard, true);
  assert.equal(analyzePassword("你").knownKeyboard, false);
  assert.equal(analyzePassword("").shiftCount, 0);
});

test("random-mode display chunks preserve their exact input without adding spaces", () => {
  for (const length of [8, 9, 10]) {
    const value = "0123456789".slice(0, length);
    const chunks = chunkPassword(value);
    assert.deepEqual(chunks.map((chunk) => chunk.length), [3, 3, length - 6]);
    assert.equal(chunks.join(""), value);
  }
});
