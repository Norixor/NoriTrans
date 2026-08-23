import type { SubtitleSource, SubtitleTrack } from "@/src/subtitles/types";
import { createCue, MAX_SUBTITLE_CUES } from "@/src/subtitles/parsers/shared";

interface TtmlRates {
  frameRate: number;
  subFrameRate: number;
  tickRate: number;
}

const OFFSET_TIME_PATTERN = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/u;
const FRAME_TIME_PATTERN = /^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.(\d+))?$/u;
const CLOCK_TIME_PATTERN = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/u;

export function parseTtml(
  input: string,
  language?: string,
  source: SubtitleSource = "network",
): SubtitleTrack {
  const document = new DOMParser().parseFromString(input, "application/xml");
  if (hasParserError(document)) {
    throw new Error("Invalid TTML subtitle document");
  }

  const root = document.documentElement;
  const rates = readRates(root);
  const paragraphElements = Array.from(
    document.getElementsByTagName("*"),
  ).filter((element) => element.localName.toLowerCase() === "p");
  const cues: SubtitleTrack["cues"] = [];

  for (const paragraph of paragraphElements) {
    if (cues.length >= MAX_SUBTITLE_CUES) break;
    const parentStartMs = calculateAncestorStartMs(
      paragraph.parentElement,
      root,
      rates,
    );
    const localBeginMs =
      parseTtmlTimeExpression(paragraph.getAttribute("begin"), rates) ?? 0;
    const startMs = parentStartMs + localBeginMs;
    const explicitEndMs = parseTtmlTimeExpression(
      paragraph.getAttribute("end"),
      rates,
    );
    const durationMs = parseTtmlTimeExpression(
      paragraph.getAttribute("dur"),
      rates,
    );
    const endMs =
      explicitEndMs !== null
        ? parentStartMs + explicitEndMs
        : durationMs !== null
          ? startMs + durationMs
          : null;
    const text = extractText(paragraph).trim();

    if (
      Number.isFinite(startMs) &&
      startMs >= 0 &&
      (endMs === null || endMs >= startMs) &&
      text.length > 0
    ) {
      cues.push(createCue(source, cues.length, startMs, endMs, text));
    }
  }

  return {
    source,
    completeness: "full",
    language: language ?? readDocumentLanguage(root) ?? "und",
    cues,
  };
}

export function parseTtmlTimeExpression(
  value: string | null,
  rates: Readonly<TtmlRates>,
): number | null {
  if (value === null) {
    return null;
  }

  const expression = value.trim();
  const clockMatch = CLOCK_TIME_PATTERN.exec(expression);
  if (clockMatch !== null) {
    const hours = Number(clockMatch[1]);
    const minutes = Number(clockMatch[2]);
    const seconds = Number(clockMatch[3]);
    const fraction = Number(`0.${clockMatch[4] ?? "0"}`);
    if (minutes >= 60 || seconds >= 60) {
      return null;
    }
    return ((hours * 60 + minutes) * 60 + seconds + fraction) * 1_000;
  }

  const frameMatch = FRAME_TIME_PATTERN.exec(expression);
  if (frameMatch !== null) {
    const hours = Number(frameMatch[1]);
    const minutes = Number(frameMatch[2]);
    const seconds = Number(frameMatch[3]);
    const frames = Number(frameMatch[4]);
    const subFrames = Number(frameMatch[5] ?? "0");
    if (
      minutes >= 60 ||
      seconds >= 60 ||
      rates.frameRate <= 0 ||
      rates.subFrameRate <= 0
    ) {
      return null;
    }
    const frameSeconds =
      (frames + subFrames / rates.subFrameRate) / rates.frameRate;
    return ((hours * 60 + minutes) * 60 + seconds + frameSeconds) * 1_000;
  }

  const offsetMatch = OFFSET_TIME_PATTERN.exec(expression);
  if (offsetMatch === null) {
    return null;
  }

  const amount = Number(offsetMatch[1]);
  const unit = offsetMatch[2];
  switch (unit) {
    case "h":
      return amount * 3_600_000;
    case "m":
      return amount * 60_000;
    case "s":
      return amount * 1_000;
    case "ms":
      return amount;
    case "f":
      return rates.frameRate > 0 ? (amount / rates.frameRate) * 1_000 : null;
    case "t":
      return rates.tickRate > 0 ? (amount / rates.tickRate) * 1_000 : null;
    default:
      return null;
  }
}

function readRates(root: Element): TtmlRates {
  const frameRate = readPositiveNumberAttribute(root, "frameRate") ?? 30;
  const subFrameRate = readPositiveNumberAttribute(root, "subFrameRate") ?? 1;
  const tickRate = readPositiveNumberAttribute(root, "tickRate") ?? 1;
  return { frameRate, subFrameRate, tickRate };
}

function readPositiveNumberAttribute(
  element: Element,
  localName: string,
): number | null {
  const attribute = Array.from(element.attributes).find(
    (candidate) => candidate.localName === localName,
  );
  if (attribute === undefined) {
    return null;
  }
  const value = Number(attribute.value);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readDocumentLanguage(root: Element): string | null {
  const languageAttribute = Array.from(root.attributes).find(
    (attribute) => attribute.localName === "lang",
  );
  return languageAttribute?.value.trim() || null;
}

function calculateAncestorStartMs(
  element: Element | null,
  root: Element,
  rates: Readonly<TtmlRates>,
): number {
  let startMs = 0;
  let current = element;
  while (current !== null) {
    startMs +=
      parseTtmlTimeExpression(current.getAttribute("begin"), rates) ?? 0;
    if (current === root) {
      break;
    }
    current = current.parentElement;
  }
  return startMs;
}

function extractText(element: Element): string {
  let text = "";
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) {
      text += node.nodeValue ?? "";
      continue;
    }
    if (node.nodeType !== 1) {
      continue;
    }

    const child = node as Element;
    text += child.localName.toLowerCase() === "br" ? "\n" : extractText(child);
  }
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .join("\n")
    .trim();
}

function hasParserError(document: Document): boolean {
  return Array.from(document.getElementsByTagName("*")).some(
    (element) => element.localName.toLowerCase() === "parsererror",
  );
}
