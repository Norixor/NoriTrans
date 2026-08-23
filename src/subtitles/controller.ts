import type {
  SubtitleStatus,
  TranslationResponse,
} from "@/src/messaging/protocol";
import type { NormalizedOcrRegion } from "@/src/ocr/types";
import {
  DEFAULT_SETTINGS,
  type ContentProviderSettings,
  type SubtitleCustomPosition,
  type SubtitleSettings,
} from "@/src/shared/settings";
import { languageTagsMatch } from "@/src/shared/languages";
import { message } from "@/src/shared/i18n";
import { Html5TextTrackAdapter } from "@/src/subtitles/adapters/html5";
import { NetflixSubtitleAdapter } from "@/src/subtitles/adapters/netflix";
import type { SubtitleAdapter } from "@/src/subtitles/adapters/types";
import { YouTubeTimedTextAdapter } from "@/src/subtitles/adapters/youtube";
import { SUBTITLE_DISCOVERY_CONTROL_EVENT } from "@/src/subtitles/adapters/captured";
import {
  groupForCue,
  groupFullSubtitleTrack,
  type SubtitleSentenceGroup,
} from "@/src/subtitles/groups";
import {
  SubtitleOverlay,
  subtitleCueVisibility,
} from "@/src/subtitles/overlay";
import { isPersistedFullTrack } from "@/src/subtitles/persisted-track";
import {
  normalizeSubtitleTrack,
  subtitleTrackFingerprint,
} from "@/src/subtitles/timeline";
import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";
import {
  selectActiveVideo,
  stableVideoCaptureScope,
  stableVideoPersistenceScope,
  videoSessionScope,
} from "@/src/subtitles/video-selection";
import type {
  TranslationMode,
  TranslationResult,
  TranslationSegment,
} from "@/src/translation/types";
import { ChromeLocalProvider } from "@/src/translation/providers/chrome-local";
import {
  contextualizeSegments,
  translationSegmentCacheText,
  translationSegmentReuseIdentity,
} from "@/src/translation/context";
import {
  normalizeTranslationText,
  scheduleTranslation,
} from "@/src/translation/scheduler";
import { subscribeTranslationProgress } from "@/src/translation/progress-channel";
import { browser } from "wxt/browser";
import { runtimeId } from "@/src/shared/runtime-id";
import { localizeRuntimeError } from "@/src/shared/runtime-errors";

export interface SubtitleTranslationCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, translatedText: string): Promise<void>;
}

export interface SubtitleTaskStore {
  getTrack(key: string): Promise<unknown>;
  setTrack(key: string, track: SubtitleTrack): Promise<void>;
  deleteTrack(key: string): Promise<void>;
}

export interface SubtitleProviderCacheContext {
  fastProviderId: string;
  aiProviderId: string;
  baseUrl: string;
  model: string;
  promptVersion: string;
}

export interface SubtitleControllerOptions {
  settings: SubtitleSettings;
  adapters?: SubtitleAdapter[];
  cache?: SubtitleTranslationCache;
  taskStore?: SubtitleTaskStore;
  providerCacheContext?: SubtitleProviderCacheContext;
  providerSettings?: ContentProviderSettings;
  onStatus?: (status: SubtitleStatus) => void;
  onTrackSelected?: (track: SubtitleTrack) => void;
  onVideoChange?: (video: HTMLVideoElement | null) => void;
  onCueVisibilityChange?: (visible: boolean) => void;
  onPositionChange?: (position: SubtitleCustomPosition) => Promise<void> | void;
}

const SOURCE_PRIORITY: Record<SubtitleTrack["source"], number> = {
  texttrack: 1,
  "youtube-timedtext": 2,
  "netflix-manifest": 3,
  network: 3,
  dom: 4,
  ocr: 5,
};

const FAST_BATCH_MAX_SEGMENTS = 20;
const FAST_BATCH_MAX_CHARACTERS = 4_000;
const AI_BATCH_MAX_SEGMENTS = 30;
const AI_BATCH_MAX_CHARACTERS = 9_000;
const FULL_TRACK_CONCURRENCY = 8;
const FULL_TRACK_CACHE_CONCURRENCY = 8;
const PROVIDER_CACHE_READ_TIMEOUT_MS = 500;
const FULL_TRACK_CACHE_LOOKUP_BUDGET_MS = PROVIDER_CACHE_READ_TIMEOUT_MS;
const SUBTITLE_CACHE_READ_TIMEOUT_MS = 200;
const STREAM_CONCURRENCY = 8;
const LOOKAHEAD_MS = 120_000;
const TRACK_INVALIDATION_GRACE_MS = 250;
const SUBTITLE_DISCOVERY_TIMEOUT_MS = 8_000;
const STREAM_STALE_BEHIND_PLAYBACK_MS = 1_500;
const STREAM_FRESH_TOLERANCE_MS = 1_000;
const STREAM_HANDOVER_HYSTERESIS_MS = 500;
const SUBTITLE_TRANSLATION_PROTOCOL_CACHE_VERSION = "explicit-segment-text-v3";

export function subtitlePromptVersion(prompt: string): string {
  let hash = 2_166_136_261;
  const versionedPrompt = `${SUBTITLE_TRANSLATION_PROTOCOL_CACHE_VERSION}\u001f${prompt}`;
  for (let index = 0; index < versionedPrompt.length; index += 1) {
    hash ^= versionedPrompt.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isTranslationResponse(value: unknown): value is TranslationResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

function mediaIdentity(
  video: HTMLVideoElement | null,
  mediaGeneration: number,
): string {
  const pageUrl = new URL(location.href);
  if (!/^#(?:!\/|\/)/u.test(pageUrl.hash)) pageUrl.hash = "";
  return [
    pageUrl.href,
    stableVideoCaptureScope(video, pageUrl.href),
    `generation:${mediaGeneration}`,
  ].join("|");
}

function persistentMediaIdentity(video: HTMLVideoElement | null): string {
  const pageUrl = new URL(location.href);
  if (!/^#(?:!\/|\/)/u.test(pageUrl.hash)) pageUrl.hash = "";
  return [pageUrl.href, stableVideoPersistenceScope(video, pageUrl.href)].join(
    "|",
  );
}

function trackIdentity(track: SubtitleTrack, mediaScope: string): string {
  return [mediaScope, subtitleTrackFingerprint(track)].join("|");
}

function suspensionTrackIdentity(track: SubtitleTrack): string {
  return [
    track.source,
    track.language,
    ...(track.completeness === "full" ? [subtitleTrackFingerprint(track)] : []),
  ].join("|");
}

function suspensionMediaIdentity(video: HTMLVideoElement | null): string {
  const pageUrl = new URL(location.href);
  if (!/^#(?:!\/|\/)/u.test(pageUrl.hash)) pageUrl.hash = "";
  return [pageUrl.href, videoSessionScope(video)].join("|");
}

function resolvedSourceLanguage(
  track: SubtitleTrack,
  settings: SubtitleSettings,
): string {
  if (settings.sourceLanguage !== "auto") return settings.sourceLanguage;
  return track.language === "und" ? "auto" : track.language;
}

function translationModeForTrack(
  track: SubtitleTrack,
  settings: SubtitleSettings,
): TranslationMode {
  // AI subtitle translation only has user-visible value when the complete
  // timeline is available ahead of playback. A live/DOM stream normally
  // contains only the current and already-watched cues, so an AI response can
  // arrive after the cue disappeared and spend tokens without ever rendering.
  // Keep every incomplete track on the low-latency provider; a later full-track
  // upgrade starts the normal AI pre-translation session automatically.
  return track.source === "ocr" || track.completeness === "stream"
    ? "fast"
    : settings.mode;
}

function translationSourceLanguage(
  track: SubtitleTrack,
  cues: readonly SubtitleCue[],
  settings: SubtitleSettings,
): string {
  const resolved = resolvedSourceLanguage(track, settings);
  if (track.source !== "ocr" || resolved !== "auto") return resolved;
  const sample = cues
    .map((cue) => cue.originalText)
    .join(" ")
    .slice(0, 1_000);
  return automaticOcrTranslationSourceLanguage(sample);
}

function automaticOcrTranslationSourceLanguage(sample: string): string {
  if (/\p{Script=Hangul}/u.test(sample)) return "ko";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sample)) return "ja";
  // Han-only text is ambiguous: natural Japanese captions frequently contain
  // no kana. Let Chrome's local LanguageDetector resolve it instead of
  // poisoning Japanese translations and cache entries as Simplified Chinese.
  return "auto";
}

function requiresAutomaticHanDetection(sample: string): boolean {
  return (
    /\p{Script=Han}/u.test(sample) &&
    !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(sample)
  );
}

function isReliableOcrLanguageSample(sample: string): boolean {
  const normalized = sample.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) return false;
  const kana = normalized.match(
    /[\p{Script=Hiragana}\p{Script=Katakana}]/gu,
  )?.length;
  if ((kana ?? 0) >= 3) return true;
  const hangul = normalized.match(/\p{Script=Hangul}/gu)?.length;
  if ((hangul ?? 0) >= 4) return true;
  const han = normalized.match(/\p{Script=Han}/gu)?.length;
  if ((han ?? 0) >= 4) return true;
  const latinWords = normalized.match(/\p{Script=Latin}{2,}/gu) ?? [];
  const latinLetters = latinWords.reduce(
    (total, word) => total + word.length,
    0,
  );
  return latinWords.length >= 2 && latinLetters >= 6;
}

function trackMatchesConfiguredSource(
  track: SubtitleTrack,
  configuredSource: string,
): boolean {
  if (configuredSource === "auto" || track.language === "und") return true;
  return languageTagsMatch(configuredSource, track.language);
}

function hasDecisiveStreamEvidence(track: SubtitleTrack): boolean {
  return (
    track.captureEvidence !== undefined &&
    track.captureEvidence !== "unknown" &&
    track.captureEvidence !== "verified-full-response"
  );
}

function streamFrontierMs(track: SubtitleTrack): number {
  return track.cues.reduce(
    (frontier, cue) => Math.max(frontier, cue.endMs ?? cue.startMs),
    Number.NEGATIVE_INFINITY,
  );
}

function cueAtPlaybackTime(
  track: SubtitleTrack,
  currentMs: number,
): SubtitleCue | undefined {
  let latestActiveCue: SubtitleCue | undefined;
  for (let index = 0; index < track.cues.length; index += 1) {
    const candidate = track.cues[index];
    if (!candidate) continue;
    if (candidate.startMs > currentMs) break;
    const endMs =
      candidate.endMs ??
      track.cues[index + 1]?.startMs ??
      Number.POSITIVE_INFINITY;
    if (currentMs >= endMs) continue;
    if (track.source !== "netflix-manifest") return candidate;
    // Netflix TTML can contain overlapping display intervals. The newly
    // started cue represents the current spoken line; keeping the first match
    // leaves an older line visible until its longer interval ends.
    latestActiveCue = candidate;
  }
  return latestActiveCue;
}

function cacheKey(
  mediaScope: string,
  track: SubtitleTrack,
  segment: TranslationSegment,
  settings: SubtitleSettings,
  mode: TranslationMode,
  provider: SubtitleProviderCacheContext,
  providerIdOverride?: string,
  sourceLanguageOverride?: string,
): string {
  const providerId =
    providerIdOverride ??
    (mode === "fast" ? provider.fastProviderId : provider.aiProviderId);
  const resolvedLanguage = resolvedSourceLanguage(track, settings);
  const effectiveSourceLanguage =
    sourceLanguageOverride ??
    (track.source === "ocr" && resolvedLanguage === "auto"
      ? automaticOcrTranslationSourceLanguage(segment.text)
      : resolvedLanguage);
  return [
    "subtitle-v1",
    mediaScope,
    track.source,
    providerId,
    provider.baseUrl,
    provider.model,
    provider.promptVersion,
    effectiveSourceLanguage,
    settings.targetLanguage,
    mode,
    translationSegmentCacheText(segment),
  ].join("\u001f");
}

function localProviderIdOverride(
  track: SubtitleTrack,
  mode: TranslationMode,
  destination: "primary" | "fallback",
  providerSettings: ContentProviderSettings,
): string | undefined {
  return mode === "fast" &&
    (destination === "fallback" ||
      track.source === "ocr" ||
      providerSettings.fastProvider === "chrome-local")
    ? "chrome-local"
    : undefined;
}

function translationSegments(
  track: SubtitleTrack,
  cues: readonly SubtitleCue[],
  mode: TranslationMode,
): TranslationSegment[] {
  const selected = cues.map((cue) => ({ id: cue.id, text: cue.originalText }));
  if (mode !== "ai") return selected;
  return contextualizeSegments(
    track.cues.map((cue) => ({ id: cue.id, text: cue.originalText })),
    selected,
  );
}

function orderedCues(
  track: SubtitleTrack,
  video: HTMLVideoElement | null,
): SubtitleCue[] {
  const currentMs = Math.round((video?.currentTime ?? 0) * 1_000);
  const lookaheadEnd = currentMs + LOOKAHEAD_MS;
  const upcoming = track.cues.filter(
    (cue) =>
      cue.startMs <= lookaheadEnd &&
      (cue.endMs ?? cue.startMs + 2_000) >= currentMs,
  );
  const upcomingIds = new Set(upcoming.map((cue) => cue.id));
  const remainingFuture = track.cues.filter(
    (cue) => cue.startMs > lookaheadEnd,
  );
  const past = track.cues.filter(
    (cue) => cue.startMs <= lookaheadEnd && !upcomingIds.has(cue.id),
  );
  return [...upcoming, ...remainingFuture, ...past];
}

function urgentFullTrackCues(
  track: SubtitleTrack,
  ordered: readonly SubtitleCue[],
  video: HTMLVideoElement | null,
): SubtitleCue[] {
  const currentMs = Math.round((video?.currentTime ?? 0) * 1_000);
  const lookaheadEnd = currentMs + LOOKAHEAD_MS;
  const urgent = ordered.filter(
    (cue) =>
      cue.startMs <= lookaheadEnd &&
      (cue.endMs ?? cue.startMs + 2_000) >= currentMs,
  );
  return urgent.length > 0 ? urgent : ordered.slice(0, 1);
}

function orderedStreamCues(
  track: SubtitleTrack,
  video: HTMLVideoElement | null,
): SubtitleCue[] {
  if (!video) return [...track.cues].reverse();
  const currentMs = Math.round(video.currentTime * 1_000);
  const current = track.cues.find((cue, index) => {
    const inferredEnd =
      track.cues[index + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    return cue.startMs <= currentMs && currentMs < (cue.endMs ?? inferredEnd);
  });
  const remaining = track.cues.filter((cue) => cue !== current);
  const future = remaining
    .filter((cue) => cue.startMs >= currentMs)
    .sort((left, right) => left.startMs - right.startMs);
  const past = remaining
    .filter((cue) => cue.startMs < currentMs)
    .sort((left, right) => right.startMs - left.startMs);
  return current ? [current, ...future, ...past] : [...future, ...past];
}

function translationSegmentCharacters(segment: TranslationSegment): number {
  return (
    segment.text.length +
    (segment.contextBefore ?? []).reduce(
      (total, context) => total + context.length,
      0,
    ) +
    (segment.contextAfter ?? []).reduce(
      (total, context) => total + context.length,
      0,
    )
  );
}

function createSubtitleBatches(
  track: SubtitleTrack,
  cues: SubtitleCue[],
  mode: TranslationMode,
): SubtitleCue[][] {
  const segments = translationSegments(track, cues, mode);
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const maxSegments =
    mode === "ai" ? AI_BATCH_MAX_SEGMENTS : FAST_BATCH_MAX_SEGMENTS;
  const maxCharacters =
    mode === "ai" ? AI_BATCH_MAX_CHARACTERS : FAST_BATCH_MAX_CHARACTERS;
  const batches: SubtitleCue[][] = [];
  let batch: SubtitleCue[] = [];
  let characters = 0;

  for (const cue of cues) {
    const segment = segmentById.get(cue.id);
    const nextCharacters = segment
      ? translationSegmentCharacters(segment)
      : cue.originalText.length;
    if (
      batch.length > 0 &&
      (batch.length >= maxSegments ||
        characters + nextCharacters > maxCharacters)
    ) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(cue);
    characters += nextCharacters;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

interface FullTrackReusePlan {
  representativeCues: SubtitleCue[];
  representativeIdByCueId: ReadonlyMap<string, string>;
  equivalentCuesByRepresentativeId: ReadonlyMap<string, readonly SubtitleCue[]>;
  segmentsById: ReadonlyMap<string, TranslationSegment>;
}

let rememberedMediaTitle: { pageIdentity: string; title: string } | undefined;

/**
 * Deduplicate a complete translation task before it is split into concurrent
 * Provider batches. Stable cue IDs remain available for rendering and cache
 * mapping; only one representative of identical normalized text is sent.
 */
function createFullTrackReusePlan(
  track: SubtitleTrack,
  cues: readonly SubtitleCue[],
  mode: TranslationMode,
): FullTrackReusePlan {
  const segments = translationSegments(track, cues, mode);
  const segmentsById = new Map(
    segments.map((segment) => [segment.id, segment]),
  );
  const representativeByIdentity = new Map<string, SubtitleCue>();
  const representativeIdByCueId = new Map<string, string>();
  const equivalentCuesByRepresentativeId = new Map<string, SubtitleCue[]>();
  const representativeCues: SubtitleCue[] = [];

  for (const cue of cues) {
    const segment = segmentsById.get(cue.id);
    if (!segment) continue;
    const identity = translationSegmentReuseIdentity(segment);
    let representative = representativeByIdentity.get(identity);
    if (!representative) {
      representative = cue;
      representativeByIdentity.set(identity, cue);
      representativeCues.push(cue);
      equivalentCuesByRepresentativeId.set(cue.id, []);
    }
    representativeIdByCueId.set(cue.id, representative.id);
    equivalentCuesByRepresentativeId.get(representative.id)?.push(cue);
  }

  return {
    representativeCues,
    representativeIdByCueId,
    equivalentCuesByRepresentativeId,
    segmentsById,
  };
}

function pageMediaTitle(): string | undefined {
  const pageUrl = new URL(location.href);
  pageUrl.hash = "";
  const pageIdentity = pageUrl.href;
  const candidates = [
    navigator.mediaSession?.metadata?.title,
    document.title,
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')
      ?.content,
    document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')
      ?.content,
  ];
  for (const candidate of candidates) {
    const title = candidate?.normalize("NFC").replace(/\s+/gu, " ").trim();
    if (
      title &&
      title.length > 1 &&
      !/^(?:Netflix|YouTube|Prime Video|Disney\+|Max)$/iu.test(title)
    ) {
      const boundedTitle = title.slice(0, 300);
      rememberedMediaTitle = { pageIdentity, title: boundedTitle };
      return boundedTitle;
    }
  }
  return rememberedMediaTitle?.pageIdentity === pageIdentity
    ? rememberedMediaTitle.title
    : undefined;
}

function mediaTitleForTranslation(
  track: SubtitleTrack,
  mode: TranslationMode,
): string | undefined {
  return mode === "ai" && track.completeness === "full"
    ? pageMediaTitle()
    : undefined;
}

function translationCacheScope(
  mediaScope: string,
  mediaTitle?: string,
): string {
  return mediaTitle
    ? [mediaScope, `media-title:${mediaTitle}`].join("\u001f")
    : mediaScope;
}

function createRetryBatches(
  track: SubtitleTrack,
  cues: SubtitleCue[],
  mode: TranslationMode,
  settings: SubtitleSettings,
): SubtitleCue[][] {
  if (track.source !== "ocr") return createSubtitleBatches(track, cues, mode);

  // Keep pre-lock OCR retries conservative; translateBatch applies the source
  // language locked for the current OCR session once it is available.
  const cuesBySourceLanguage = new Map<string, SubtitleCue[]>();
  for (const cue of cues) {
    const sourceLanguage = translationSourceLanguage(track, [cue], settings);
    const groupKey =
      sourceLanguage === "auto" &&
      requiresAutomaticHanDetection(cue.originalText)
        ? "auto:han"
        : sourceLanguage;
    const group = cuesBySourceLanguage.get(groupKey) ?? [];
    group.push(cue);
    cuesBySourceLanguage.set(groupKey, group);
  }
  return [...cuesBySourceLanguage.values()].flatMap((group) =>
    createSubtitleBatches(track, group, mode),
  );
}

function validateResults(
  cues: SubtitleCue[],
  results: TranslationResult[],
): Map<string, string> | null {
  const expected = new Set(cues.map((cue) => cue.id));
  const translated = new Map<string, string>();
  for (const result of results) {
    if (
      !expected.has(result.id) ||
      translated.has(result.id) ||
      !result.translatedText.trim()
    )
      return null;
    translated.set(result.id, result.translatedText);
  }
  return translated.size === expected.size ? translated : null;
}

async function readCachedTranslation(
  cache: SubtitleTranslationCache,
  key: string,
  timeoutMs = SUBTITLE_CACHE_READ_TIMEOUT_MS,
): Promise<string | undefined> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      cache.get(key),
      new Promise<undefined>((resolve) => {
        timeout = window.setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

export class SubtitleController {
  private settings: SubtitleSettings;
  private readonly adapters: SubtitleAdapter[];
  private readonly cache: SubtitleTranslationCache | undefined;
  private readonly taskStore: SubtitleTaskStore | undefined;
  private providerCacheContext: SubtitleProviderCacheContext;
  private readonly onStatus: ((status: SubtitleStatus) => void) | undefined;
  private readonly onTrackSelected:
    ((track: SubtitleTrack) => void) | undefined;
  private readonly onVideoChange:
    ((video: HTMLVideoElement | null) => void) | undefined;
  private readonly onCueVisibilityChange:
    ((visible: boolean) => void) | undefined;
  private readonly overlay: SubtitleOverlay;
  private readonly translated = new Map<string, string>();
  private readonly fallbackTranslated = new Map<string, string>();
  private readonly fallbackFailedCueIds = new Set<string>();
  private readonly fallbackInFlightCueIds = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly pendingRequestIds = new Set<string>();
  private readonly localControllers = new Set<AbortController>();
  private ocrLocalProvider: ChromeLocalProvider | undefined;
  private ocrLocalProviderTargetLanguage = "";
  private ocrDetectedSourceLanguage = "";
  private readonly ocrResolvedSourceLanguageByCueId = new Map<string, string>();
  private readonly inFlightCueIds = new Set<string>();
  private readonly pendingStreamCueIds = new Set<string>();
  private readonly adapterUnsubscribers = new Map<
    SubtitleAdapter,
    Array<() => void>
  >();
  private currentTrack: SubtitleTrack | null = null;
  private translationTrack: SubtitleTrack | null = null;
  private currentTrackIdentity = "";
  private currentMediaIdentity = "";
  private lastRestoredTrackKey = "";
  private persistedTrackMutation: Promise<void> = Promise.resolve();
  private mediaGeneration = 0;
  private streamHandoverSource: SubtitleTrack["source"] | null = null;
  private streamHandoverFloorMs = Number.NEGATIVE_INFINITY;
  private translationSuspended = false;
  private suspendedMediaIdentity = "";
  private suspendedTrackIdentity = "";
  private providerSettings: ContentProviderSettings;
  private active = false;
  private session = 0;
  private scanTimer: number | undefined;
  private discoveryTimeout: number | undefined;
  private trackResetTimer: number | undefined;
  private translationFailureMessage: string | undefined;
  private translationFailureDetails: string | undefined;
  private video: HTMLVideoElement | null = null;
  private lastActivatedVideo: HTMLVideoElement | null = null;
  private ocrMediaTarget: HTMLElement | null = null;
  private cueOverlayVisible = false;
  private status: SubtitleStatus = {
    state: "waiting",
    total: 0,
    completed: 0,
    failed: 0,
  };

  constructor(options: SubtitleControllerOptions) {
    this.settings = options.settings;
    this.adapters = (
      options.adapters ?? [
        new Html5TextTrackAdapter(),
        new YouTubeTimedTextAdapter(),
        new NetflixSubtitleAdapter(),
      ]
    ).filter((adapter) => adapter.matches(location));
    for (const adapter of this.adapters)
      adapter.setSourceLanguage?.(options.settings.sourceLanguage);
    this.cache = options.cache;
    this.taskStore = options.taskStore;
    this.providerCacheContext = options.providerCacheContext ?? {
      fastProviderId: "fast-provider",
      aiProviderId: "ai-provider",
      baseUrl: "",
      model: "",
      promptVersion: "default",
    };
    this.providerSettings =
      options.providerSettings ?? DEFAULT_SETTINGS.provider;
    this.onStatus = options.onStatus;
    this.onTrackSelected = options.onTrackSelected;
    this.onVideoChange = options.onVideoChange;
    this.onCueVisibilityChange = options.onCueVisibilityChange;
    this.overlay = new SubtitleOverlay(
      options.settings,
      options.onPositionChange,
    );
  }

  async start(): Promise<void> {
    if (!this.settings.enabled) {
      this.setStatus({
        state: "unavailable",
        total: 0,
        completed: 0,
        failed: 0,
      });
      return;
    }
    await this.activate();
  }

  private async activate(): Promise<void> {
    const resumesSuspendedTask = this.translationSuspended;
    this.clearTranslationSuspension();
    if (this.active) {
      if (resumesSuspendedTask && this.translationTrack) {
        if (this.failed.size > 0) {
          await this.retryFailed();
        } else {
          this.setStatus({
            state: this.translationTerminalState(),
            source: this.translationTrack.source,
            completeness: this.translationTrack.completeness,
            total: this.translationTrack.cues.length,
            completed: this.translated.size,
            failed: this.failed.size,
          });
          this.renderCurrentCue();
        }
      }
      return;
    }
    this.active = true;
    this.bindVideo();
    if (this.video) {
      this.beginSubtitleDiscoveryWait(true);
    } else {
      this.status = { state: "unavailable", total: 0, completed: 0, failed: 0 };
      this.onStatus?.({ ...this.status });
      this.overlay.hide();
    }
    for (const adapter of this.adapters) {
      this.subscribeAdapter(adapter);
    }
    document.addEventListener("play", this.handleVideoActivation, true);
    await this.scan();
    this.scanTimer = window.setInterval(() => void this.scan(), 2_000);
    this.bindVideo();
  }

  stop(): void {
    this.deactivate();
    this.overlay.destroy();
  }

  addAdapter(adapter: SubtitleAdapter): void {
    if (!adapter.matches(location)) return;
    const existingIndex = this.adapters.findIndex(
      (candidate) => candidate.id === adapter.id,
    );
    const replacing = existingIndex >= 0;
    if (replacing) {
      const existing = this.adapters[existingIndex];
      if (!existing || existing === adapter) return;
      this.unsubscribeAdapter(existing);
      this.adapters[existingIndex] = adapter;
    } else {
      this.adapters.push(adapter);
    }
    adapter.setSourceLanguage?.(this.settings.sourceLanguage);
    adapter.setPreferredVideo?.(this.video);
    if (this.active) {
      this.subscribeAdapter(adapter);
      if (replacing) this.resetMediaState();
      void this.scan();
    }
  }

  /** Rebuilds route-sensitive adapters and releases every stale subscription. */
  replaceAdapters(adapters: SubtitleAdapter[]): void {
    const nextAdapters = adapters.filter((adapter, index, candidates) => {
      return (
        adapter.matches(location) &&
        candidates.findIndex((candidate) => candidate.id === adapter.id) ===
          index
      );
    });
    for (const adapter of [...this.adapterUnsubscribers.keys()]) {
      this.unsubscribeAdapter(adapter);
    }
    this.adapters.splice(0, this.adapters.length, ...nextAdapters);
    if (this.active) this.resetMediaState();
    for (const adapter of this.adapters) {
      adapter.setSourceLanguage?.(this.settings.sourceLanguage);
      adapter.setPreferredVideo?.(this.video);
      if (this.active) this.subscribeAdapter(adapter);
    }
    if (this.active) {
      void this.scan();
    }
  }

  invalidateMedia(): void {
    if (!this.active) return;
    this.resetMediaState();
    void this.scan();
  }

  invalidateOcrMedia(): void {
    if (!this.active) return;
    if (
      this.currentTrack?.source === "ocr" ||
      this.translationTrack?.source === "ocr"
    ) {
      this.resetMediaState();
    }
    void this.scan();
  }

  refreshMedia(): void {
    if (!this.active) return;
    void this.scan();
  }

  setOcrCaptureRegion(region: NormalizedOcrRegion | null): void {
    this.overlay.setOcrCaptureRegion(region);
  }

  isOcrFeedbackText(text: string): boolean {
    return this.overlay.isOcrFeedbackText(text);
  }

  filterOcrFeedbackText(text: string): string {
    return this.overlay.filterOcrFeedbackText(text);
  }

  setOcrMediaTarget(target: HTMLElement | null): void {
    this.ocrMediaTarget = target;
    this.overlay.setMediaTarget(target ?? this.video);
  }

  showNotice(message: string): void {
    this.overlay.showNotice(message);
  }

  private deactivate(): void {
    this.active = false;
    this.beginSession();
    this.disposeOcrLocalProvider();
    if (this.scanTimer !== undefined) window.clearInterval(this.scanTimer);
    this.scanTimer = undefined;
    this.clearSubtitleDiscoveryTimeout();
    this.clearTrackResetTimer();
    for (const adapter of [...this.adapterUnsubscribers.keys()]) {
      this.unsubscribeAdapter(adapter);
    }
    this.video?.removeEventListener("timeupdate", this.renderCurrentCue);
    this.video?.removeEventListener("ended", this.hideAtMediaEnd);
    this.video?.removeEventListener("emptied", this.handleMediaSourceReset);
    this.video?.removeEventListener("loadstart", this.handleMediaSourceReset);
    document.removeEventListener("play", this.handleVideoActivation, true);
    this.video = null;
    this.lastActivatedVideo = null;
    this.setCueOverlayVisible(false);
    this.onVideoChange?.(null);
  }

  private readonly handleVideoActivation = (event: Event): void => {
    if (!(event.target instanceof HTMLVideoElement) || !this.active) return;
    this.lastActivatedVideo = event.target;
    this.bindVideo();
    void this.scan();
  };

  private readonly hideAtMediaEnd = (): void => {
    this.overlay.hide();
    this.setCueOverlayVisible(false);
  };

  private subscribeAdapter(adapter: SubtitleAdapter): void {
    if (this.adapterUnsubscribers.has(adapter)) return;
    const unsubscribers: Array<() => void> = [];
    if (adapter.subscribe) {
      unsubscribers.push(
        adapter.subscribe((track) => {
          this.synchronizeActiveMedia();
          const normalizedTrack = normalizeSubtitleTrack(track);
          if (
            normalizedTrack.cues.length > 0 &&
            trackMatchesConfiguredSource(
              normalizedTrack,
              this.settings.sourceLanguage,
            ) &&
            normalizedTrack.source === this.currentTrack?.source &&
            normalizedTrack.completeness === this.currentTrack.completeness
          ) {
            this.clearTrackResetTimer();
          }
          void this.considerTrack(track);
        }),
      );
    }
    if (adapter.subscribeInvalidation) {
      unsubscribers.push(
        adapter.subscribeInvalidation(() =>
          this.handleAdapterInvalidation(adapter),
        ),
      );
    }
    this.adapterUnsubscribers.set(adapter, unsubscribers);
  }

  private unsubscribeAdapter(adapter: SubtitleAdapter): void {
    const unsubscribers = this.adapterUnsubscribers.get(adapter);
    if (!unsubscribers) return;
    this.adapterUnsubscribers.delete(adapter);
    for (const unsubscribe of unsubscribers) unsubscribe();
  }

  updateSettings(
    settings: SubtitleSettings,
    providerCacheContext: SubtitleProviderCacheContext = this
      .providerCacheContext,
    providerSettings: ContentProviderSettings = this.providerSettings,
  ): void {
    const wasEnabled = this.settings.enabled;
    const sourceLanguageChanged =
      settings.sourceLanguage !== this.settings.sourceLanguage;
    const targetLanguageChanged =
      settings.targetLanguage !== this.settings.targetLanguage;
    const providerChanged =
      JSON.stringify(providerCacheContext) !==
      JSON.stringify(this.providerCacheContext);
    const translationChanged =
      settings.sourceLanguage !== this.settings.sourceLanguage ||
      settings.targetLanguage !== this.settings.targetLanguage ||
      settings.mode !== this.settings.mode ||
      settings.aiResponseMode !== this.settings.aiResponseMode ||
      providerChanged;
    this.settings = settings;
    for (const adapter of this.adapters)
      adapter.setSourceLanguage?.(settings.sourceLanguage);
    this.providerCacheContext = providerCacheContext;
    this.providerSettings = providerSettings;
    if (targetLanguageChanged) this.disposeOcrLocalProvider();
    this.overlay.updateSettings(settings);
    if (!settings.enabled) {
      this.deactivate();
      this.currentTrack = null;
      this.translationTrack = null;
      this.currentTrackIdentity = "";
      this.translated.clear();
      this.fallbackTranslated.clear();
      this.fallbackFailedCueIds.clear();
      this.failed.clear();
      this.overlay.hide();
      this.setStatus({
        state: "unavailable",
        total: 0,
        completed: 0,
        failed: 0,
      });
      return;
    }
    if (!wasEnabled) {
      void this.activate();
      return;
    }
    if (!this.active) {
      void this.activate();
      return;
    }
    if (sourceLanguageChanged) {
      this.clearTranslationSuspension();
      this.resetMediaState();
      void this.scan();
      return;
    }
    if (translationChanged && this.currentTrack) {
      this.beginSession();
      this.translated.clear();
      this.fallbackTranslated.clear();
      this.fallbackFailedCueIds.clear();
      this.failed.clear();
      const translationTrack = this.translationTrack ?? this.currentTrack;
      if (this.translationSuspended) {
        for (const cue of translationTrack.cues) this.failed.add(cue.id);
        this.setStatus({
          state: "cancelled",
          source: translationTrack.source,
          completeness: translationTrack.completeness,
          total: translationTrack.cues.length,
          completed: 0,
          failed: this.failed.size,
        });
        this.renderCurrentCue();
        return;
      }
      if (translationTrack.completeness === "stream") {
        void this.translateLatestStreamCue(translationTrack);
      } else {
        void this.translateFullTrack(translationTrack);
      }
    }
    this.renderCurrentCue();
  }

  refreshLocale(): void {
    this.overlay.refreshLocale();
  }

  getStatus(): SubtitleStatus {
    return { ...this.status };
  }

  async startTranslationTask(): Promise<SubtitleStatus> {
    if (!this.settings.enabled) return this.getStatus();
    if (!this.active) {
      await this.activate();
      return this.getStatus();
    }
    if (this.translationSuspended || this.failed.size > 0) {
      return this.retryFailed();
    }
    const track = this.translationTrack;
    if (
      track &&
      this.status.state !== "ready" &&
      this.status.state !== "translating"
    ) {
      if (track.completeness === "stream") {
        await this.translateLatestStreamCue(track);
      } else {
        await this.translateFullTrack(track);
      }
      return this.getStatus();
    }
    if (!track) {
      if (this.video) {
        this.beginSubtitleDiscoveryWait(true);
      }
      await this.scan();
    }
    return this.getStatus();
  }

  cancelTranslationTask(): SubtitleStatus {
    const track = this.currentTrack;
    const translationTrack = this.translationTrack;
    if (track && translationTrack) {
      this.translationSuspended = true;
      this.suspendedMediaIdentity = suspensionMediaIdentity(this.video);
      this.suspendedTrackIdentity = suspensionTrackIdentity(track);
    }
    this.beginSession();
    this.overlay.clearCue();
    this.setCueOverlayVisible(false);
    this.overlay.hide();
    if (!track || !translationTrack) return this.getStatus();
    for (const cue of translationTrack.cues) {
      if (!this.translated.has(cue.id)) this.failed.add(cue.id);
    }
    this.setStatus({
      state: "cancelled",
      source: track.source,
      completeness: track.completeness,
      total: translationTrack.cues.length,
      completed: this.translated.size,
      failed: this.failed.size,
    });
    return this.getStatus();
  }

  async retryFailed(): Promise<SubtitleStatus> {
    const track = this.translationTrack;
    if (!track) return this.getStatus();
    if (this.translationSuspended && this.failed.size === 0) {
      this.clearTranslationSuspension();
      this.setStatus({
        state: this.translationTerminalState(),
        source: track.source,
        completeness: track.completeness,
        total: track.cues.length,
        completed: this.translated.size,
        failed: 0,
      });
      this.renderCurrentCue();
      return this.getStatus();
    }
    if (this.failed.size === 0) return this.getStatus();
    const failedCues = track.cues.filter((cue) => this.failed.has(cue.id));
    if (failedCues.length === 0) {
      this.failed.clear();
      return this.getStatus();
    }

    this.clearTranslationSuspension();
    const run = this.beginSession();
    const mode = translationModeForTrack(track, this.settings);
    const reusePlan =
      track.completeness === "full"
        ? createFullTrackReusePlan(track, track.cues, mode)
        : undefined;
    const failedRepresentativeIds = new Set(
      failedCues.map(
        (cue) => reusePlan?.representativeIdByCueId.get(cue.id) ?? cue.id,
      ),
    );
    const cues = reusePlan
      ? reusePlan.representativeCues.filter((cue) =>
          failedRepresentativeIds.has(cue.id),
        )
      : failedCues;
    const mediaTitle = mediaTitleForTranslation(track, mode);
    const mediaScope = translationCacheScope(this.cacheScope(), mediaTitle);
    this.setStatus({
      state: "translating",
      source: track.source,
      completeness: track.completeness,
      total: track.cues.length,
      completed: this.translated.size,
      failed: this.failed.size,
    });
    const batches = createRetryBatches(track, cues, mode, this.settings);
    for (const [index, batch] of batches.entries()) {
      if (run !== this.session) return this.getStatus();
      await this.translateBatch(
        track,
        batch,
        mode,
        run,
        mediaScope,
        "primary",
        reusePlan,
        mediaTitle,
      );
      if (run !== this.session) return this.getStatus();
      this.setStatus({
        state:
          index + 1 < batches.length
            ? "translating"
            : this.translationTerminalState(),
        source: track.source,
        completeness: track.completeness,
        total: track.cues.length,
        completed: this.translated.size,
        failed: this.failed.size,
      });
      this.renderCurrentCue();
    }
    return this.getStatus();
  }

  private async scan(confirmTrackInvalidation = false): Promise<void> {
    // Some players expose a useful title only briefly during SPA navigation.
    // Sample it on the existing scan cadence and reuse it only for this exact
    // page identity; never carry a previous movie title into another page.
    pageMediaTitle();
    this.synchronizeActiveMedia();
    await this.restorePersistedFullTrack();
    const run = this.session;
    const candidates = await Promise.all(
      this.adapters.map(async (adapter) => ({
        adapter,
        track: await adapter.collect(),
      })),
    );
    if (run !== this.session || !this.active) return;
    candidates.sort((left, right) => {
      const completenessRank = (track: SubtitleTrack | null): number =>
        track?.completeness === "full"
          ? 0
          : track?.completeness === "stream"
            ? 1
            : 2;
      return (
        completenessRank(left.track) - completenessRank(right.track) ||
        left.adapter.priority - right.adapter.priority
      );
    });
    const usableCandidates = candidates.filter(
      (
        candidate,
      ): candidate is { adapter: SubtitleAdapter; track: SubtitleTrack } =>
        candidate.track !== null &&
        candidate.track.cues.length > 0 &&
        trackMatchesConfiguredSource(
          candidate.track,
          this.settings.sourceLanguage,
        ),
    );
    if (confirmTrackInvalidation && this.currentTrack) {
      const currentTrackStillAvailable = usableCandidates.some(
        ({ track }) =>
          track.source === this.currentTrack?.source &&
          track.completeness === this.currentTrack.completeness,
      );
      if (!currentTrackStillAvailable) {
        this.resetMediaState();
        // A live adapter explicitly invalidated this media's track. Do not
        // resurrect the same stale full track from persisted storage while
        // waiting for another live source to take over.
        this.lastRestoredTrackKey = this.persistedTrackKey();
      }
    }
    const best = usableCandidates[0]?.track;
    if (best) {
      this.clearSubtitleDiscoveryTimeout();
      this.clearTrackResetTimer();
      await this.considerTrack(best);
    } else if (
      !this.currentTrack &&
      !this.video &&
      this.status.state !== "unavailable"
    ) {
      this.clearSubtitleDiscoveryTimeout();
      this.status = { state: "unavailable", total: 0, completed: 0, failed: 0 };
      this.onStatus?.({ ...this.status });
      this.overlay.hide();
    }
  }

  private async considerTrack(track: SubtitleTrack): Promise<void> {
    const normalizedTrack = normalizeSubtitleTrack(track);
    if (normalizedTrack.cues.length === 0) return;
    if (
      !trackMatchesConfiguredSource(
        normalizedTrack,
        this.settings.sourceLanguage,
      )
    )
      return;
    if (this.currentTrack) {
      const currentPriority = SOURCE_PRIORITY[this.currentTrack.source];
      const candidatePriority = SOURCE_PRIORITY[normalizedTrack.source];
      const bothDifferentStreams =
        this.currentTrack.completeness === "stream" &&
        normalizedTrack.completeness === "stream" &&
        this.currentTrack.source !== normalizedTrack.source;
      let allowPriorityChange = true;
      if (bothDifferentStreams) {
        const playbackMs = Math.max(0, (this.video?.currentTime ?? 0) * 1_000);
        const currentFrontier = streamFrontierMs(this.currentTrack);
        const candidateFrontier = streamFrontierMs(normalizedTrack);
        if (currentPriority < candidatePriority) {
          allowPriorityChange =
            currentFrontier < playbackMs - STREAM_STALE_BEHIND_PLAYBACK_MS &&
            candidateFrontier >= playbackMs - STREAM_FRESH_TOLERANCE_MS &&
            candidateFrontier >=
              currentFrontier + STREAM_HANDOVER_HYSTERESIS_MS;
        } else if (
          currentPriority > candidatePriority &&
          this.streamHandoverSource === this.currentTrack.source
        ) {
          allowPriorityChange =
            candidateFrontier >= playbackMs - STREAM_FRESH_TOLERANCE_MS &&
            candidateFrontier >=
              this.streamHandoverFloorMs + STREAM_HANDOVER_HYSTERESIS_MS;
        }
      }
      if (
        this.currentTrack.completeness === "full" &&
        normalizedTrack.completeness === "stream" &&
        !(
          this.currentTrack.source === normalizedTrack.source &&
          hasDecisiveStreamEvidence(normalizedTrack)
        )
      )
        return;
      if (
        currentPriority < candidatePriority &&
        this.currentTrack.completeness === normalizedTrack.completeness &&
        !allowPriorityChange
      )
        return;
      if (
        bothDifferentStreams &&
        currentPriority > candidatePriority &&
        !allowPriorityChange
      )
        return;
    }
    const identity = trackIdentity(normalizedTrack, this.mediaScope());
    if (
      normalizedTrack.completeness === "full" &&
      identity === this.currentTrackIdentity
    )
      return;

    if (
      this.translationSuspended &&
      (this.suspendedMediaIdentity !== suspensionMediaIdentity(this.video) ||
        this.suspendedTrackIdentity !==
          suspensionTrackIdentity(normalizedTrack))
    ) {
      this.clearTranslationSuspension();
    }

    const previousTranslationTrack = this.translationTrack;
    const previousTrack = this.currentTrack;
    this.currentTrack = normalizedTrack;
    // Netflix TTML cues are already tied to the player's media timeline.
    // Combining adjacent cues into a longer sentence makes the full sentence
    // appear before later fragments are spoken. Keep its original cue timing;
    // contextualizeSegments still supplies neighboring dialogue to the AI.
    this.translationTrack =
      normalizedTrack.source === "netflix-manifest"
        ? normalizedTrack
        : groupFullSubtitleTrack(normalizedTrack);
    this.currentTrackIdentity = identity;
    this.onTrackSelected?.(normalizedTrack);
    if (
      normalizedTrack.completeness === "stream" &&
      previousTrack?.completeness === "stream"
    ) {
      const frontier = streamFrontierMs(normalizedTrack);
      if (previousTrack.source !== normalizedTrack.source) {
        if (
          SOURCE_PRIORITY[previousTrack.source] <
          SOURCE_PRIORITY[normalizedTrack.source]
        ) {
          this.streamHandoverSource = normalizedTrack.source;
          this.streamHandoverFloorMs = frontier;
        } else {
          this.streamHandoverSource = null;
          this.streamHandoverFloorMs = Number.NEGATIVE_INFINITY;
        }
        this.beginSession();
        this.translated.clear();
        this.fallbackTranslated.clear();
        this.fallbackFailedCueIds.clear();
        this.failed.clear();
      } else if (this.streamHandoverSource === normalizedTrack.source) {
        this.streamHandoverFloorMs = Math.max(
          this.streamHandoverFloorMs,
          frontier,
        );
      }
    } else if (normalizedTrack.completeness === "full") {
      this.streamHandoverSource = null;
      this.streamHandoverFloorMs = Number.NEGATIVE_INFINITY;
    }
    if (normalizedTrack.completeness === "full" && this.taskStore) {
      const key = this.persistedTrackKey();
      this.persistedTrackMutation = this.persistedTrackMutation
        .then(() => this.taskStore?.setTrack(key, normalizedTrack))
        .then(
          () => undefined,
          () => undefined,
        );
    } else if (
      previousTrack?.completeness === "full" &&
      normalizedTrack.completeness === "stream" &&
      hasDecisiveStreamEvidence(normalizedTrack) &&
      this.taskStore
    ) {
      const key = this.persistedTrackKey();
      this.lastRestoredTrackKey = key;
      this.persistedTrackMutation = this.persistedTrackMutation
        .then(() => this.taskStore?.deleteTrack(key))
        .then(
          () => undefined,
          () => undefined,
        );
    }
    if (
      previousTranslationTrack?.completeness === "full" &&
      this.translationTrack.completeness === "stream" &&
      hasDecisiveStreamEvidence(normalizedTrack)
    ) {
      this.beginSession();
      this.translated.clear();
      this.fallbackTranslated.clear();
      this.fallbackFailedCueIds.clear();
      this.failed.clear();
    }
    if (
      previousTranslationTrack?.completeness === "stream" &&
      this.translationTrack.completeness === "stream"
    ) {
      const currentCues = new Map(
        this.translationTrack.cues.map((cue) => [cue.id, cue]),
      );
      const staleCueIds = new Set<string>();
      const changedCueIds = new Set<string>();
      for (const cue of previousTranslationTrack.cues) {
        const currentCue = currentCues.get(cue.id);
        if (!currentCue) {
          staleCueIds.add(cue.id);
          continue;
        }
        if (
          normalizeTranslationText(currentCue.originalText) !==
          normalizeTranslationText(cue.originalText)
        ) {
          staleCueIds.add(cue.id);
          changedCueIds.add(cue.id);
        }
      }
      if (staleCueIds.size > 0) {
        // A bounded live adapter routinely evicts old cues. That must not
        // cancel translations for newer cues still present in the same track.
        // Reusing an ID for changed text is different and invalidates the run.
        if (changedCueIds.size > 0) this.beginSession();
        for (const id of this.translated.keys()) {
          if (staleCueIds.has(id)) this.translated.delete(id);
        }
        for (const id of this.fallbackTranslated.keys()) {
          if (staleCueIds.has(id)) this.fallbackTranslated.delete(id);
        }
        for (const id of this.fallbackFailedCueIds) {
          if (staleCueIds.has(id)) this.fallbackFailedCueIds.delete(id);
        }
        for (const id of this.failed) {
          if (staleCueIds.has(id)) this.failed.delete(id);
        }
        for (const id of this.pendingStreamCueIds) {
          if (staleCueIds.has(id)) this.pendingStreamCueIds.delete(id);
        }
        for (const id of this.inFlightCueIds) {
          if (staleCueIds.has(id)) this.inFlightCueIds.delete(id);
        }
        this.setStatus({
          state: this.translationProgressState(
            this.translationTrack.cues.length,
          ),
          source: this.translationTrack.source,
          completeness: "stream",
          total: this.translationTrack.cues.length,
          completed: this.translated.size,
          failed: this.failed.size,
        });
      }
    }
    this.renderCurrentCue();
    if (this.translationSuspended) {
      for (const cue of this.translationTrack.cues) {
        if (!this.translated.has(cue.id)) this.failed.add(cue.id);
      }
      this.setStatus({
        state: "cancelled",
        source: this.translationTrack.source,
        completeness: this.translationTrack.completeness,
        total: this.translationTrack.cues.length,
        completed: this.translated.size,
        failed: this.failed.size,
      });
      return;
    }
    if (this.translationTrack.completeness === "stream") {
      await this.translateLatestStreamCue(this.translationTrack);
    } else {
      await this.translateFullTrack(this.translationTrack);
    }
  }

  private async translateLatestStreamCue(track: SubtitleTrack): Promise<void> {
    const awaitingOcrLanguage =
      track.source === "ocr" &&
      this.settings.sourceLanguage === "auto" &&
      !this.ocrDetectedSourceLanguage;
    const languageDetectionCue = awaitingOcrLanguage
      ? [...track.cues]
          .reverse()
          .find((cue) => isReliableOcrLanguageSample(cue.originalText))
      : undefined;
    for (const cue of track.cues) {
      if (awaitingOcrLanguage && cue.id !== languageDetectionCue?.id) continue;
      if (
        !this.translated.has(cue.id) &&
        !this.failed.has(cue.id) &&
        !this.inFlightCueIds.has(cue.id)
      ) {
        this.pendingStreamCueIds.add(cue.id);
      }
    }
    if (this.translationSuspended) return;
    if (this.pendingStreamCueIds.size === 0 && this.inFlightCueIds.size === 0) {
      this.setStatus({
        state: this.translationProgressState(track.cues.length),
        source: track.source,
        completeness: "stream",
        total: track.cues.length,
        completed: this.translated.size,
        failed: this.failed.size,
      });
      this.renderCurrentCue();
      return;
    }
    const availableSlots = STREAM_CONCURRENCY - this.inFlightCueIds.size;
    if (availableSlots <= 0) return;
    const cues = orderedStreamCues(track, this.video)
      .filter((candidate) => this.pendingStreamCueIds.has(candidate.id))
      .slice(0, availableSlots);
    if (cues.length === 0) return;
    for (const cue of cues) {
      this.pendingStreamCueIds.delete(cue.id);
      this.inFlightCueIds.add(cue.id);
    }
    await Promise.all(cues.map((cue) => this.translateStreamCue(track, cue)));
    const latestTrack = this.translationTrack;
    if (
      this.active &&
      latestTrack?.completeness === "stream" &&
      this.pendingStreamCueIds.size > 0
    ) {
      void this.translateLatestStreamCue(latestTrack);
    }
  }

  private async restoreCachedCues(
    track: SubtitleTrack,
    cues: readonly SubtitleCue[],
    mode: TranslationMode,
    run: number,
    mediaScope: string,
  ): Promise<SubtitleCue[]> {
    if (!this.cache || cues.length === 0) return [...cues];
    if (
      track.source === "ocr" &&
      this.settings.sourceLanguage === "auto" &&
      !this.ocrDetectedSourceLanguage
    ) {
      return [...cues];
    }
    const segments = new Map(
      translationSegments(track, cues, mode).map((segment) => [
        segment.id,
        segment,
      ]),
    );
    let nextCue = 0;
    const worker = async (): Promise<void> => {
      while (run === this.session) {
        const cue = cues[nextCue++];
        if (!cue) return;
        const segment = segments.get(cue.id);
        if (!segment) continue;
        if (
          track.source === "ocr" &&
          this.settings.sourceLanguage === "auto" &&
          !this.ocrResolvedSourceLanguageByCueId.has(cue.id) &&
          requiresAutomaticHanDetection(cue.originalText)
        ) {
          // The same Han-only source can be Chinese or Japanese. There is no
          // safe pre-detection cache key, so translate once and write only the
          // concrete language reported by the local detector.
          continue;
        }
        try {
          const cache = this.cache;
          const cached = cache
            ? await readCachedTranslation(
                cache,
                cacheKey(
                  mediaScope,
                  track,
                  segment,
                  this.settings,
                  mode,
                  this.providerCacheContext,
                  localProviderIdOverride(
                    track,
                    mode,
                    "primary",
                    this.providerSettings,
                  ),
                  this.runtimeTranslationSourceLanguage(track, [cue]),
                ),
                mode === "ai"
                  ? PROVIDER_CACHE_READ_TIMEOUT_MS
                  : SUBTITLE_CACHE_READ_TIMEOUT_MS,
              )
            : undefined;
          if (run !== this.session) return;
          if (cached) {
            this.translated.set(cue.id, cached);
            this.failed.delete(cue.id);
          }
        } catch {
          // Cache lookup is best-effort; the cue remains eligible for Provider translation.
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(FULL_TRACK_CACHE_CONCURRENCY, cues.length) },
        () => worker(),
      ),
    );
    return run === this.session
      ? cues.filter((cue) => !this.translated.has(cue.id))
      : [];
  }

  private async translateStreamCue(
    track: SubtitleTrack,
    cue: SubtitleCue,
  ): Promise<void> {
    const run = this.session;
    const mode = translationModeForTrack(track, this.settings);
    const mediaScope = this.cacheScope();
    try {
      const uncached = await this.restoreCachedCues(
        track,
        [cue],
        mode,
        run,
        mediaScope,
      );
      if (run !== this.session) return;
      this.setStatus({
        state: "translating",
        source: track.source,
        completeness: "stream",
        total: track.cues.length,
        completed: this.translated.size,
        failed: this.failed.size,
      });
      this.renderCurrentCue();
      if (uncached.length > 0)
        await this.translateBatch(track, uncached, mode, run, mediaScope);
      if (run !== this.session) return;
      const latestTrack = this.translationTrack ?? track;
      this.setStatus({
        state: this.translationProgressState(latestTrack.cues.length),
        source: latestTrack.source,
        completeness: "stream",
        total: latestTrack.cues.length,
        completed: this.translated.size,
        failed: this.failed.size,
      });
      this.renderCurrentCue();
    } finally {
      this.inFlightCueIds.delete(cue.id);
    }
  }

  private async translateFullTrack(track: SubtitleTrack): Promise<void> {
    const run = this.beginSession();
    const mode = translationModeForTrack(track, this.settings);
    const mediaTitle = mediaTitleForTranslation(track, mode);
    const mediaScope = translationCacheScope(this.cacheScope(), mediaTitle);
    this.translated.clear();
    this.fallbackTranslated.clear();
    this.fallbackFailedCueIds.clear();
    this.failed.clear();
    const cues = orderedCues(track, this.video);
    const reusePlan = createFullTrackReusePlan(track, cues, mode);
    const segmentsById = reusePlan.segmentsById;
    const providerCues = reusePlan.representativeCues;
    let activeCacheReads = 0;
    const cacheReadWaiters: Array<() => void> = [];
    const acquireCacheRead = async (): Promise<void> => {
      // Keep one cache slot available for the current-cue local fallback so a
      // large full-track scan cannot delay visible machine translation.
      if (activeCacheReads < Math.max(1, FULL_TRACK_CACHE_CONCURRENCY - 1)) {
        activeCacheReads += 1;
        return;
      }
      await new Promise<void>((resolve) => {
        cacheReadWaiters.push(() => {
          activeCacheReads += 1;
          resolve();
        });
      });
    };
    const releaseCacheRead = (): void => {
      activeCacheReads = Math.max(0, activeCacheReads - 1);
      cacheReadWaiters.shift()?.();
    };
    const lookupCachedCues = async (
      candidates: SubtitleCue[],
      concurrency = FULL_TRACK_CACHE_CONCURRENCY,
    ): Promise<void> => {
      if (!this.cache || candidates.length === 0) return;
      let acceptingResults = true;
      let restoredFromCache = false;
      let nextCacheCue = 0;
      const cacheWorker = async (): Promise<void> => {
        while (run === this.session) {
          const cue = candidates[nextCacheCue++];
          if (!cue) return;
          await acquireCacheRead();
          if (run !== this.session || !acceptingResults) {
            releaseCacheRead();
            return;
          }
          try {
            const segment = segmentsById.get(cue.id);
            if (!segment) continue;
            const cache = this.cache;
            const cached = cache
              ? await readCachedTranslation(
                  cache,
                  cacheKey(
                    mediaScope,
                    track,
                    segment,
                    this.settings,
                    mode,
                    this.providerCacheContext,
                    localProviderIdOverride(
                      track,
                      mode,
                      "primary",
                      this.providerSettings,
                    ),
                    translationSourceLanguage(track, [cue], this.settings),
                  ),
                  PROVIDER_CACHE_READ_TIMEOUT_MS,
                )
              : undefined;
            if (run !== this.session || !acceptingResults) return;
            if (cached && !this.translated.has(cue.id)) {
              const equivalentCues =
                reusePlan.equivalentCuesByRepresentativeId.get(cue.id) ?? [cue];
              for (const equivalent of equivalentCues) {
                this.translated.set(equivalent.id, cached);
                this.failed.delete(equivalent.id);
              }
              restoredFromCache = true;
            }
          } catch {
            // Cache failures must not prevent translation.
          } finally {
            releaseCacheRead();
          }
        }
      };
      const reads = Promise.all(
        Array.from(
          {
            length: Math.min(concurrency, candidates.length),
          },
          () => cacheWorker(),
        ),
      );
      let timeout: number | undefined;
      await Promise.race([
        reads,
        new Promise<void>((resolve) => {
          timeout = window.setTimeout(
            resolve,
            FULL_TRACK_CACHE_LOOKUP_BUDGET_MS,
          );
        }),
      ]);
      acceptingResults = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (restoredFromCache && run === this.session) {
        this.reportFullTrackProgress(track);
      }
    };
    this.setStatus({
      state: "translating",
      source: track.source,
      completeness: "full",
      total: track.cues.length,
      completed: this.translated.size,
      failed: this.failed.size,
    });
    this.renderCurrentCue();
    const fullTrackBatches = createSubtitleBatches(track, providerCues, mode);
    const urgentCues =
      fullTrackBatches.length === 1 && !this.cache
        ? providerCues
        : urgentFullTrackCues(track, providerCues, this.video);
    const urgentCueIds = new Set(urgentCues.map((cue) => cue.id));
    const backgroundCues = providerCues.filter(
      (cue) => !urgentCueIds.has(cue.id),
    );
    const claimedCueIds = new Set<string>();
    let activeTranslations = 0;
    const translationWaiters: Array<() => void> = [];
    const acquireTranslationSlot = async (): Promise<void> => {
      if (activeTranslations < FULL_TRACK_CONCURRENCY) {
        activeTranslations += 1;
        return;
      }
      await new Promise<void>((resolve) => {
        translationWaiters.push(() => {
          activeTranslations += 1;
          resolve();
        });
      });
    };
    const releaseTranslationSlot = (): void => {
      activeTranslations = Math.max(0, activeTranslations - 1);
      translationWaiters.shift()?.();
    };
    const translateMissingBatch = async (
      batch: SubtitleCue[],
    ): Promise<void> => {
      const missing = batch.filter(
        (cue) => !this.translated.has(cue.id) && !claimedCueIds.has(cue.id),
      );
      if (missing.length === 0 || run !== this.session) return;
      for (const cue of missing) claimedCueIds.add(cue.id);
      await acquireTranslationSlot();
      try {
        if (run !== this.session) return;
        await this.translateBatch(
          track,
          missing,
          mode,
          run,
          mediaScope,
          "primary",
          reusePlan,
          mediaTitle,
        );
        if (run === this.session) this.reportFullTrackProgress(track);
      } finally {
        releaseTranslationSlot();
      }
    };

    // Only the current playback window is cache-gated. Its missing cues enter
    // the Provider queue before any distant cache scan can occupy that queue.
    await lookupCachedCues(urgentCues);
    if (run !== this.session) return;
    const urgentRequests = createSubtitleBatches(
      track,
      urgentCues.filter((cue) => !this.translated.has(cue.id)),
      mode,
    ).map((batch) => translateMissingBatch(batch));

    const initialBackgroundBatchCount = createSubtitleBatches(
      track,
      backgroundCues,
      mode,
    ).length;
    const remainingBackgroundCueIds = new Set(
      backgroundCues.map((cue) => cue.id),
    );
    const takeNextBackgroundBatch = (): SubtitleCue[] | undefined => {
      const remaining = orderedCues(
        {
          ...track,
          cues: track.cues.filter((cue) =>
            remainingBackgroundCueIds.has(cue.id),
          ),
        },
        this.video,
      );
      const batch = createSubtitleBatches(track, remaining, mode)[0];
      if (!batch) return undefined;
      for (const cue of batch) remainingBackgroundCueIds.delete(cue.id);
      return batch;
    };
    const backgroundWorker = async (): Promise<void> => {
      while (run === this.session) {
        // Re-evaluate the playback position between batches. A seek promotes
        // the new current window without cancelling requests already in flight.
        const batch = takeNextBackgroundBatch();
        if (!batch) return;
        await lookupCachedCues(batch);
        if (run !== this.session) return;
        await translateMissingBatch(batch);
      }
    };
    const backgroundWorkers = Array.from(
      {
        length: Math.min(FULL_TRACK_CONCURRENCY, initialBackgroundBatchCount),
      },
      () => backgroundWorker(),
    );
    await Promise.all([...urgentRequests, ...backgroundWorkers]);
    if (run !== this.session) return;
    this.setStatus({
      state: this.translationTerminalState(),
      source: track.source,
      completeness: "full",
      total: track.cues.length,
      completed: this.translated.size,
      failed: this.failed.size,
    });
    this.renderCurrentCue();
  }

  private async translateBatch(
    track: SubtitleTrack,
    cues: SubtitleCue[],
    mode: TranslationMode,
    run: number,
    mediaScope: string,
    destination: "primary" | "fallback" = "primary",
    reusePlan?: FullTrackReusePlan,
    mediaTitle?: string,
  ): Promise<void> {
    if (cues.length === 0) return;
    const id = runtimeId("subtitle");
    this.pendingRequestIds.add(id);
    let unsubscribeProgress = (): void => undefined;
    const equivalentCues = (cue: SubtitleCue): readonly SubtitleCue[] =>
      reusePlan?.equivalentCuesByRepresentativeId.get(cue.id) ?? [cue];
    const markCueFailed = (cue: SubtitleCue, failures: Set<string>): void => {
      for (const equivalent of equivalentCues(cue)) {
        failures.add(equivalent.id);
      }
    };
    try {
      const request = {
        sourceLanguage: this.runtimeTranslationSourceLanguage(track, cues),
        targetLanguage: this.settings.targetLanguage,
        mode,
        responseMode: this.settings.aiResponseMode,
        segments: translationSegments(track, cues, mode),
        ...(mediaTitle ? { mediaTitle } : {}),
        prompt: this.providerSettings.systemPrompt,
        scope: mediaScope,
      };
      let providerResolvedSourceLanguage = request.sourceLanguage;
      let results: TranslationResult[] | undefined;
      const expectedCueIds = new Set(cues.map((cue) => cue.id));
      const processedCueIds = new Set<string>();
      const cacheWrites: Promise<void>[] = [];
      const applyResult = (result: TranslationResult): void => {
        if (
          run !== this.session ||
          !expectedCueIds.has(result.id) ||
          processedCueIds.has(result.id) ||
          !result.translatedText.trim()
        ) {
          return;
        }
        const cue = cues.find((candidate) => candidate.id === result.id);
        if (!cue) return;
        const applicableCues = equivalentCues(cue).filter((equivalent) => {
          const currentCue = this.translationTrack?.cues.find(
            (candidate) => candidate.id === equivalent.id,
          );
          return (
            currentCue !== undefined &&
            normalizeTranslationText(currentCue.originalText) ===
              normalizeTranslationText(equivalent.originalText)
          );
        });
        if (applicableCues.length === 0) return;
        providerResolvedSourceLanguage =
          this.ocrResolvedSourceLanguageByCueId.get(cue.id) ??
          providerResolvedSourceLanguage;
        processedCueIds.add(cue.id);
        for (const applicableCue of applicableCues) {
          if (destination === "fallback") {
            this.fallbackTranslated.set(
              applicableCue.id,
              result.translatedText,
            );
            this.fallbackFailedCueIds.delete(applicableCue.id);
          } else {
            this.translated.set(applicableCue.id, result.translatedText);
            this.failed.delete(applicableCue.id);
          }
          if (this.cache) {
            const segment =
              reusePlan?.segmentsById.get(applicableCue.id) ??
              request.segments.find(
                (candidate) => candidate.id === applicableCue.id,
              );
            if (!segment) continue;
            const sourceLanguages = new Set(
              request.sourceLanguage === "auto" &&
                track.source === "ocr" &&
                requiresAutomaticHanDetection(applicableCue.originalText)
                ? [providerResolvedSourceLanguage]
                : [request.sourceLanguage, providerResolvedSourceLanguage],
            );
            for (const sourceLanguage of sourceLanguages) {
              cacheWrites.push(
                this.cache
                  .set(
                    cacheKey(
                      mediaScope,
                      track,
                      segment,
                      this.settings,
                      mode,
                      this.providerCacheContext,
                      localProviderIdOverride(
                        track,
                        mode,
                        destination,
                        this.providerSettings,
                      ),
                      sourceLanguage,
                    ),
                    result.translatedText,
                  )
                  .catch(() => undefined),
              );
            }
          }
        }
        if (destination === "primary" && track.source === "ocr") {
          const unavailableMessage = message("ocrLocalTranslationUnavailable");
          this.overlay.clearNotice(unavailableMessage);
          this.translationFailureMessage = undefined;
          this.translationFailureDetails = undefined;
        }
        if (destination === "primary") {
          this.setStatus({
            state: this.translationProgressState(track.cues.length),
            source: track.source,
            completeness: track.completeness,
            total: track.cues.length,
            completed: this.translated.size,
            failed: this.failed.size,
          });
        }
        this.renderCurrentCue();
      };

      if (
        mode === "fast" &&
        (destination === "fallback" ||
          track.source === "ocr" ||
          this.providerSettings.fastProvider === "chrome-local")
      ) {
        const controller = new AbortController();
        this.localControllers.add(controller);
        let timeout: number | undefined;
        try {
          if (destination === "primary" && track.source === "ocr") {
            this.setStatus({
              state: "translating",
              source: track.source,
              completeness: track.completeness,
              total: track.cues.length,
              completed: this.translated.size,
              failed: this.failed.size,
              message: message("ocrPreparingTranslationModel", "0"),
            });
          }
          const localProvider =
            destination === "primary" && track.source === "ocr"
              ? this.getOcrLocalProvider()
              : new ChromeLocalProvider({
                  // Opportunistic fallback must never trigger a model download.
                  requireAvailable: destination === "fallback",
                });
          const localTranslation = scheduleTranslation(
            localProvider,
            request,
            controller.signal,
            (result) => {
              if (!controller.signal.aborted) applyResult(result);
            },
          );
          results = await Promise.race([
            localTranslation,
            new Promise<never>((_resolve, reject) => {
              timeout = window.setTimeout(() => {
                controller.abort();
                reject(
                  new DOMException(
                    "Chrome local translation timed out.",
                    "TimeoutError",
                  ),
                );
              }, this.providerSettings.timeoutMs);
            }),
          ]);
        } finally {
          if (timeout !== undefined) window.clearTimeout(timeout);
          this.localControllers.delete(controller);
          for (const cue of cues) {
            this.ocrResolvedSourceLanguageByCueId.delete(cue.id);
          }
        }
      } else {
        unsubscribeProgress = subscribeTranslationProgress(id, applyResult);
        const response: unknown = await browser.runtime.sendMessage({
          type: "TRANSLATE",
          requestId: id,
          request,
        });
        if (run !== this.session) return;
        if (
          !isTranslationResponse(response) ||
          !response.ok ||
          !response.results
        ) {
          if (isTranslationResponse(response) && response.error) {
            this.translationFailureMessage = localizeRuntimeError(
              response.error.message,
              message,
            );
            this.translationFailureDetails =
              response.error.details ??
              `Provider error code: ${response.error.code}. This subtitle batch received ${processedCueIds.size} of ${cues.length} requested result IDs; ${cues.length - processedCueIds.size} result IDs were missing when the request failed.`;
          } else {
            this.translationFailureMessage = message(
              "runtimeErrorInvalidResponse",
            );
            this.translationFailureDetails = `The translation response envelope was invalid or incomplete. Response type: ${Array.isArray(response) ? "array" : typeof response}.`;
          }
          if (destination === "primary") {
            for (const cue of cues) {
              if (!processedCueIds.has(cue.id)) markCueFailed(cue, this.failed);
            }
          }
          return;
        }
        results = response.results;
      }
      if (run !== this.session) return;
      const validated = validateResults(cues, results);
      if (!validated) {
        this.translationFailureMessage ||= message(
          "runtimeErrorInvalidResponse",
        );
        this.translationFailureDetails ||= [
          `Expected IDs: ${cues.map((cue) => cue.id).join(", ")}`,
          `Received IDs: ${results.map((result) => result.id).join(", ")}`,
        ].join("\n");
        if (destination === "primary") {
          for (const cue of cues) {
            if (!processedCueIds.has(cue.id)) markCueFailed(cue, this.failed);
          }
        }
        return;
      }
      for (const cue of cues) {
        if (processedCueIds.has(cue.id)) continue;
        const translatedText = validated.get(cue.id);
        if (!translatedText) continue;
        applyResult({ id: cue.id, translatedText });
      }
      await Promise.all(cacheWrites);
    } catch (error) {
      if (run === this.session) {
        const failures =
          destination === "fallback" ? this.fallbackFailedCueIds : this.failed;
        for (const cue of cues) {
          if (
            destination === "fallback"
              ? !this.fallbackTranslated.has(cue.id)
              : !this.translated.has(cue.id)
          ) {
            markCueFailed(cue, failures);
          }
        }
        if (destination === "primary" && track.source === "ocr") {
          const unavailableMessage = message("ocrLocalTranslationUnavailable");
          if (!this.overlay.hasVisibleTranslation()) {
            this.translationFailureMessage = unavailableMessage;
            this.overlay.showNotice(unavailableMessage);
          }
        } else if (destination === "primary") {
          this.translationFailureMessage ||= message(
            "runtimeErrorRequestFailed",
          );
          this.translationFailureDetails ||= `The Provider request failed before a valid response was received. Failure type: ${error instanceof Error ? error.name : typeof error}.`;
        }
      }
    } finally {
      unsubscribeProgress();
      this.pendingRequestIds.delete(id);
    }
  }

  private bindVideo(): void {
    const next = selectActiveVideo("video", this.lastActivatedVideo);
    if (next === this.video) return;
    const previous = this.video;
    this.video?.removeEventListener("timeupdate", this.renderCurrentCue);
    this.video?.removeEventListener("ended", this.hideAtMediaEnd);
    this.video?.removeEventListener("emptied", this.handleMediaSourceReset);
    this.video?.removeEventListener("loadstart", this.handleMediaSourceReset);
    this.video = next;
    this.onVideoChange?.(next);
    this.mediaGeneration = 0;
    for (const adapter of this.adapters) {
      adapter.setPreferredVideo?.(next);
    }
    this.overlay.setMediaTarget(this.ocrMediaTarget ?? next);
    this.video?.addEventListener("timeupdate", this.renderCurrentCue);
    this.video?.addEventListener("ended", this.hideAtMediaEnd);
    this.video?.addEventListener("emptied", this.handleMediaSourceReset);
    this.video?.addEventListener("loadstart", this.handleMediaSourceReset);
    if (previous || this.currentTrack) {
      this.resetMediaState();
      this.lastRestoredTrackKey = this.persistedTrackKey();
    } else if (next && this.active) {
      this.beginSubtitleDiscoveryWait(true);
    } else if (!next) {
      this.clearSubtitleDiscoveryTimeout();
    }
  }

  private synchronizeActiveMedia(): void {
    this.bindVideo();
    const nextMediaIdentity = mediaIdentity(this.video, this.mediaGeneration);
    if (
      this.currentMediaIdentity &&
      this.currentMediaIdentity !== nextMediaIdentity
    ) {
      this.resetMediaState();
      this.lastRestoredTrackKey = this.persistedTrackKey();
    }
    this.currentMediaIdentity = nextMediaIdentity;
  }

  private mediaScope(): string {
    return (
      this.currentMediaIdentity ||
      mediaIdentity(this.video, this.mediaGeneration)
    );
  }

  private cacheScope(): string {
    return persistentMediaIdentity(this.video);
  }

  private readonly handleMediaSourceReset = (): void => {
    if (!this.active || !this.video) return;
    this.mediaGeneration += 1;
    this.resetMediaState();
    this.lastRestoredTrackKey = this.persistedTrackKey();
    void this.scan();
  };

  private persistedTrackKey(): string {
    return [
      "subtitle-track-v2",
      this.cacheScope(),
      this.settings.sourceLanguage,
    ].join("\u001f");
  }

  private async restorePersistedFullTrack(): Promise<void> {
    if (!this.taskStore || this.currentTrack) return;
    const run = this.session;
    const key = this.persistedTrackKey();
    if (key === this.lastRestoredTrackKey) return;
    this.lastRestoredTrackKey = key;
    try {
      const stored = await this.taskStore.getTrack(key);
      if (
        !this.active ||
        run !== this.session ||
        key !== this.persistedTrackKey() ||
        !isPersistedFullTrack(stored) ||
        !trackMatchesConfiguredSource(stored, this.settings.sourceLanguage)
      ) {
        return;
      }
      await this.considerTrack(stored);
    } catch {
      // Persisted tracks are an optimization; live adapters remain authoritative.
    }
  }

  private resetMediaState(): void {
    this.clearTrackResetTimer();
    this.beginSession();
    this.currentTrack = null;
    this.translationTrack = null;
    this.currentTrackIdentity = "";
    this.currentMediaIdentity = "";
    this.lastRestoredTrackKey = "";
    this.streamHandoverSource = null;
    this.streamHandoverFloorMs = Number.NEGATIVE_INFINITY;
    if (
      this.translationSuspended &&
      this.suspendedMediaIdentity !== suspensionMediaIdentity(this.video)
    ) {
      this.clearTranslationSuspension();
    }
    this.translated.clear();
    this.fallbackTranslated.clear();
    this.fallbackFailedCueIds.clear();
    this.failed.clear();
    this.pendingStreamCueIds.clear();
    this.ocrDetectedSourceLanguage = "";
    this.overlay.clearCue();
    this.setCueOverlayVisible(false);
    this.overlay.clearNotice();
    if (this.video) {
      this.beginSubtitleDiscoveryWait(true);
    } else {
      this.setStatus({
        state: "unavailable",
        total: 0,
        completed: 0,
        failed: 0,
      });
      this.overlay.hide();
    }
  }

  private handleAdapterInvalidation(adapter: SubtitleAdapter): void {
    if (adapter.invalidationMode !== "immediate") {
      this.scheduleTrackReset();
      return;
    }
    this.clearTrackResetTimer();
    if (
      this.currentTrack?.source === "ocr" ||
      this.translationTrack?.source === "ocr"
    ) {
      // OCR begin() is a timeline boundary, not a transient capture gap.
      // Advance the controller session synchronously so a local Translator
      // result that ignores AbortSignal cannot commit during the normal grace.
      this.resetMediaState();
    }
    void this.scan();
  }

  private scheduleTrackReset(): void {
    if (!this.active || this.trackResetTimer !== undefined) return;
    this.trackResetTimer = window.setTimeout(() => {
      this.trackResetTimer = undefined;
      if (!this.active || !this.currentTrack) return;
      void this.scan(true);
    }, TRACK_INVALIDATION_GRACE_MS);
  }

  private beginSubtitleDiscoveryWait(restart = false): void {
    if (!this.active || !this.video || this.currentTrack) return;
    if (!restart && this.discoveryTimeout !== undefined) return;
    this.clearSubtitleDiscoveryTimeout();
    window.dispatchEvent(
      new CustomEvent(SUBTITLE_DISCOVERY_CONTROL_EVENT, {
        detail: {
          enabled: true,
          sourceLanguage: this.settings.sourceLanguage,
        },
      }),
    );
    this.setStatus({ state: "waiting", total: 0, completed: 0, failed: 0 });
    this.discoveryTimeout = window.setTimeout(() => {
      this.discoveryTimeout = undefined;
      if (!this.active || !this.video || this.currentTrack) return;
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_DISCOVERY_CONTROL_EVENT, {
          detail: {
            enabled: false,
            sourceLanguage: this.settings.sourceLanguage,
          },
        }),
      );
      this.setStatus({
        state: "unavailable",
        total: 0,
        completed: 0,
        failed: 0,
      });
    }, SUBTITLE_DISCOVERY_TIMEOUT_MS);
  }

  private clearSubtitleDiscoveryTimeout(): void {
    if (this.discoveryTimeout === undefined) return;
    window.clearTimeout(this.discoveryTimeout);
    this.discoveryTimeout = undefined;
  }

  private clearTrackResetTimer(): void {
    if (this.trackResetTimer === undefined) return;
    window.clearTimeout(this.trackResetTimer);
    this.trackResetTimer = undefined;
  }

  private clearTranslationSuspension(): void {
    this.translationSuspended = false;
    this.suspendedMediaIdentity = "";
    this.suspendedTrackIdentity = "";
  }

  private beginSession(): number {
    this.session += 1;
    this.translationFailureMessage = undefined;
    this.translationFailureDetails = undefined;
    for (const controller of this.localControllers) controller.abort();
    this.localControllers.clear();
    for (const id of this.pendingRequestIds) {
      void browser.runtime.sendMessage({
        type: "TRANSLATE_CANCEL",
        requestId: id,
      });
    }
    this.pendingRequestIds.clear();
    this.inFlightCueIds.clear();
    this.pendingStreamCueIds.clear();
    this.fallbackInFlightCueIds.clear();
    return this.session;
  }

  private getOcrLocalProvider(): ChromeLocalProvider {
    if (
      this.ocrLocalProvider &&
      this.ocrLocalProviderTargetLanguage === this.settings.targetLanguage
    ) {
      return this.ocrLocalProvider;
    }
    this.disposeOcrLocalProvider();
    this.ocrLocalProviderTargetLanguage = this.settings.targetLanguage;
    this.ocrLocalProvider = new ChromeLocalProvider({
      keepAliveForTask: true,
      dynamicSourceLanguage: true,
      onDownloadProgress: (progress: number) => {
        const track = this.translationTrack;
        if (!this.active || track?.source !== "ocr") return;
        const percent = Math.round(progress * 100);
        this.setStatus({
          state: "translating",
          source: track.source,
          completeness: track.completeness,
          total: track.cues.length,
          completed: this.translated.size,
          failed: this.failed.size,
          message: message("ocrPreparingTranslationModel", String(percent)),
        });
      },
      onSourceLanguageResolved: (sourceLanguage, request) => {
        for (const segment of request.segments) {
          this.ocrResolvedSourceLanguageByCueId.set(segment.id, sourceLanguage);
        }
        if (
          !this.ocrDetectedSourceLanguage &&
          this.settings.sourceLanguage === "auto" &&
          request.segments.some((segment) =>
            isReliableOcrLanguageSample(segment.text),
          )
        ) {
          this.ocrDetectedSourceLanguage = sourceLanguage;
          const track = this.translationTrack;
          if (track?.source === "ocr") {
            for (const cue of track.cues) {
              if (
                !this.translated.has(cue.id) &&
                !this.failed.has(cue.id) &&
                !this.inFlightCueIds.has(cue.id)
              ) {
                this.pendingStreamCueIds.add(cue.id);
              }
            }
          }
        }
      },
    });
    return this.ocrLocalProvider;
  }

  private runtimeTranslationSourceLanguage(
    track: SubtitleTrack,
    cues: readonly SubtitleCue[],
  ): string {
    if (track.source === "ocr" && this.settings.sourceLanguage === "auto") {
      const resolvedLanguages = new Set(
        cues
          .map((cue) => this.ocrResolvedSourceLanguageByCueId.get(cue.id))
          .filter((language): language is string => Boolean(language)),
      );
      if (resolvedLanguages.size === 1) {
        return [...resolvedLanguages][0] ?? "auto";
      }

      const inferred = translationSourceLanguage(track, cues, this.settings);
      if (
        inferred !== "auto" ||
        cues.some((cue) => isReliableOcrLanguageSample(cue.originalText))
      ) {
        // Reliable new cues must be detected independently: OCR regions can
        // legitimately switch languages within one playback session.
        return inferred;
      }
      if (this.ocrDetectedSourceLanguage) {
        // Reuse the session language only for fragments too short to detect.
        return this.ocrDetectedSourceLanguage;
      }
    }
    return translationSourceLanguage(track, cues, this.settings);
  }

  private disposeOcrLocalProvider(): void {
    const provider = this.ocrLocalProvider;
    this.ocrLocalProvider = undefined;
    this.ocrLocalProviderTargetLanguage = "";
    this.ocrResolvedSourceLanguageByCueId.clear();
    if (provider) void provider.dispose();
  }

  private reportFullTrackProgress(track: SubtitleTrack): void {
    this.setStatus({
      state: this.translationProgressState(track.cues.length),
      source: track.source,
      completeness: "full",
      total: track.cues.length,
      completed: this.translated.size,
      failed: this.failed.size,
    });
    this.renderCurrentCue();
  }

  private translationTerminalState(): "ready" | "partial" | "error" {
    if (this.failed.size > 0 && this.translated.size === 0) return "error";
    return this.failed.size > 0 ? "partial" : "ready";
  }

  private translationProgressState(
    total: number,
  ): "translating" | "ready" | "partial" | "error" {
    return this.translated.size + this.failed.size < total
      ? "translating"
      : this.translationTerminalState();
  }

  private scheduleFastFallback(track: SubtitleTrack, cue: SubtitleCue): void {
    if (
      translationModeForTrack(track, this.settings) !== "ai" ||
      track.source === "ocr" ||
      this.settings.displayMode === "original" ||
      !["translating", "partial", "error"].includes(this.status.state) ||
      this.translated.has(cue.id) ||
      this.fallbackTranslated.has(cue.id) ||
      this.fallbackFailedCueIds.has(cue.id) ||
      this.fallbackInFlightCueIds.has(cue.id)
    ) {
      return;
    }
    const run = this.session;
    const mediaScope = this.cacheScope();
    this.fallbackInFlightCueIds.add(cue.id);
    void (async () => {
      try {
        if (this.cache) {
          const [segment] = translationSegments(track, [cue], "fast");
          if (segment) {
            const cached = await readCachedTranslation(
              this.cache,
              cacheKey(
                mediaScope,
                track,
                segment,
                this.settings,
                "fast",
                this.providerCacheContext,
                "chrome-local",
              ),
            );
            if (run !== this.session) return;
            if (cached) {
              this.fallbackTranslated.set(cue.id, cached);
              this.renderCurrentCue();
              return;
            }
          }
        }
        await this.translateBatch(
          track,
          [cue],
          "fast",
          run,
          mediaScope,
          "fallback",
        );
      } catch {
        if (run === this.session) this.fallbackFailedCueIds.add(cue.id);
      } finally {
        this.fallbackInFlightCueIds.delete(cue.id);
      }
    })();
  }

  private readonly renderCurrentCue = (): void => {
    if (this.translationSuspended) {
      this.overlay.clearCue();
      this.overlay.hide();
      this.setCueOverlayVisible(false);
      return;
    }
    const track = this.currentTrack;
    const translationTrack = this.translationTrack;
    if (!track || !translationTrack || !this.settings.enabled) {
      this.setCueOverlayVisible(false);
      return;
    }
    const timelineVideo =
      track.source === "ocr" && this.ocrMediaTarget instanceof HTMLVideoElement
        ? this.ocrMediaTarget
        : this.video;
    const currentMs = Math.round((timelineVideo?.currentTime ?? 0) * 1_000);
    const cue =
      track.source === "ocr" &&
      !(this.ocrMediaTarget instanceof HTMLVideoElement)
        ? [...track.cues]
            .reverse()
            .find((candidate) => candidate.endMs === null)
        : cueAtPlaybackTime(track, currentMs);
    if (!cue) {
      this.overlay.clearCue();
      this.setCueOverlayVisible(false);
      return;
    }
    const directTranslationCue = translationTrack.cues.find(
      (candidate) => candidate.id === cue.id,
    );
    const translationCue =
      directTranslationCue ??
      (translationTrack.completeness === "full"
        ? groupForCue(translationTrack.cues as SubtitleSentenceGroup[], cue.id)
        : undefined);
    if (translationCue && !this.translated.has(translationCue.id)) {
      this.scheduleFastFallback(translationTrack, translationCue);
    }
    const translatedText = translationCue
      ? (this.translated.get(translationCue.id) ??
        this.fallbackTranslated.get(translationCue.id))
      : undefined;
    const showOcrOriginalFallback =
      track.source === "ocr" &&
      Boolean(translationCue && this.failed.has(translationCue.id));
    const hasTranslatedText = Boolean(translatedText?.trim());
    if (
      this.settings.displayMode === "bilingual" &&
      !hasTranslatedText &&
      !showOcrOriginalFallback
    ) {
      this.overlay.clearCue();
      this.setCueOverlayVisible(false);
      return;
    }
    this.overlay.showCue(cue.originalText, translatedText, {
      showOriginalFallback: showOcrOriginalFallback,
    });
    const visibility = subtitleCueVisibility(
      this.settings.displayMode,
      cue.originalText.trim().length > 0,
      hasTranslatedText,
      showOcrOriginalFallback,
    );
    this.setCueOverlayVisible(visibility.original || visibility.translated);
  };

  private setCueOverlayVisible(visible: boolean): void {
    if (visible === this.cueOverlayVisible) return;
    this.cueOverlayVisible = visible;
    this.onCueVisibilityChange?.(visible);
  }

  private setStatus(status: SubtitleStatus): void {
    const effectiveMode = this.translationTrack
      ? translationModeForTrack(this.translationTrack, this.settings)
      : this.settings.mode;
    const statusWithFallback: SubtitleStatus =
      !status.message &&
      status.completeness === "stream" &&
      this.settings.mode === "ai" &&
      effectiveMode === "fast" &&
      status.source !== "ocr"
        ? {
            ...status,
            message: message("subtitleFastFallbackNoFullTrack"),
          }
        : status;
    const visibleStatus: SubtitleStatus =
      statusWithFallback.failed > 0 && this.translationFailureMessage
        ? {
            ...statusWithFallback,
            message: this.translationFailureMessage,
            ...(this.translationFailureDetails
              ? { details: this.translationFailureDetails }
              : {}),
          }
        : statusWithFallback;
    this.status = visibleStatus;
    this.onStatus?.({ ...visibleStatus });
    const overlayState =
      status.state === "partial" && status.completeness === "full"
        ? "partial-failure"
        : status.state;
    this.overlay.setStatus(overlayState, status.completed, status.total);
  }
}
