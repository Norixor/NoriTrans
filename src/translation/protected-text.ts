import { NorixorTransError } from "@/src/shared/errors";
import { runtimeErrorToken } from "@/src/shared/runtime-errors";
import type { TranslationSegment } from "@/src/translation/types";

export const PROTECTED_TEXT_FORMAT = "protected-text-v1" as const;

const MARKER_START = "\uE000";
const MARKER_END = "\uE001";
const MARKER_NAMESPACE = "NT1";
const GENERIC_MARKER_PATTERN =
  /\uE000NT1:([0-9a-z]+):([0-9a-z]+):(open|close)\uE001/gu;
const MAX_DIAGNOSTIC_LENGTH = 1_000;

interface ProtectedMarker {
  index: number;
  role: "open" | "close";
  salt: string;
  token: string;
  start: number;
  end: number;
}

interface ParsedProtectedText {
  markers: ProtectedMarker[];
  parts: string[];
  salt: string;
}

function markerPrefix(salt: string): string {
  return `${MARKER_START}${MARKER_NAMESPACE}:${salt}:`;
}

function marker(salt: string, index: number, role: "open" | "close"): string {
  return `${markerPrefix(salt)}${index.toString(36)}:${role}${MARKER_END}`;
}

function invalidProtectedText(details: string): NorixorTransError {
  return new NorixorTransError(
    runtimeErrorToken("invalid_response"),
    "invalid_response",
    true,
    details.slice(0, MAX_DIAGNOSTIC_LENGTH),
  );
}

function genericMarkers(value: string): ProtectedMarker[] {
  const markers: ProtectedMarker[] = [];
  GENERIC_MARKER_PATTERN.lastIndex = 0;
  for (
    let match = GENERIC_MARKER_PATTERN.exec(value);
    match;
    match = GENERIC_MARKER_PATTERN.exec(value)
  ) {
    const salt = match[1];
    const rawIndex = match[2];
    const role = match[3];
    const index = rawIndex ? Number.parseInt(rawIndex, 36) : Number.NaN;
    if (
      !salt ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      (role !== "open" && role !== "close")
    ) {
      continue;
    }
    markers.push({
      index,
      role,
      salt,
      token: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  GENERIC_MARKER_PATTERN.lastIndex = 0;
  return markers;
}

function scanMarkers(
  value: string,
  label: string,
  salt: string,
): ProtectedMarker[] {
  const prefix = markerPrefix(salt);
  const markers = genericMarkers(value).filter(
    (candidate) => candidate.salt === salt,
  );
  const matchedStarts = new Set(markers.map((candidate) => candidate.start));
  let cursor = value.indexOf(prefix);
  while (cursor >= 0) {
    if (!matchedStarts.has(cursor)) {
      throw invalidProtectedText(
        `${label} contains an unknown or malformed protected marker at offset ${cursor}.`,
      );
    }
    cursor = value.indexOf(prefix, cursor + prefix.length);
  }
  return markers;
}

function sourceSalt(value: string, label: string): string {
  const first = genericMarkers(value).find(
    (candidate) => candidate.start === 0,
  );
  if (!first || first.role !== "open" || first.index !== 0) {
    throw invalidProtectedText(
      `${label} must start with the opening marker for protected part 0.`,
    );
  }
  return first.salt;
}

function parseCanonicalProtectedText(
  value: string,
  label: string,
  requiredSalt?: string,
): ParsedProtectedText {
  const salt = requiredSalt ?? sourceSalt(value, label);
  if (!value.startsWith(marker(salt, 0, "open"))) {
    throw invalidProtectedText(
      `${label} uses an unknown protected marker namespace or reordered first marker.`,
    );
  }
  const markers = scanMarkers(value, label, salt);
  if (markers.length === 0 || markers.length % 2 !== 0) {
    throw invalidProtectedText(
      `${label} has a missing protected marker (received ${markers.length}).`,
    );
  }

  const parts: string[] = [];
  let contentStart = 0;
  let activeIndex: number | undefined;
  let expectedIndex = 0;
  for (const current of markers) {
    if (activeIndex === undefined) {
      if (current.role !== "open") {
        throw invalidProtectedText(
          `${label} closes protected part ${current.index} before it is opened.`,
        );
      }
      if (current.index !== expectedIndex) {
        throw invalidProtectedText(
          `${label} reorders or contains an unknown protected part: expected ${expectedIndex}, received ${current.index}.`,
        );
      }
      if (value.slice(contentStart, current.start).length > 0) {
        throw invalidProtectedText(
          `${label} contains text outside protected part ${expectedIndex}.`,
        );
      }
      activeIndex = current.index;
      contentStart = current.end;
      continue;
    }

    if (current.role === "open") {
      throw invalidProtectedText(
        `${label} illegally nests protected part ${current.index} inside part ${activeIndex}.`,
      );
    }
    if (current.index !== activeIndex) {
      throw invalidProtectedText(
        `${label} closes protected part ${current.index} while part ${activeIndex} is open.`,
      );
    }
    parts.push(value.slice(contentStart, current.start));
    activeIndex = undefined;
    expectedIndex += 1;
    contentStart = current.end;
  }

  if (activeIndex !== undefined) {
    throw invalidProtectedText(
      `${label} is missing the closing marker for protected part ${activeIndex}.`,
    );
  }
  if (value.slice(contentStart).length > 0) {
    throw invalidProtectedText(
      `${label} contains text after its final marker.`,
    );
  }
  return { markers, parts, salt };
}

function deterministicSalt(parts: readonly string[]): string {
  for (let value = 0; value < Number.MAX_SAFE_INTEGER; value += 1) {
    const salt = value.toString(36);
    const prefix = markerPrefix(salt);
    if (parts.every((part) => !part.includes(prefix))) return salt;
  }
  throw new RangeError("Unable to allocate a protected text marker namespace.");
}

const PROTECTED_PREFIX_PATTERN = /\uE000NT1:([0-9a-z]+):/gu;

function canonicalSaltValues(value: string): number[] {
  const salts: number[] = [];
  PROTECTED_PREFIX_PATTERN.lastIndex = 0;
  for (
    let match = PROTECTED_PREFIX_PATTERN.exec(value);
    match;
    match = PROTECTED_PREFIX_PATTERN.exec(value)
  ) {
    const rawSalt = match[1];
    if (!rawSalt) continue;
    const salt = Number.parseInt(rawSalt, 36);
    if (
      Number.isSafeInteger(salt) &&
      salt >= 0 &&
      salt.toString(36) === rawSalt
    ) {
      salts.push(salt);
    }
  }
  PROTECTED_PREFIX_PATTERN.lastIndex = 0;
  return salts;
}

export interface ProtectedTextLengthCounter {
  /** Appends one part and returns the exact encoded length after the append. */
  append(part: string): number;
  readonly length: number;
}

/**
 * Incrementally tracks the exact protected payload length. Marker namespaces
 * found in later parts can change the deterministic salt, so the counter also
 * adjusts the already-accounted marker overhead without rescanning old parts.
 */
export function createProtectedTextLengthCounter(): ProtectedTextLengthCounter {
  const forbiddenSalts = new Set<number>();
  let saltValue = 0;
  let salt = "0";
  let partCount = 0;
  let length = 0;

  return {
    append(part) {
      for (const forbidden of canonicalSaltValues(part)) {
        forbiddenSalts.add(forbidden);
      }
      if (forbiddenSalts.has(saltValue)) {
        const previousSaltLength = salt.length;
        while (forbiddenSalts.has(saltValue)) {
          if (saltValue === Number.MAX_SAFE_INTEGER) {
            throw new RangeError(
              "Unable to allocate a protected text marker namespace.",
            );
          }
          saltValue += 1;
        }
        salt = saltValue.toString(36);
        length += 2 * (salt.length - previousSaltLength) * partCount;
      }

      length +=
        part.length +
        marker(salt, partCount, "open").length +
        marker(salt, partCount, "close").length;
      partCount += 1;
      return length;
    },
    get length() {
      return length;
    },
  };
}

/**
 * Encodes one semantic sentence without losing the Text-node boundaries that
 * the renderer must later restore. The first non-conflicting salt is selected,
 * so the result is deterministic even if the page contains marker-like text.
 */
export function createProtectedText(parts: readonly string[]): string {
  if (parts.length === 0) {
    throw new TypeError("Protected text requires at least one part.");
  }
  const salt = deterministicSalt(parts);
  return parts
    .map(
      (part, index) =>
        `${marker(salt, index, "open")}${part}${marker(salt, index, "close")}`,
    )
    .join("");
}

/** Returns the exact encoded length without allocating the encoded payload. */
export function protectedTextLength(parts: readonly string[]): number {
  if (parts.length === 0) {
    throw new TypeError("Protected text requires at least one part.");
  }
  const counter = createProtectedTextLengthCounter();
  for (const part of parts) counter.append(part);
  return counter.length;
}

/**
 * Strictly validates translated markers against the source and returns content
 * in original Text-node order. No marker may be missing, duplicated, unknown,
 * reordered, or nested.
 */
export function validateProtectedTranslation(
  sourceText: string,
  translatedText: string,
): string[] {
  const source = parseCanonicalProtectedText(sourceText, "Protected source");
  const translated = parseCanonicalProtectedText(
    translatedText,
    "Protected translation",
    source.salt,
  );
  const expectedTokens = source.markers.map((candidate) => candidate.token);
  const receivedTokens = translated.markers.map((candidate) => candidate.token);
  const expectedCounts = new Map<string, number>();
  const receivedCounts = new Map<string, number>();
  for (const token of expectedTokens) {
    expectedCounts.set(token, (expectedCounts.get(token) ?? 0) + 1);
  }
  for (const token of receivedTokens) {
    receivedCounts.set(token, (receivedCounts.get(token) ?? 0) + 1);
  }
  const missing = expectedTokens.filter(
    (token) =>
      (receivedCounts.get(token) ?? 0) < (expectedCounts.get(token) ?? 0),
  );
  const unknown = receivedTokens.filter((token) => !expectedCounts.has(token));
  const duplicate = receivedTokens.filter(
    (token) =>
      (receivedCounts.get(token) ?? 0) > (expectedCounts.get(token) ?? 0),
  );
  const sourceMarkerTokens = new Set(
    genericMarkers(sourceText).map(({ token }) => token),
  );
  const foreignTokens = genericMarkers(translatedText).filter(
    ({ token }) => !sourceMarkerTokens.has(token),
  );
  if (
    missing.length > 0 ||
    unknown.length > 0 ||
    duplicate.length > 0 ||
    foreignTokens.length > 0
  ) {
    throw invalidProtectedText(
      `Protected marker mismatch: missing=${missing.length}, duplicate=${duplicate.length}, unknown=${unknown.length + foreignTokens.length}.`,
    );
  }
  if (
    expectedTokens.length !== receivedTokens.length ||
    expectedTokens.some((token, index) => token !== receivedTokens[index])
  ) {
    throw invalidProtectedText("Protected markers were reordered.");
  }
  if (translated.parts.every((part) => !part.trim())) {
    throw invalidProtectedText(
      "Protected translation contains no translated text.",
    );
  }
  return translated.parts;
}

export function parseProtectedText(
  sourceText: string,
  translatedText: string,
): string[] | undefined {
  try {
    return validateProtectedTranslation(sourceText, translatedText);
  } catch (error) {
    if (error instanceof NorixorTransError) return undefined;
    throw error;
  }
}

export function plainTextFromProtectedText(
  sourceText: string,
  translatedText: string,
): string | undefined {
  return parseProtectedText(sourceText, translatedText)?.join("");
}

/** Returns the canonical source parts without exposing marker internals. */
export function protectedTextParts(sourceText: string): string[] {
  return [...parseCanonicalProtectedText(sourceText, "Protected source").parts];
}

/**
 * Rebuilds a translated protected value with the source's exact marker tokens.
 * This is used only as a recovery path when a Provider cannot preserve several
 * private-use markers in one completion.
 */
export function rebuildProtectedTranslation(
  sourceText: string,
  translatedParts: readonly string[],
): string {
  const source = parseCanonicalProtectedText(sourceText, "Protected source");
  if (translatedParts.length !== source.parts.length) {
    throw invalidProtectedText(
      `Protected translation part count mismatch: expected ${source.parts.length}, received ${translatedParts.length}.`,
    );
  }
  const rebuilt = translatedParts
    .map((part, index) => {
      const opening = source.markers[index * 2];
      const closing = source.markers[index * 2 + 1];
      if (!opening || !closing) {
        throw invalidProtectedText(
          `Protected source marker pair ${index} is incomplete.`,
        );
      }
      return `${opening.token}${part}${closing.token}`;
    })
    .join("");
  validateProtectedTranslation(sourceText, rebuilt);
  return rebuilt;
}

export function assertValidProtectedTranslation(
  segment: Pick<TranslationSegment, "text" | "format">,
  translatedText: string,
): void {
  if (segment.format !== PROTECTED_TEXT_FORMAT) return;
  validateProtectedTranslation(segment.text, translatedText);
}
