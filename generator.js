/**
 * Local-only password generation for an ANSI US QWERTY keyboard.
 *
 * Every generated password is sampled uniformly from the selected policy's
 * complete valid space. Dynamic programming counts that space exactly with
 * BigInt; a Web Crypto random rank is then decoded using subtree counts.
 */

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CONSONANTS = "bcdfghjklmnprstvwz";
const VOWELS = "aeiou";
// Position-aware pseudo-word grammar. Keep every old CVC/CVCV word while
// admitting y as an onset, x as a coda, and q only in a leading qu unit.
const WORD_TOKENS = {
  O: CONSONANTS + "y",
  E: CONSONANTS + "x",
  V: VOWELS,
  Q: "q",
  U: "u",
  A: "aeio",
};
const WORD_FORMATS = ["OVE", "OVOV", "QUA", "QUAE"];
const DIGITS = "0123456789";
/** Every printable ASCII punctuation character, shared by both modes. */
export const SYMBOLS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
/**
 * Transparent heuristic weights, not measurements of typing speed or comfort.
 * Rows are numbered from the digit row (0) to the bottom letter row (3).
 */
export const KEYBOARD_COST_MODEL = Object.freeze({
  sameHand: 3,
  shiftPress: 2,
  shiftSwitch: 3,
  rowTravel: 1,
  pinky: 2,
  costPerCharacter: 2,
  homeRow: 2,
});

const LOWER_BIT = 1;
const UPPER_BIT = 2;
const DIGIT_BIT = 4;
const SYMBOL_BIT = 8;
const ALL_CATEGORIES = 15;

const KEY_ROWS = [
  ["`12345", "left", ["pinky", "pinky", "ring", "middle", "index", "index"]],
  ["67890-=", "right", ["index", "index", "middle", "ring", "pinky", "pinky", "pinky"]],
  ["qwert", "left", ["pinky", "ring", "middle", "index", "index"]],
  ["yuiop[]\\", "right", ["index", "index", "middle", "ring", "pinky", "pinky", "pinky", "pinky"]],
  ["asdfg", "left", ["pinky", "ring", "middle", "index", "index"]],
  ["hjkl;'", "right", ["index", "index", "middle", "ring", "pinky", "pinky"]],
  ["zxcvb", "left", ["pinky", "ring", "middle", "index", "index"]],
  ["nm,./", "right", ["index", "index", "middle", "ring", "pinky"]],
];

const SHIFTED_KEYS = new Map(
  [...'~!@#$%^&*()_+{}|:"<>?'].map((character, index) => [
    character,
    [..."`1234567890-=[]\\;',./"][index],
  ]),
);

const KEY_INFO = new Map();
const FINGER_LABELS = { pinky: "小指", ring: "无名指", middle: "中指", index: "食指" };
for (const [rowIndex, [characters, hand, fingers]] of KEY_ROWS.entries()) {
  [...characters].forEach((key, index) => {
    KEY_INFO.set(key, Object.freeze({
      key,
      hand,
      finger: FINGER_LABELS[fingers[index]],
      row: Math.floor(rowIndex / 2),
    }));
  });
}

/**
 * Return the physical key and the opposite-hand Shift for a printable US key.
 * An unsupported character returns null. `finger` is e.g. "食指".
 */
export function getKeyInfo(character) {
  if (typeof character !== "string" || character.length !== 1) return null;
  const uppercase = character >= "A" && character <= "Z";
  const shiftedSymbol = SHIFTED_KEYS.has(character);
  const key = uppercase
    ? character.toLowerCase()
    : SHIFTED_KEYS.get(character) ?? character;
  const info = KEY_INFO.get(key);
  if (!info) return null;
  const shift = uppercase || shiftedSymbol;
  return {
    ...info,
    shift,
    shiftHand: shift ? (info.hand === "left" ? "right" : "left") : null,
  };
}

const KEY_IDS = new Map([...KEY_INFO.keys()].map((key, index) => [key, index]));
const BIT_COUNTS = Array.from({ length: 16 }, (_, value) =>
  value.toString(2).replaceAll("0", "").length,
);
const PHYSICAL_GROUP_IDS = new Map();
const PHYSICAL_GROUPS = [];

function letterMembership(key) {
  // Tokens overlap (u belongs to U and V; a/e/i/o to A and V). Grouping
  // physical keys by the complete membership signature preserves equal
  // continuation counts and makes the previous-key subtraction exact.
  return Object.entries(WORD_TOKENS)
    .filter(([, characters]) => characters.includes(key))
    .map(([token]) => token).join("");
}

function makeAlphabet() {
  return [
    [LOWER, LOWER_BIT],
    [UPPER, UPPER_BIT],
    [DIGITS, DIGIT_BIT],
    [SYMBOLS, SYMBOL_BIT],
  ].flatMap(([characters, category]) =>
    [...characters].map((character) => {
      const info = getKeyInfo(character);
      const physicalKind = /[a-z]/.test(info.key) ? letterMembership(info.key)
        : DIGITS.includes(info.key) ? "D" : "P";
      const groupName = `${physicalKind}:${info.hand}:${info.row}:${info.finger}`;
      if (!PHYSICAL_GROUP_IDS.has(groupName)) {
        PHYSICAL_GROUP_IDS.set(groupName, PHYSICAL_GROUP_IDS.size);
        PHYSICAL_GROUPS.push({
          hand: info.hand,
          row: info.row,
          finger: info.finger,
        });
      }
      return Object.freeze({
        character,
        category,
        keyId: KEY_IDS.get(info.key),
        groupId: PHYSICAL_GROUP_IDS.get(groupName),
        hand: info.hand,
        row: info.row,
        finger: info.finger,
        shift: info.shift,
      });
    }),
  );
}

function makeTokenAlphabets(alphabet) {
  return {
    R: alphabet,
    D: alphabet.filter((entry) => entry.category === DIGIT_BIT),
    S: alphabet.filter((entry) => entry.category === SYMBOL_BIT),
    ...Object.fromEntries(Object.entries(WORD_TOKENS).map(([token, letters]) => [
      token,
      alphabet.filter((entry) => letters.includes(entry.character.toLowerCase())),
    ])),
  };
}

const ALPHABETS = makeTokenAlphabets(makeAlphabet());
// Every physical group contains keys with identical continuation counts.
// Lower/upper letters, digit/shifted-digit symbols and both punctuation forms
// cover the same complete physical-key groups. Subtracting one therefore
// excludes the previous physical key exactly, including changed case or Shift.
const FRIENDLY_GROUPS = Object.fromEntries(Object.entries(ALPHABETS).map(
  ([token, alphabet]) => {
    const groups = new Map();
    for (const entry of alphabet) {
      const key = `${entry.groupId}:${entry.category}:${Number(entry.shift)}`;
      const group = groups.get(key);
      if (group) group.size += 1;
      else groups.set(key, { ...entry, size: 1 });
    }
    return [token, [...groups.values()]];
  },
));
const STANDARD_GROUPS = Object.fromEntries(Object.entries(ALPHABETS).map(
  ([token, alphabet]) => {
    const groups = new Map();
    for (const { category } of alphabet) groups.set(category, (groups.get(category) ?? 0) + 1);
    return [token, [...groups].map(([category, size]) => ({ category, size }))];
  },
));
const standardCounts = new Map();
const policyCache = new Map();
// Policy summaries are tiny. Keep only the current large friendly suffix DP,
// rebuilding it on a different friendly policy instead of retaining six DPs.
let friendlyCounterCache = null;

function validateOptions(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("生成选项必须是对象。");
  }
  const { length = 10, friendly = true, memorable = true } = options;
  if (!Number.isInteger(length) || length < 8 || length > 10) {
    throw new RangeError("密码长度只能是整数 8、9 或 10。");
  }
  if (typeof friendly !== "boolean") throw new TypeError("friendly 必须是布尔值。");
  if (typeof memorable !== "boolean") throw new TypeError("memorable 必须是布尔值。");
  return { length, friendly, memorable };
}

function stepMetrics(previous, next, lastRow) {
  const sameHand = previous?.hand === next.hand;
  const shiftSwitch = Boolean(previous?.shift && next.shift && !sameHand);
  return {
    sameHand: Number(sameHand),
    shiftPress: Number(next.shift && (!previous?.shift || !sameHand)),
    shiftSwitch: Number(shiftSwitch),
    rowTravel: Math.abs(lastRow - next.row),
    pinky: Number(next.finger === "小指"),
  };
}

function weightedCost(metrics) {
  return Object.entries(metrics).reduce(
    (sum, [name, value]) => sum + value * KEYBOARD_COST_MODEL[name], 0,
  );
}

// The previous physical group already stores that hand's last row. Only the
// other hand's row needs additional state. Packing preserves every distinction
// used by the heuristic while keeping the exact-count DP small.
const CONTEXT_COUNT = (PHYSICAL_GROUPS.length + 1) * 8;
const INITIAL_CONTEXT = KEYBOARD_COST_MODEL.homeRow;

function keyboardTransition(context, entry) {
  const previousGroup = Math.floor(context / 8) - 1;
  const previousShift = Boolean(Math.floor(context / 4) % 2);
  const otherRow = context % 4;
  const group = PHYSICAL_GROUPS[previousGroup];
  const previous = group ? { ...group, shift: previousShift } : null;
  const sameHand = previous?.hand === entry.hand;
  const lastRow = previous
    ? (sameHand ? previous.row : otherRow)
    : KEYBOARD_COST_MODEL.homeRow;
  const nextOtherRow = previous
    ? (sameHand ? otherRow : previous.row)
    : KEYBOARD_COST_MODEL.homeRow;
  return {
    context: (entry.groupId + 1) * 8 + Number(entry.shift) * 4 + nextOtherRow,
    cost: weightedCost(stepMetrics(previous, entry, lastRow)),
  };
}

const FRIENDLY_TRANSITIONS = Object.fromEntries(
  Object.entries(FRIENDLY_GROUPS).map(([token, groups]) => [
    token,
    Array.from({ length: CONTEXT_COUNT }, (_, context) =>
      groups.map((group) => ({
        ...keyboardTransition(context, group),
        choices: group.size - Number(Math.floor(context / 8) - 1 === group.groupId),
        category: group.category,
      }))),
  ]),
);

function getFriendlyCounter(options, templates) {
  const cacheKey = `${options.length}:${options.memorable}`;
  if (friendlyCounterCache?.key === cacheKey) return friendlyCounterCache;
  const limit = options.length * KEYBOARD_COST_MODEL.costPerCharacter;
  const suffixes = [""];
  const suffixIds = new Map([["", 0]]);
  for (const { pattern } of templates) {
    for (let index = pattern.length - 1; index >= 0; index -= 1) {
      const suffix = pattern.slice(index);
      if (!suffixIds.has(suffix)) {
        suffixIds.set(suffix, suffixes.length);
        suffixes.push(suffix);
      }
    }
  }
  const nextSuffix = suffixes.map((suffix) => suffixIds.get(suffix.slice(1)));
  const memo = new Map();

  function count(suffixId, mask = 0, context = INITIAL_CONTEXT, remaining = limit) {
    if (remaining < 0) return 0n;
    if (suffixId === 0) return mask === ALL_CATEGORIES ? 1n : 0n;
    const suffix = suffixes[suffixId];
    if (BIT_COUNTS[ALL_CATEGORIES ^ mask] > suffix.length) return 0n;
    // This integer is comfortably below Number.MAX_SAFE_INTEGER for 8–10
    // characters. The actual number of passwords is always held as BigInt.
    const state = (((suffixId * 16 + mask) * CONTEXT_COUNT + context)
      * (limit + 1)) + remaining;
    const cached = memo.get(state);
    if (cached !== undefined) return cached;
    let total = 0n;
    for (const transition of FRIENDLY_TRANSITIONS[suffix[0]][context]) {
      if (transition.choices === 0 || transition.cost > remaining) continue;
      total += BigInt(transition.choices) * count(
        nextSuffix[suffixId],
        mask | transition.category,
        transition.context,
        remaining - transition.cost,
      );
    }
    memo.set(state, total);
    return total;
  }

  friendlyCounterCache = {
    key: cacheKey,
    count: (suffix, mask, context, remaining) =>
      count(suffixIds.get(suffix), mask, context, remaining),
  };
  return friendlyCounterCache;
}

function countStandard(pattern, mask = 0) {
  if (pattern.length === 0) return mask === ALL_CATEGORIES ? 1n : 0n;
  if (BIT_COUNTS[ALL_CATEGORIES ^ mask] > pattern.length) return 0n;
  const state = `${pattern}:${mask}`;
  const cached = standardCounts.get(state);
  if (cached !== undefined) return cached;
  let count = 0n;
  for (const { category, size } of STANDARD_GROUPS[pattern[0]]) {
    count += BigInt(size) * countStandard(pattern.slice(1), mask | category);
  }
  standardCounts.set(state, count);
  return count;
}

function markPatterns(length, prefix = "") {
  if (prefix.length === length) {
    return prefix.includes("D") && prefix.includes("S") ? [prefix] : [];
  }
  return [...markPatterns(length, prefix + "D"), ...markPatterns(length, prefix + "S")];
}

function makeTemplates(length, memorable) {
  if (!memorable) {
    return [{
      pattern: "R".repeat(length),
      parts: [3, 3, length - 6].map((size) => ({ pattern: "R".repeat(size), kind: "random" })),
    }];
  }
  const templates = [];
  for (const first of WORD_FORMATS) {
    for (const second of WORD_FORMATS) {
      const marksLength = length - first.length - second.length;
      if (marksLength < 2 || marksLength > 4) continue;
      for (const marks of markPatterns(marksLength)) {
        for (let position = 0; position < 3; position += 1) {
          const parts = [first, second].map((pattern) => ({ pattern, kind: "word" }));
          parts.splice(position, 0, { pattern: marks, kind: "marks" });
          templates.push({ pattern: parts.map((part) => part.pattern).join(""), parts });
        }
      }
    }
  }
  // Token sets overlap, but complete templates do not: qu words start with q,
  // which neither O nor E permits. For adjacent ordinary words, a 3+4 split
  // has a consonant at position 4 where 4+3 has a vowel. If a leading qu word
  // changes length, the next word's onset (O or q) conflicts with either its
  // coda E or the following vowel/u. Mark blocks separate the other layouts.
  // Pairwise alphabet-intersection tests protect this disjointness invariant.
  return templates;
}

function getPolicy(options) {
  const { length, friendly, memorable } = options;
  const cacheKey = `${length}:${friendly}:${memorable}`;
  const cached = policyCache.get(cacheKey);
  if (cached) return cached;
  const rawTemplates = makeTemplates(length, memorable);
  const counter = friendly ? getFriendlyCounter(options, rawTemplates) : null;
  const templates = rawTemplates.map((template) => ({
    ...template,
    spaceSize: friendly ? counter.count(template.pattern) : countStandard(template.pattern),
  }));
  const spaceSize = templates.reduce((sum, template) => sum + template.spaceSize, 0n);
  const friendlyCostLimit = friendly ? length * KEYBOARD_COST_MODEL.costPerCharacter : null;
  const policy = { templates, spaceSize, friendlyCostLimit };
  policyCache.set(cacheKey, policy);
  return policy;
}

function toStats(spaceSize, friendlyCostLimit) {
  return {
    entropyBits: Math.log2(Number(spaceSize)),
    spaceSize: spaceSize.toString(),
    friendlyCostLimit,
  };
}

/** Exact uniform output-space size; inspecting a policy never generates a secret. */
export function getPolicyStats(options = {}) {
  const policy = getPolicy(validateOptions(options));
  return toStats(policy.spaceSize, policy.friendlyCostLimit);
}

function requireSecureRandom() {
  const provider = globalThis.crypto;
  if (!provider || typeof provider.getRandomValues !== "function") {
    throw new Error("当前环境不支持 Web Crypto 安全随机数，无法生成密码。");
  }
  return provider;
}

function randomBigIntBelow(limit, provider) {
  if (limit <= 0n) throw new RangeError("随机数上界必须大于零。");
  if (limit === 1n) return 0n;
  const bitLength = (limit - 1n).toString(2).length;
  const byteLength = Math.ceil(bitLength / 8);
  const excessBits = byteLength * 8 - bitLength;
  const bytes = new Uint8Array(byteLength);

  for (;;) {
    provider.getRandomValues(bytes);
    // Mask only unused high bits. Reject values >= limit; never take modulo.
    bytes[0] &= 255 >>> excessBits;
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    if (value < limit) return value;
  }
}

export function generatePassword(options = {}) {
  const validated = validateOptions(options);
  const { friendly } = validated;
  const provider = requireSecureRandom();
  const { templates, spaceSize, friendlyCostLimit } = getPolicy(validated);
  const counter = friendly ? getFriendlyCounter(validated, templates) : null;
  let rank = randomBigIntBelow(spaceSize, provider);
  // A single rank weights each template by its exact output count. Choosing
  // templates uniformly would bias outputs and overstate generation entropy.
  const template = templates.find((candidate) => {
    if (rank < candidate.spaceSize) return true;
    rank -= candidate.spaceSize;
    return false;
  });
  if (!template) throw new Error("密码模板解码失败。");

  let mask = 0;
  let previousKey = -1;
  let context = INITIAL_CONTEXT;
  let remaining = friendlyCostLimit;
  let password = "";

  for (let position = 0; position < template.pattern.length; position += 1) {
    let selected = false;
    const suffix = template.pattern.slice(position + 1);
    for (const entry of ALPHABETS[template.pattern[position]]) {
      if (friendly && entry.keyId === previousKey) continue;
      const transition = friendly ? keyboardTransition(context, entry) : null;
      if (friendly && transition.cost > remaining) continue;
      const nextMask = mask | entry.category;
      const subtreeSize = friendly
        ? counter.count(suffix, nextMask, transition.context, remaining - transition.cost)
        : countStandard(suffix, nextMask);
      if (rank >= subtreeSize) {
        rank -= subtreeSize;
        continue;
      }
      password += entry.character;
      mask = nextMask;
      previousKey = entry.keyId;
      if (friendly) {
        context = transition.context;
        remaining -= transition.cost;
      }
      selected = true;
      break;
    }
    if (!selected) throw new Error("密码空间解码失败。");
  }

  let offset = 0;
  const segments = template.parts.map(({ pattern, kind }) => {
    const text = password.slice(offset, offset + pattern.length);
    offset += pattern.length;
    const reading = kind === "word" ? text.toLowerCase() : null;
    const readingParts = reading === null ? null
      : pattern === "OVOV" ? [reading.slice(0, 2), reading.slice(2)] : [reading];
    return { text, kind, reading, readingParts };
  });
  return { password, segments, ...toStats(spaceSize, friendlyCostLimit) };
}

/**
 * `shiftCount` counts characters requiring Shift, not inferred key-down events.
 * `shiftPresses` assumes the opposite-hand Shift and contiguous Shift holds.
 * `rowTravel` estimates each hand's movement from its previous primary-key row,
 * starting at the home row. It is not a per-finger trajectory measurement.
 * Unsupported characters make the complete ergonomic cost unknown (null).
 */
export function analyzePassword(password) {
  if (typeof password !== "string") throw new TypeError("密码必须是字符串。");
  const result = {
    length: [...password].length,
    shiftCount: 0,
    shiftPresses: 0,
    upperCount: 0,
    lowerCount: 0,
    digitCount: 0,
    symbolCount: 0,
    handSwitchCount: 0,
    sameHandTransitions: 0,
    shiftSideSwitches: 0,
    rowTravel: 0,
    pinkyKeyCount: 0,
    ergonomicCost: 0,
    costBreakdown: { sameHand: 0, shiftPress: 0, shiftSwitch: 0, rowTravel: 0, pinky: 0 },
    repeatedKeyCount: 0,
    maxSameHandRun: 0,
    knownKeyboard: true,
  };
  let previous = null;
  let handRun = 0;
  const lastRows = {
    left: KEYBOARD_COST_MODEL.homeRow,
    right: KEYBOARD_COST_MODEL.homeRow,
  };

  for (const character of password) {
    if (/[A-Z]/.test(character)) result.upperCount += 1;
    else if (/[a-z]/.test(character)) result.lowerCount += 1;
    else if (/[0-9]/.test(character)) result.digitCount += 1;
    else result.symbolCount += 1;

    const info = getKeyInfo(character);
    if (!info) {
      result.knownKeyboard = false;
      previous = null;
      handRun = 0;
      lastRows.left = KEYBOARD_COST_MODEL.homeRow;
      lastRows.right = KEYBOARD_COST_MODEL.homeRow;
      continue;
    }
    const metrics = stepMetrics(previous, info, lastRows[info.hand]);
    result.sameHandTransitions += metrics.sameHand;
    result.shiftPresses += metrics.shiftPress;
    result.shiftSideSwitches += metrics.shiftSwitch;
    result.rowTravel += metrics.rowTravel;
    result.pinkyKeyCount += metrics.pinky;
    for (const [name, value] of Object.entries(metrics)) {
      result.costBreakdown[name] += value * KEYBOARD_COST_MODEL[name];
    }
    lastRows[info.hand] = info.row;
    if (info.shift) {
      result.shiftCount += 1;
    }
    if (previous?.key === info.key) result.repeatedKeyCount += 1;
    if (previous && previous.hand !== info.hand) result.handSwitchCount += 1;
    handRun = previous?.hand === info.hand ? handRun + 1 : 1;
    result.maxSameHandRun = Math.max(result.maxSameHandRun, handRun);
    previous = info;
  }

  if (result.knownKeyboard) {
    result.ergonomicCost = Object.values(result.costBreakdown).reduce((sum, cost) => sum + cost, 0);
  } else {
    result.ergonomicCost = null;
    result.costBreakdown = null;
  }
  return result;
}

/** Display-only chunks: spaces are never inserted into the actual password. */
export function chunkPassword(password) {
  if (typeof password !== "string") throw new TypeError("密码必须是字符串。");
  return [password.slice(0, 3), password.slice(3, 6), password.slice(6)];
}
