import { languageTagsMatch } from "@/src/shared/languages";
import { parseCapturedVtt } from "@/src/subtitles/adapters/captured-vtt";
import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";

export const MAX_DASH_SEGMENTS = 1_200;
export const MAX_DASH_TOTAL_CHARACTERS = 4_500_000;
export const MAX_DASH_PREFETCH_CONCURRENCY = 4;

export interface MaxDashSegmentPlan {
  number: number;
  time: number;
  offsetMs: number;
  url: string;
}

export interface MaxDashTrackPlan {
  language: string;
  label?: string;
  forced: boolean;
  segments: MaxDashSegmentPlan[];
}

export interface MaxDashFullTrackBody {
  kind: "max-dash-vtt-full";
  language: string;
  segments: Array<{ body: string; offsetMs: number }>;
}

export type MaxDashFetch = (
  url: string,
  init: { credentials: "same-origin"; signal: AbortSignal },
) => Promise<Response>;

function directChildren(element: Element, localName: string): Element[] {
  return [...element.children].filter(
    (candidate) => candidate.localName === localName,
  );
}

function directChild(element: Element, localName: string): Element | null {
  return (
    [...element.children].find(
      (candidate) => candidate.localName === localName,
    ) ?? null
  );
}

function resolvedBaseUrl(parentBase: string, element: Element): string | null {
  const value = directChild(element, "BaseURL")?.textContent?.trim();
  if (!value) return parentBase;
  try {
    return new URL(value, parentBase).href;
  } catch {
    return null;
  }
}

function finiteIntegerAttribute(
  elements: readonly Element[],
  name: string,
  fallback: number,
): number | null {
  const raw = elements
    .map((element) => element.getAttribute(name))
    .find((value): value is string => value !== null);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function inheritedAttribute(
  elements: readonly Element[],
  name: string,
): string | null {
  return (
    elements
      .map((element) => element.getAttribute(name))
      .find((value): value is string => value !== null) ?? null
  );
}

function timelineFromTemplates(templates: readonly Element[]): Element | null {
  return (
    templates
      .map((template) => directChild(template, "SegmentTimeline"))
      .find((timeline): timeline is Element => timeline !== null) ?? null
  );
}

function expandFiniteTimeline(
  timeline: Element,
  startNumber: number,
): Array<{ number: number; time: number }> | null {
  const segments: Array<{ number: number; time: number }> = [];
  let number = startNumber;
  let nextTime = 0;

  for (const entry of directChildren(timeline, "S")) {
    const duration = finiteIntegerAttribute([entry], "d", 0);
    const repeat = finiteIntegerAttribute([entry], "r", 0);
    const explicitTime = finiteIntegerAttribute([entry], "t", nextTime);
    if (
      duration === null ||
      duration <= 0 ||
      repeat === null ||
      repeat < 0 ||
      explicitTime === null ||
      explicitTime < 0
    ) {
      return null;
    }
    nextTime = explicitTime;
    if (segments.length + repeat + 1 > MAX_DASH_SEGMENTS) return null;
    for (let index = 0; index <= repeat; index += 1) {
      segments.push({ number, time: nextTime });
      number += 1;
      nextTime += duration;
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(nextTime)) {
        return null;
      }
    }
  }

  return segments.length > 0 ? segments : null;
}

function substituteDashTemplate(
  template: string,
  values: {
    bandwidth: string;
    number: number;
    representationId: string;
    time: number;
  },
): string | null {
  let valid = true;
  const substituted = template.replace(
    /\$(?:\$|(RepresentationID|Bandwidth|Number|Time)(?:%0(\d{1,2})d)?\$)/gu,
    (match, identifier: string | undefined, widthValue: string | undefined) => {
      if (match === "$$") return "$";
      if (!identifier) {
        valid = false;
        return "";
      }
      let value: string;
      if (identifier === "RepresentationID") {
        value = values.representationId;
      } else if (identifier === "Bandwidth") {
        value = values.bandwidth;
      } else {
        value = String(identifier === "Number" ? values.number : values.time);
      }
      if (!value) {
        valid = false;
        return "";
      }
      if (widthValue) {
        const width = Number(widthValue);
        if (!Number.isInteger(width) || width < 1 || width > 20) {
          valid = false;
          return "";
        }
        value = value.padStart(width, "0");
      }
      return value;
    },
  );
  if (!valid || /\$[^$]*\$/u.test(substituted)) return null;
  return substituted;
}

function adaptationIsTextVtt(adaptation: Element): boolean {
  const adaptationMime = adaptation.getAttribute("mimeType")?.toLowerCase();
  if (adaptationMime === "text/vtt") return true;
  if (adaptation.getAttribute("contentType")?.toLowerCase() !== "text") {
    return false;
  }
  return directChildren(adaptation, "Representation").some(
    (representation) =>
      (
        representation.getAttribute("mimeType") ?? adaptationMime
      )?.toLowerCase() === "text/vtt",
  );
}

function representationForVtt(adaptation: Element): Element | null {
  const representations = directChildren(adaptation, "Representation");
  if (representations.length === 0) return adaptation;
  return (
    representations.find(
      (representation) =>
        (
          representation.getAttribute("mimeType") ??
          adaptation.getAttribute("mimeType")
        )?.toLowerCase() === "text/vtt",
    ) ?? null
  );
}

function forcedTrack(adaptation: Element): boolean {
  return directChildren(adaptation, "Role").some(
    (role) => role.getAttribute("value")?.toLowerCase() === "forced-subtitle",
  );
}

/**
 * Parses only finite, static, single-period DASH VOD manifests. Unsupported or
 * ambiguous manifests intentionally produce no full-track plans.
 */
export function parseMaxDashTextTracks(
  input: string,
  manifestUrl: string,
  isAllowedUrl: (url: string) => boolean,
): MaxDashTrackPlan[] {
  if (!/^https:\/\//iu.test(manifestUrl) || /<!DOCTYPE/iu.test(input))
    return [];
  const documentValue = new DOMParser().parseFromString(
    input,
    "application/xml",
  );
  if (documentValue.getElementsByTagName("parsererror").length > 0) return [];
  const mpd = documentValue.documentElement;
  if (
    mpd.localName !== "MPD" ||
    mpd.getAttribute("type")?.toLowerCase() === "dynamic"
  ) {
    return [];
  }
  const periods = directChildren(mpd, "Period");
  if (periods.length !== 1) return [];
  const period = periods[0];
  if (!period) return [];

  const documentBase = resolvedBaseUrl(manifestUrl, mpd);
  if (!documentBase) return [];
  const periodBase = resolvedBaseUrl(documentBase, period);
  if (!periodBase) return [];

  const tracks: MaxDashTrackPlan[] = [];
  for (const adaptation of directChildren(period, "AdaptationSet")) {
    if (!adaptationIsTextVtt(adaptation)) continue;
    const representation = representationForVtt(adaptation);
    if (!representation) continue;
    const adaptationTemplate = directChild(adaptation, "SegmentTemplate");
    const representationTemplate =
      representation === adaptation
        ? null
        : directChild(representation, "SegmentTemplate");
    const templates = [representationTemplate, adaptationTemplate].filter(
      (template): template is Element => template !== null,
    );
    if (templates.length === 0) continue;
    const media = inheritedAttribute(templates, "media");
    const timeline = timelineFromTemplates(templates);
    const startNumber = finiteIntegerAttribute(templates, "startNumber", 1);
    const timescale = finiteIntegerAttribute(templates, "timescale", 1);
    if (
      !media ||
      !timeline ||
      startNumber === null ||
      startNumber < 0 ||
      timescale === null ||
      timescale <= 0
    )
      continue;
    const timelineSegments = expandFiniteTimeline(timeline, startNumber);
    if (!timelineSegments) continue;

    const adaptationBase = resolvedBaseUrl(periodBase, adaptation);
    const representationBase =
      adaptationBase && representation !== adaptation
        ? resolvedBaseUrl(adaptationBase, representation)
        : adaptationBase;
    if (!representationBase) continue;
    const representationId = representation.getAttribute("id") ?? "";
    const bandwidth = representation.getAttribute("bandwidth") ?? "";
    const segments: MaxDashSegmentPlan[] = [];
    let unsafe = false;
    for (const segment of timelineSegments) {
      const path = substituteDashTemplate(media, {
        bandwidth,
        number: segment.number,
        representationId,
        time: segment.time,
      });
      if (!path) {
        unsafe = true;
        break;
      }
      let url: string;
      try {
        url = new URL(path, representationBase).href;
      } catch {
        unsafe = true;
        break;
      }
      if (!isAllowedUrl(url)) {
        unsafe = true;
        break;
      }
      const offsetMs = Math.round((segment.time / timescale) * 1_000);
      if (!Number.isSafeInteger(offsetMs) || offsetMs < 0) {
        unsafe = true;
        break;
      }
      segments.push({ ...segment, offsetMs, url });
    }
    if (unsafe || segments.length !== timelineSegments.length) return [];

    const language =
      adaptation.getAttribute("lang") ??
      representation.getAttribute("lang") ??
      "und";
    const label = directChild(adaptation, "Label")?.textContent?.trim();
    tracks.push({
      language,
      ...(label ? { label } : {}),
      forced: forcedTrack(adaptation),
      segments,
    });
  }
  return tracks;
}

export function selectMaxDashTextTrack(
  tracks: readonly MaxDashTrackPlan[],
  preferredLanguage: string,
): MaxDashTrackPlan | null {
  const candidates =
    preferredLanguage === "auto"
      ? [...tracks]
      : tracks.filter((track) =>
          languageTagsMatch(preferredLanguage, track.language),
        );
  return candidates.find((track) => !track.forced) ?? candidates[0] ?? null;
}

export function isMaxDashFullTrackBody(
  value: unknown,
): value is MaxDashFullTrackBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<MaxDashFullTrackBody>;
  if (
    body.kind !== "max-dash-vtt-full" ||
    typeof body.language !== "string" ||
    body.language.length === 0 ||
    body.language.length > 64 ||
    !Array.isArray(body.segments) ||
    body.segments.length === 0 ||
    body.segments.length > MAX_DASH_SEGMENTS ||
    !body.segments.every(
      (segment) =>
        typeof segment === "object" &&
        segment !== null &&
        typeof segment.body === "string" &&
        segment.body.length > 0 &&
        segment.body.length <= MAX_DASH_TOTAL_CHARACTERS &&
        typeof segment.offsetMs === "number" &&
        Number.isSafeInteger(segment.offsetMs) &&
        segment.offsetMs >= 0,
    )
  ) {
    return false;
  }
  return (
    body.segments.reduce((total, segment) => total + segment.body.length, 0) <=
    MAX_DASH_TOTAL_CHARACTERS
  );
}

/** Fetches every planned VTT segment or returns null without a partial result. */
export async function fetchMaxDashFullTrack(
  plan: MaxDashTrackPlan,
  fetchValue: MaxDashFetch,
  signal: AbortSignal,
  isAllowedResponseUrl: (url: string) => boolean = () => true,
): Promise<MaxDashFullTrackBody | null> {
  if (
    plan.segments.length === 0 ||
    plan.segments.length > MAX_DASH_SEGMENTS ||
    signal.aborted
  ) {
    return null;
  }
  const bodies = new Array<{ body: string; offsetMs: number }>(
    plan.segments.length,
  );
  let nextIndex = 0;
  let totalCharacters = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed && !signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const segment = plan.segments[index];
      if (!segment) return;
      try {
        const response = await fetchValue(segment.url, {
          credentials: "same-origin",
          signal,
        });
        if (
          !response.ok ||
          response.status === 206 ||
          Boolean(response.headers.get("content-range")) ||
          (response.url.length > 0 && !isAllowedResponseUrl(response.url))
        ) {
          failed = true;
          return;
        }
        const contentLength = Number(response.headers.get("content-length"));
        if (
          Number.isFinite(contentLength) &&
          (contentLength < 0 ||
            contentLength > MAX_DASH_TOTAL_CHARACTERS - totalCharacters)
        ) {
          failed = true;
          return;
        }
        const body = await response.text();
        if (!/^WEBVTT(?:\s|$)/u.test(body.replace(/^\uFEFF/u, ""))) {
          failed = true;
          return;
        }
        totalCharacters += body.length;
        if (totalCharacters > MAX_DASH_TOTAL_CHARACTERS) {
          failed = true;
          return;
        }
        const parsed = parseCapturedVtt(body, plan.language);
        if (body.includes("-->") && parsed.cues.length === 0) {
          failed = true;
          return;
        }
        bodies[index] = { body, offsetMs: segment.offsetMs };
      } catch {
        failed = true;
        return;
      }
    }
  };

  await Promise.all(
    Array.from(
      {
        length: Math.min(MAX_DASH_PREFETCH_CONCURRENCY, plan.segments.length),
      },
      () => worker(),
    ),
  );
  if (failed || signal.aborted || bodies.some((body) => body === undefined)) {
    return null;
  }
  return {
    kind: "max-dash-vtt-full",
    language: plan.language,
    segments: bodies,
  };
}

function fnv1a(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function assembleMaxDashFullTrack(
  body: MaxDashFullTrackBody,
): SubtitleTrack | null {
  if (!isMaxDashFullTrackBody(body)) return null;
  const cues = new Map<string, SubtitleCue>();
  for (const segment of body.segments) {
    const parsed = parseCapturedVtt(segment.body, body.language);
    if (segment.body.includes("-->") && parsed.cues.length === 0) return null;
    const hasTimestampMap = /^\s*X-TIMESTAMP-MAP\s*=/imu.test(segment.body);
    for (const parsedCue of parsed.cues) {
      const cue = hasTimestampMap
        ? parsedCue
        : {
            ...parsedCue,
            startMs: parsedCue.startMs + segment.offsetMs,
            endMs:
              parsedCue.endMs === null
                ? null
                : parsedCue.endMs + segment.offsetMs,
          };
      const identity = `${cue.startMs}\u001f${cue.originalText}`;
      const existing = cues.get(identity);
      if (existing) {
        if (existing.endMs === null) existing.endMs = cue.endMs;
        else if (cue.endMs !== null)
          existing.endMs = Math.max(existing.endMs, cue.endMs);
        continue;
      }
      cues.set(identity, {
        ...cue,
        id: `network:max-dash:${cue.startMs}:${fnv1a(cue.originalText)}`,
      });
    }
  }
  const ordered = [...cues.values()].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      (left.endMs ?? Number.MAX_SAFE_INTEGER) -
        (right.endMs ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
  );
  if (ordered.length === 0) return null;
  return {
    source: "network",
    completeness: "full",
    captureEvidence: "verified-full-response",
    language: body.language,
    cues: ordered,
  };
}
