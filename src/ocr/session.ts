import {
  createLocalOcrEngine,
  ocrRecognitionText,
  type LocalOcrEngine,
  type OcrRecognitionResult,
} from "@/src/ocr/engine";
import {
  OcrFrameDeduplicator,
  ocrFingerprintChanged,
  ocrFrameDifference,
} from "@/src/ocr/frame-analysis";
import { prepareOcrFrame, type PreparedOcrFrame } from "@/src/ocr/frame";
import {
  ocrMediaTargetIsCurrent,
  ocrMediaTargetIsPictureInPicture,
  ocrMediaTargetSource,
  selectOcrMediaTarget,
} from "@/src/ocr/media-target";
import {
  ocrRegionRelativeToBounds,
  projectOcrRegionToViewport,
} from "@/src/ocr/geometry";
import { isOcrSourceLanguageSupported } from "@/src/ocr/languages";
import { OcrRegionSelector } from "@/src/ocr/region-selector";
import { OcrSampler } from "@/src/ocr/sampler";
import type { OcrSubtitleAdapter } from "@/src/ocr/subtitle-adapter";
import {
  OCR_BACKGROUND_TARGET,
  OCR_SAMPLE_INTERVAL_MS,
  type OcrCaptureResponse,
  type OcrStatus,
} from "@/src/ocr/types";
import { browser } from "wxt/browser";
import { runtimeId } from "@/src/shared/runtime-id";
import { message } from "@/src/shared/i18n";

export interface OcrSessionOptions {
  enabled: boolean;
  sourceLanguage?: string;
  adapter: OcrSubtitleAdapter;
  onStatus?(status: OcrStatus): void;
  onMediaTarget?(target: HTMLElement | null): void;
  onTrackUpdated?(): void;
  onStopped?(): void;
  ignoreRecognizedText?(text: string): boolean;
  filterRecognizedText?(text: string): string;
  engine?: LocalOcrEngine;
  selector?: OcrRegionSelector;
  capture?: (signal: AbortSignal) => Promise<OcrCaptureResponse>;
}

const MAX_CONSECUTIVE_BLACK_FRAMES = 10;
const EMPTY_FRAMES_TO_END_CUE = 2;
const EMPTY_FRAME_CONFIRMATION_DIFFERENCE = 0.012;
const OCR_HIGH_CONFIDENCE = 60;
const OCR_MIN_CONFIDENCE = 25;
const OCR_CANDIDATE_MAX_AGE_MS = 2_500;
const OCR_CANDIDATE_SIMILARITY = 0.7;
const MAX_CONSECUTIVE_SAMPLE_ERRORS = 3;
const NON_VIDEO_STABLE_SAMPLES = 3;
const NON_VIDEO_PROBE_INTERVAL_MS = 2_000;

function isCaptureResponse(value: unknown): value is OcrCaptureResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function diagnosticMessage(key: string, error: unknown): string {
  const detail =
    error instanceof Error
      ? error.message.replace(/chrome-extension:\/\/[^/]+/gu, "extension:")
      : "";
  return detail ? `${message(key)} (${detail.slice(0, 240)})` : message(key);
}

function ocrStartErrorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    error.message.startsWith("ocr_runtime_missing:")
  ) {
    return message("ocrRuntimeMissing");
  }
  return diagnosticMessage("ocrStartFailed", error);
}

function releasePreparedFrame(frame: PreparedOcrFrame): void {
  frame.canvas.width = 1;
  frame.canvas.height = 1;
  if (frame.originalCanvas) {
    frame.originalCanvas.width = 1;
    frame.originalCanvas.height = 1;
  }
}

interface HiddenSubtitleOverlay {
  references: number;
  previousValue: string;
  previousPriority: string;
}

const hiddenSubtitleOverlays = new WeakMap<
  HTMLElement,
  HiddenSubtitleOverlay
>();

function hideSubtitleOverlay(host: HTMLElement): () => void {
  let hidden = hiddenSubtitleOverlays.get(host);
  if (hidden) {
    hidden.references += 1;
  } else {
    hidden = {
      references: 1,
      previousValue: host.style.getPropertyValue("visibility"),
      previousPriority: host.style.getPropertyPriority("visibility"),
    };
    hiddenSubtitleOverlays.set(host, hidden);
  }
  host.style.setProperty("visibility", "hidden", "important");

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = hiddenSubtitleOverlays.get(host);
    if (!current) return;
    current.references -= 1;
    if (current.references > 0) return;
    hiddenSubtitleOverlays.delete(host);
    if (current.previousValue) {
      host.style.setProperty(
        "visibility",
        current.previousValue,
        current.previousPriority,
      );
    } else {
      host.style.removeProperty("visibility");
    }
  };
}

/** Temporarily excludes non-subtitle extension controls from captureVisibleTab. */
function hideInjectedUiForCapture(): () => void {
  const restorations: Array<() => void> = [];
  const hosts = document.querySelectorAll<HTMLElement>("[data-noritrans-ui]");
  for (const host of hosts) {
    if (host instanceof HTMLStyleElement) continue;
    const surface = host.dataset.noritransUi;
    if (
      surface === "subtitle-overlay" ||
      surface === "subtitle-fullscreen-portal" ||
      surface === "unified-floating-control" ||
      surface === "floating-control-fullscreen-portal"
    ) {
      continue;
    }
    restorations.push(hideSubtitleOverlay(host));
  }
  // Force the visibility mutation into layout before captureVisibleTab runs in
  // the background. No animation-frame wait is used, so inactive tabs cannot
  // stall sampling and the visible exclusion window remains minimal.
  if (restorations.length > 0) void document.documentElement.offsetHeight;
  return () => {
    for (const restore of restorations.reverse()) restore();
  };
}

function recognitionConfidence(
  recognition: OcrRecognitionResult,
): number | undefined {
  return typeof recognition === "string" ? undefined : recognition.confidence;
}

function suspiciousCollapsedLatinSubtitle(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length < 8) return false;
  if (!/\s/u.test(normalized)) {
    return /^[\p{Lu}\d]+$/u.test(normalized);
  }
  return /(?:\p{L}{2,}\d{2,}|\d{2,}\p{L}{2,})/u.test(normalized);
}

function latinWordBoundaryCount(text: string): number {
  return (
    text.match(/(?<=[\p{Script=Latin}\d])\s+(?=[\p{Script=Latin}\d])/gu)
      ?.length ?? 0
  );
}

function shouldTryAlternateFrame(
  text: string,
  confidence: number | undefined,
): boolean {
  return (
    !text ||
    (confidence !== undefined && confidence < OCR_MIN_CONFIDENCE) ||
    suspiciousCollapsedLatinSubtitle(text)
  );
}

function alternateRecognitionIsBetter(
  primaryText: string,
  primaryConfidence: number | undefined,
  alternateText: string,
  alternateConfidence: number | undefined,
): boolean {
  if (!alternateText) return false;
  if (!primaryText) return true;
  if (
    suspiciousCollapsedLatinSubtitle(primaryText) &&
    !suspiciousCollapsedLatinSubtitle(alternateText) &&
    (alternateConfidence ?? 0) >= OCR_MIN_CONFIDENCE &&
    textSimilarity(primaryText, alternateText) >= 0.9 &&
    latinWordBoundaryCount(alternateText) > latinWordBoundaryCount(primaryText)
  ) {
    return true;
  }
  return (alternateConfidence ?? 0) >= (primaryConfidence ?? 0);
}

export function filterOcrSubtitleText(text: string): string {
  let lines = text
    .trim()
    .split(/\r?\n/gu)
    .map((line) =>
      line
        .replace(/[ \t]+/gu, " ")
        // PP-OCR can merge a long all-caps label with a following 3+ digit
        // subtitle token even when both frame variants agree. Keep this
        // deliberately narrow so common forms such as GPT4, MP3, H264 and
        // COVID19 remain untouched.
        .replace(/\b([A-Z]{3,})(\d{3,})\b/gu, "$1 $2")
        .replace(/\s+[=|\\/_-]{1,3}$/u, "")
        .replace(/^[©®™]+\s*/u, "")
        .replace(/([\p{Lu}\d])['’](?=\s|$)/gu, (match, preceding: string) =>
          preceding === "S" ? match : preceding,
        )
        .trim(),
    )
    .filter(Boolean);
  if (lines.length > 3) return "";
  if (
    lines.length >= 3 &&
    lines.some((line) => (line.match(/[\p{L}\p{N}]/gu) ?? []).length <= 1)
  ) {
    return "";
  }
  if (lines.length >= 2) {
    const lineScore = (line: string): number => {
      const tokens = line.match(/[\p{L}\p{N}]+/gu) ?? [];
      const tokenScore = tokens.reduce(
        (score, token) => score + token.length ** 1.5,
        0,
      );
      const isolated = tokens.filter((token) => token.length === 1).length;
      const punctuation = (line.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;
      return tokenScore - isolated * 2 - punctuation * 0.75;
    };
    const ranked = lines
      .map((line, index) => ({ index, line, score: lineScore(line) }))
      .sort((left, right) => right.score - left.score);
    const strongest = ranked[0];
    const next = ranked[1];
    if (
      strongest &&
      strongest.score > 0 &&
      (!next || next.score < strongest.score * 0.5)
    ) {
      lines = [strongest.line];
    }
  }
  lines = lines.map((line) => {
    const tokens = line.match(/[\p{L}\p{N}]+/gu) ?? [];
    const last = tokens.at(-1);
    const stableUppercaseTokens = tokens
      .slice(0, -1)
      .filter((token) => /^[\p{Lu}\d]{3,}$/u.test(token)).length;
    return last && /^\p{Lu}\p{Ll}$/u.test(last) && stableUppercaseTokens >= 2
      ? line.slice(0, line.lastIndexOf(last)).trim()
      : line;
  });
  const trimmed = lines.join("\n");
  const meaningful = Array.from(
    trimmed.matchAll(/[\p{L}\p{N}]/gu),
    (match) => match[0],
  );
  if (meaningful.length === 0) return "";
  if (
    meaningful.length === 1 &&
    !/[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      meaningful[0] ?? "",
    )
  ) {
    return "";
  }
  const tokens = trimmed.match(/[\p{L}\p{N}]+/gu) ?? [];
  const isolatedTokens = tokens.filter((token) => token.length === 1).length;
  if (
    tokens.length >= 6 &&
    isolatedTokens / tokens.length >= 0.5 &&
    /[\d[\]{}=]/u.test(trimmed)
  ) {
    return "";
  }
  return trimmed;
}

function normalizedOcrCandidate(text: string): string {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function textSimilarity(left: string, right: string): number {
  const a = normalizedOcrCandidate(left);
  const b = normalizedOcrCandidate(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    const current = [aIndex];
    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      current[bIndex] = Math.min(
        (current[bIndex - 1] ?? 0) + 1,
        (previous[bIndex] ?? 0) + 1,
        (previous[bIndex - 1] ?? 0) + (a[aIndex - 1] === b[bIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return (
    1 -
    (previous[b.length] ?? Math.max(a.length, b.length)) /
      Math.max(a.length, b.length)
  );
}

export class OcrSession {
  private enabled: boolean;
  private sourceLanguage: string;
  private readonly adapter: OcrSubtitleAdapter;
  private readonly engine: LocalOcrEngine;
  private readonly selector: OcrRegionSelector;
  private readonly sampler = new OcrSampler(OCR_SAMPLE_INTERVAL_MS);
  private readonly deduplicator = new OcrFrameDeduplicator();
  private readonly onStatus: ((status: OcrStatus) => void) | undefined;
  private readonly onMediaTarget:
    ((target: HTMLElement | null) => void) | undefined;
  private readonly onTrackUpdated: (() => void) | undefined;
  private readonly onStopped: (() => void) | undefined;
  private readonly ignoreRecognizedText:
    ((text: string) => boolean) | undefined;
  private readonly filterRecognizedText: ((text: string) => string) | undefined;
  private readonly capture: (
    signal: AbortSignal,
  ) => Promise<OcrCaptureResponse>;
  private lifecycle: AbortController | undefined;
  private mediaTarget: HTMLElement | null = null;
  /** The selected crop stays relative to the media element as its box moves. */
  private mediaRegion: NonNullable<OcrStatus["region"]> | null = null;
  private video: HTMLVideoElement | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private blackFrames = 0;
  private consecutiveSampleErrors = 0;
  private inactiveTabPaused = false;
  private consecutiveEmptyFrames = 0;
  private pendingEmptyFingerprint: Uint8Array | undefined;
  private pendingCandidate: { text: string; capturedAtMs: number } | undefined;
  /** Reuse the crop variant that proved more reliable for this media timeline. */
  private preferredFrameKind: "binary" | "original" = "original";
  private recognized = 0;
  private videoSource = "";
  private lastVideoTimeMs: number | undefined;
  private nonVideoLogicalTimeMs = 0;
  private nonVideoStableSamples = 0;
  private nonVideoNextCaptureAtMs = 0;
  private nonVideoLastCropFingerprint: Uint8Array | undefined;
  private nonVideoLastMediaFingerprint: Uint8Array | undefined;
  private seenNonBlackFrame = false;
  private blackFramesWithPlayback = 0;
  private lastBlackVideoTimeMs: number | undefined;
  private timelineGeneration = 0;
  private status: OcrStatus;
  private readonly sessionId = runtimeId("ocr-capture-session");
  private captureSequence = 0;
  private readonly handleVideoSeeking = (): void => {
    if (!this.video || !this.lifecycle) return;
    this.beginTimeline(this.video, true);
  };
  private readonly handleIframeLoad = (): void => {
    if (!this.iframe || !this.lifecycle) return;
    this.stopWithUnavailable(message("ocrVideoChanged"));
  };
  private readonly mediaResizeObserver =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => this.refreshProjectedRegion());
  private readonly handleMediaGeometryChange = (): void => {
    this.refreshProjectedRegion();
  };

  constructor(options: OcrSessionOptions) {
    this.enabled = options.enabled;
    this.sourceLanguage = options.sourceLanguage?.trim() || "auto";
    this.adapter = options.adapter;
    this.engine = options.engine ?? createLocalOcrEngine();
    this.selector = options.selector ?? new OcrRegionSelector();
    this.onStatus = options.onStatus
      ? (status) => options.onStatus?.(status)
      : undefined;
    this.onMediaTarget = options.onMediaTarget
      ? (target) => options.onMediaTarget?.(target)
      : undefined;
    this.onTrackUpdated = options.onTrackUpdated
      ? () => options.onTrackUpdated?.()
      : undefined;
    this.onStopped = options.onStopped
      ? () => options.onStopped?.()
      : undefined;
    this.ignoreRecognizedText = options.ignoreRecognizedText
      ? (text) => options.ignoreRecognizedText?.(text) ?? false
      : undefined;
    this.filterRecognizedText = options.filterRecognizedText
      ? (text) => options.filterRecognizedText?.(text) ?? text
      : undefined;
    this.capture =
      options.capture ??
      (async (signal) => {
        if (signal.aborted)
          throw new DOMException("OCR cancelled.", "AbortError");
        this.captureSequence += 1;
        const response: unknown = await browser.runtime.sendMessage({
          target: OCR_BACKGROUND_TARGET,
          type: "OCR_CAPTURE_FRAME",
          sessionId: this.sessionId,
          requestId: runtimeId(`ocr-capture-${this.captureSequence}`),
        });
        if (signal.aborted)
          throw new DOMException("OCR cancelled.", "AbortError");
        return isCaptureResponse(response)
          ? response
          : { ok: false, error: "capture_failed" };
      });
    this.status = {
      state: this.enabled ? "idle" : "disabled",
      recognized: 0,
    };
  }

  getStatus(): OcrStatus {
    return this.status.region
      ? { ...this.status, region: { ...this.status.region } }
      : { ...this.status };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.stop("disabled");
    } else if (this.status.state === "disabled") {
      this.setStatus({ state: "idle", recognized: 0 });
    }
  }

  setSourceLanguage(sourceLanguage: string): void {
    const normalized = sourceLanguage.trim() || "auto";
    if (normalized === this.sourceLanguage) return;
    this.sourceLanguage = normalized;
    if (this.lifecycle) this.stop("idle");
  }

  async start(): Promise<OcrStatus> {
    this.stop(this.enabled ? "idle" : "disabled");
    if (!this.enabled) return this.getStatus();
    if (!isOcrSourceLanguageSupported(this.sourceLanguage)) {
      this.setStatus({
        state: "unavailable",
        recognized: 0,
        message: message("ocrSourceLanguageUnsupported"),
      });
      return this.getStatus();
    }
    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    this.setStatus({ state: "initializing", recognized: 0, progress: 0 });
    let availability: Awaited<ReturnType<LocalOcrEngine["availability"]>>;
    try {
      availability = await this.engine.availability();
    } catch (error) {
      if (lifecycle.signal.aborted || this.lifecycle !== lifecycle) {
        return this.getStatus();
      }
      this.lifecycle = undefined;
      this.setStatus({
        state: "error",
        recognized: 0,
        message: ocrStartErrorMessage(error),
      });
      this.onStopped?.();
      return this.getStatus();
    }
    if (lifecycle.signal.aborted || this.lifecycle !== lifecycle) {
      return this.getStatus();
    }
    if (availability !== "available") {
      this.lifecycle = undefined;
      this.setStatus({
        state: "unavailable",
        recognized: 0,
        message: message("ocrLocalUnavailable"),
      });
      return this.getStatus();
    }
    const mediaTarget = selectOcrMediaTarget();
    if (!mediaTarget) {
      this.lifecycle = undefined;
      this.setStatus({
        state: "unavailable",
        recognized: 0,
        message: message("ocrVideoUnavailable"),
      });
      return this.getStatus();
    }
    if (ocrMediaTargetIsPictureInPicture(mediaTarget)) {
      this.lifecycle = undefined;
      this.setStatus({
        state: "unavailable",
        recognized: 0,
        message: message("ocrPictureInPictureUnsupported"),
      });
      return this.getStatus();
    }
    this.mediaTarget = mediaTarget;
    this.video = mediaTarget instanceof HTMLVideoElement ? mediaTarget : null;
    this.iframe = mediaTarget instanceof HTMLIFrameElement ? mediaTarget : null;
    this.iframe?.addEventListener("load", this.handleIframeLoad);
    this.setStatus({ state: "selecting", recognized: 0 });
    let preparationProgress = 0;
    let preparationError: unknown;
    const preparation = this.engine.prepare
      ? this.engine
          .prepare(
            lifecycle.signal,
            ({ progress }) => {
              preparationProgress = progress;
              if (
                (this.status.state !== "selecting" &&
                  this.status.state !== "initializing") ||
                lifecycle.signal.aborted ||
                this.lifecycle !== lifecycle
              ) {
                return;
              }
              this.setStatusWithProjectedRegion({
                state: this.status.state,
                recognized: 0,
                progress,
              });
            },
            this.sourceLanguage,
          )
          .then(
            () => ({ ok: true as const }),
            (error: unknown) => {
              preparationError = error;
              if (!lifecycle.signal.aborted && this.lifecycle === lifecycle) {
                this.selector.destroy();
              }
              return { ok: false as const, error };
            },
          )
      : Promise.resolve({ ok: true as const });
    try {
      const region = await this.selector.select(mediaTarget, lifecycle.signal);
      if (lifecycle.signal.aborted || this.lifecycle !== lifecycle)
        return this.getStatus();
      const videoRegion = ocrRegionRelativeToBounds(
        region,
        mediaTarget.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
      );
      if (!videoRegion) throw new Error("ocr_video_geometry_invalid");
      this.mediaRegion = videoRegion;
      this.observeMediaGeometry(mediaTarget);
      if (this.engine.prepare) {
        this.setStatusWithProjectedRegion({
          state: "initializing",
          recognized: 0,
          progress: preparationProgress,
        });
        const prepared = await preparation;
        if (!prepared.ok) throw prepared.error;
        if (lifecycle.signal.aborted || this.lifecycle !== lifecycle)
          return this.getStatus();
      }
      this.onMediaTarget?.(mediaTarget);
      this.beginTimeline(mediaTarget, false);
      this.video?.addEventListener("seeking", this.handleVideoSeeking);
      this.video?.addEventListener("loadstart", this.handleVideoSeeking);
      this.video?.addEventListener("emptied", this.handleVideoSeeking);
      this.setStatusWithProjectedRegion({ state: "capturing", recognized: 0 });
      this.sampler.start(async (signal) => {
        try {
          await this.sample(signal);
          if (!signal.aborted && this.lifecycle === lifecycle) {
            this.consecutiveSampleErrors = 0;
          }
        } catch (error) {
          if (!signal.aborted && !isAbortError(error)) {
            this.consecutiveSampleErrors += 1;
            if (this.consecutiveSampleErrors >= MAX_CONSECUTIVE_SAMPLE_ERRORS) {
              this.stopWithError(message("ocrRecognitionFailed"));
            } else {
              this.setStatusWithProjectedRegion({
                state: "capturing",
                recognized: this.recognized,
              });
            }
          }
        }
      });
    } catch (error) {
      // A previous start() may settle after stop() has already installed a new
      // lifecycle. Its delayed preparation/selection failure belongs only to
      // that obsolete run and must not clear the new media target or engine.
      if (lifecycle.signal.aborted || this.lifecycle !== lifecycle) {
        return this.getStatus();
      }
      const effectiveError = preparationError ?? error;
      if (isAbortError(effectiveError)) {
        if (this.lifecycle === lifecycle) this.stop("cancelled");
      } else if (
        effectiveError instanceof Error &&
        effectiveError.message === "ocr_selection_viewport_changed"
      ) {
        this.lifecycle = undefined;
        void this.engine.endSession?.();
        this.clearMediaTarget();
        this.resetTimelineIdentity();
        this.setStatus({
          state: "error",
          recognized: 0,
          message: message("ocrVideoChanged"),
        });
        this.onStopped?.();
      } else {
        this.lifecycle = undefined;
        void this.engine.endSession?.();
        this.clearMediaTarget();
        this.resetTimelineIdentity();
        this.setStatus({
          state: "error",
          recognized: 0,
          message: ocrStartErrorMessage(effectiveError),
        });
        this.onStopped?.();
      }
    }
    return this.getStatus();
  }

  rejectStart(reason: string): OcrStatus {
    this.stopWithUnavailable(reason);
    return this.getStatus();
  }

  stop(state: "disabled" | "idle" | "cancelled" = "cancelled"): OcrStatus {
    this.lifecycle?.abort();
    this.lifecycle = undefined;
    this.sampler.stop();
    this.selector.destroy();
    this.adapter.stop();
    void this.engine.endSession?.();
    this.clearMediaTarget();
    this.blackFrames = 0;
    this.consecutiveSampleErrors = 0;
    this.inactiveTabPaused = false;
    this.consecutiveEmptyFrames = 0;
    this.pendingEmptyFingerprint = undefined;
    this.pendingCandidate = undefined;
    this.preferredFrameKind = "original";
    this.deduplicator.reset();
    this.videoSource = "";
    this.lastVideoTimeMs = undefined;
    this.resetNonVideoSamplingState();
    this.resetBlackFrameEvidence();
    this.seenNonBlackFrame = false;
    this.timelineGeneration += 1;
    this.setStatus({
      state,
      recognized: state === "cancelled" ? this.recognized : 0,
    });
    this.onTrackUpdated?.();
    return this.getStatus();
  }

  destroy(): void {
    this.stop(this.enabled ? "idle" : "disabled");
    void this.engine.destroy?.();
  }

  private async sample(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const timelineGeneration = this.synchronizeTimeline();
    if (timelineGeneration === null) return;
    // A loaded paused/ended video cannot produce a new subtitle frame. Keep the
    // lightweight sampler alive so playback resumes automatically, but avoid a
    // captureVisibleTab request every interval while playback is stationary.
    if (
      this.video &&
      (this.video.ended || (this.video.paused && this.video.readyState > 0))
    ) {
      this.setStatusWithProjectedRegion({
        state: "active",
        recognized: this.recognized,
      });
      return;
    }
    if (!this.video && performance.now() < this.nonVideoNextCaptureAtMs) {
      return;
    }
    if (!this.projectMediaRegion()) {
      this.refreshProjectedRegion();
      return;
    }
    let capturedAtMs = this.currentMediaTimeMs();
    if (!this.inactiveTabPaused) {
      this.setStatusWithProjectedRegion({
        state: "capturing",
        recognized: this.recognized,
      });
    }
    const captureRegion = this.projectMediaRegion();
    if (!captureRegion) {
      this.refreshProjectedRegion();
      return;
    }
    const restoreSubtitleOverlay = hideInjectedUiForCapture();
    let capture: OcrCaptureResponse;
    try {
      capture = await this.capture(signal);
    } finally {
      restoreSubtitleOverlay();
    }
    if (signal.aborted || !this.isTimelineCurrent(timelineGeneration)) return;
    if (!capture.ok || !capture.dataUrl) {
      if (capture.error === "rate_limited") return;
      if (capture.error === "inactive_tab") {
        this.inactiveTabPaused = true;
        this.setStatusWithProjectedRegion({
          state: "capturing",
          recognized: this.recognized,
          message: message("ocrInactiveTabPaused"),
        });
        return;
      }
      const reason =
        capture.error === "permission_required"
          ? message("ocrCapturePermissionRequired")
          : capture.error === "capture_too_large"
            ? message("ocrCaptureTooLarge")
            : capture.message
              ? `${message("ocrCaptureUnavailable")} (${capture.message})`
              : message("ocrCaptureUnavailable");
      this.stopWithUnavailable(reason);
      return;
    }
    if (this.inactiveTabPaused) {
      this.inactiveTabPaused = false;
      this.setStatusWithProjectedRegion({
        state: "capturing",
        recognized: this.recognized,
      });
    }
    const region = this.projectMediaRegion();
    if (!region) {
      this.refreshProjectedRegion();
      return;
    }
    const mediaRegion = this.projectWholeMediaRegion();
    const frame = await prepareOcrFrame(
      capture.dataUrl,
      region,
      signal,
      mediaRegion ?? undefined,
    );
    if (signal.aborted || !this.isTimelineCurrent(timelineGeneration)) {
      releasePreparedFrame(frame);
      return;
    }
    let nonVideoFrameChanged = true;
    if (!this.video) {
      const observed = this.observeNonVideoFrame(frame);
      capturedAtMs = observed.capturedAtMs;
      nonVideoFrameChanged = observed.changed;
    }
    const stableBlackIframeCrop = Boolean(
      this.iframe &&
      this.seenNonBlackFrame &&
      frame.black &&
      frame.mediaBlack === false &&
      !nonVideoFrameChanged,
    );
    if (frame.black && (frame.mediaBlack !== false || stableBlackIframeCrop)) {
      this.blackFrames += 1;
      this.consecutiveEmptyFrames = 0;
      this.pendingEmptyFingerprint = undefined;
      this.pendingCandidate = undefined;
      releasePreparedFrame(frame);
      if (this.blackFrames >= 2 && this.adapter.end(capturedAtMs)) {
        this.onTrackUpdated?.();
      }
      if (this.blackFrameHasPlaybackEvidence(capturedAtMs)) {
        this.blackFramesWithPlayback += 1;
      }
      if (
        this.video &&
        !this.seenNonBlackFrame &&
        this.blackFramesWithPlayback >= MAX_CONSECUTIVE_BLACK_FRAMES
      ) {
        this.stopWithUnavailable(message("ocrProtectedVideoUnsupported"));
      } else if (
        this.iframe &&
        this.seenNonBlackFrame &&
        this.blackFrames >= MAX_CONSECUTIVE_BLACK_FRAMES
      ) {
        this.stopWithUnavailable(message("ocrProtectedVideoUnsupported"));
      } else {
        this.setStatusWithProjectedRegion({
          state: "active",
          recognized: this.recognized,
          ...(!this.video && this.blackFrames >= MAX_CONSECUTIVE_BLACK_FRAMES
            ? { message: message("ocrBlackFrameWaiting") }
            : {}),
        });
      }
      return;
    }
    this.blackFrames = 0;
    this.resetBlackFrameEvidence();
    this.seenNonBlackFrame = true;
    if (frame.black) {
      this.pendingEmptyFingerprint = undefined;
      this.pendingCandidate = undefined;
      this.consecutiveEmptyFrames += 1;
      releasePreparedFrame(frame);
      if (
        this.consecutiveEmptyFrames >= EMPTY_FRAMES_TO_END_CUE &&
        this.adapter.end(capturedAtMs)
      ) {
        this.onTrackUpdated?.();
      }
      this.setStatusWithProjectedRegion({
        state: "active",
        recognized: this.recognized,
      });
      return;
    }
    if (
      !this.video &&
      !nonVideoFrameChanged &&
      !this.pendingCandidate &&
      !this.pendingEmptyFingerprint
    ) {
      releasePreparedFrame(frame);
      this.setStatusWithProjectedRegion({
        state: "active",
        recognized: this.recognized,
      });
      return;
    }
    if (
      !this.deduplicator.shouldRecognize(frame.fingerprint) &&
      !this.pendingCandidate
    ) {
      if (
        this.pendingEmptyFingerprint &&
        ocrFrameDifference(this.pendingEmptyFingerprint, frame.fingerprint) <
          EMPTY_FRAME_CONFIRMATION_DIFFERENCE
      ) {
        this.pendingEmptyFingerprint = undefined;
        this.consecutiveEmptyFrames += 1;
        if (
          this.consecutiveEmptyFrames >= EMPTY_FRAMES_TO_END_CUE &&
          this.adapter.end(capturedAtMs)
        ) {
          this.onTrackUpdated?.();
        }
      }
      releasePreparedFrame(frame);
      this.setStatusWithProjectedRegion({
        state: "active",
        recognized: this.recognized,
      });
      return;
    }
    this.setStatusWithProjectedRegion({
      state: "recognizing",
      recognized: this.recognized,
    });
    const originalPreferred =
      this.preferredFrameKind === "original" && Boolean(frame.originalCanvas);
    const primaryCanvas = originalPreferred
      ? (frame.originalCanvas ?? frame.canvas)
      : frame.canvas;
    const fallbackCanvas = originalPreferred
      ? frame.canvas
      : frame.originalCanvas;
    let recognition: OcrRecognitionResult;
    let text: string;
    try {
      recognition = await this.engine.recognize(primaryCanvas, signal);
      text = filterOcrSubtitleText(ocrRecognitionText(recognition));
      const confidence = recognitionConfidence(recognition);
      if (fallbackCanvas && shouldTryAlternateFrame(text, confidence)) {
        const fallback = await this.engine.recognize(fallbackCanvas, signal);
        const fallbackText = filterOcrSubtitleText(
          ocrRecognitionText(fallback),
        );
        const fallbackConfidence = recognitionConfidence(fallback);
        if (
          alternateRecognitionIsBetter(
            text,
            confidence,
            fallbackText,
            fallbackConfidence,
          )
        ) {
          recognition = fallback;
          text = fallbackText;
          this.preferredFrameKind = originalPreferred ? "binary" : "original";
        }
      }
    } finally {
      releasePreparedFrame(frame);
    }
    if (signal.aborted || !this.isTimelineCurrent(timelineGeneration)) return;
    if (text && this.filterRecognizedText) {
      text = this.filterRecognizedText(text);
    }
    if (text && this.ignoreRecognizedText?.(text)) {
      this.pendingCandidate = undefined;
      this.setStatusWithProjectedRegion({
        state: "active",
        recognized: this.recognized,
      });
      return;
    }
    const quality = this.recognitionQuality(recognition, text, capturedAtMs);
    if (text && quality === "publish") {
      this.consecutiveEmptyFrames = 0;
      this.pendingEmptyFingerprint = undefined;
      if (this.adapter.push(text, capturedAtMs)) {
        this.recognized += 1;
        this.onTrackUpdated?.();
      }
    } else if (quality === "pending") {
      this.nonVideoNextCaptureAtMs = 0;
      this.consecutiveEmptyFrames = 0;
      this.pendingEmptyFingerprint = undefined;
    } else {
      this.nonVideoNextCaptureAtMs = 0;
      this.pendingEmptyFingerprint = frame.fingerprint.slice();
      this.consecutiveEmptyFrames += 1;
      if (
        this.consecutiveEmptyFrames >= EMPTY_FRAMES_TO_END_CUE &&
        this.adapter.end(capturedAtMs)
      ) {
        this.pendingEmptyFingerprint = undefined;
        this.onTrackUpdated?.();
      }
    }
    this.setStatusWithProjectedRegion({
      state: "active",
      recognized: this.recognized,
    });
  }

  private recognitionQuality(
    recognition: OcrRecognitionResult,
    text: string,
    capturedAtMs: number,
  ): "publish" | "pending" | "reject" {
    if (!text) {
      this.pendingCandidate = undefined;
      return "reject";
    }
    const confidence =
      typeof recognition === "string" ? undefined : recognition.confidence;
    if (confidence === undefined || confidence >= OCR_HIGH_CONFIDENCE) {
      this.pendingCandidate = undefined;
      return "publish";
    }
    if (confidence < OCR_MIN_CONFIDENCE) {
      this.pendingCandidate = undefined;
      return "reject";
    }
    const pending = this.pendingCandidate;
    if (
      pending &&
      capturedAtMs - pending.capturedAtMs <= OCR_CANDIDATE_MAX_AGE_MS &&
      textSimilarity(pending.text, text) >= OCR_CANDIDATE_SIMILARITY
    ) {
      this.pendingCandidate = undefined;
      return "publish";
    }
    this.pendingCandidate = { text, capturedAtMs };
    return "pending";
  }

  private stopWithUnavailable(reason: string): void {
    const recognized = this.recognized;
    this.lifecycle?.abort();
    this.lifecycle = undefined;
    this.sampler.stop();
    this.selector.destroy();
    this.adapter.stop();
    void this.engine.endSession?.();
    this.clearMediaTarget();
    this.resetTimelineIdentity();
    this.setStatus({ state: "unavailable", recognized, message: reason });
    this.onTrackUpdated?.();
    this.onStopped?.();
  }

  private stopWithError(reason: string): void {
    const recognized = this.recognized;
    this.lifecycle?.abort();
    this.lifecycle = undefined;
    this.sampler.stop();
    this.selector.destroy();
    this.adapter.stop();
    void this.engine.endSession?.();
    this.clearMediaTarget();
    this.resetTimelineIdentity();
    this.setStatus({ state: "error", recognized, message: reason });
    this.onTrackUpdated?.();
    this.onStopped?.();
  }

  private setStatus(status: OcrStatus): void {
    this.status = status;
    this.onStatus?.(this.getStatus());
  }

  private setStatusWithProjectedRegion(
    status: Omit<OcrStatus, "region">,
  ): void {
    const region = this.projectMediaRegion();
    this.setStatus(region ? { ...status, region } : status);
  }

  private projectMediaRegion(): NonNullable<OcrStatus["region"]> | null {
    if (!this.mediaTarget || !this.mediaRegion) return null;
    return projectOcrRegionToViewport(
      this.mediaRegion,
      this.mediaTarget.getBoundingClientRect(),
      window.innerWidth,
      window.innerHeight,
    );
  }

  private projectWholeMediaRegion(): NonNullable<OcrStatus["region"]> | null {
    if (!this.mediaTarget) return null;
    return projectOcrRegionToViewport(
      { x: 0, y: 0, width: 1, height: 1 },
      this.mediaTarget.getBoundingClientRect(),
      window.innerWidth,
      window.innerHeight,
    );
  }

  private refreshProjectedRegion(): void {
    if (!this.mediaRegion) return;
    const status = { ...this.status };
    delete status.region;
    this.setStatusWithProjectedRegion(status);
  }

  private observeMediaGeometry(target: HTMLElement): void {
    this.mediaResizeObserver?.disconnect();
    this.mediaResizeObserver?.observe(target);
    document.addEventListener(
      "fullscreenchange",
      this.handleMediaGeometryChange,
    );
    window.addEventListener("resize", this.handleMediaGeometryChange);
    window.addEventListener("scroll", this.handleMediaGeometryChange, true);
  }

  private clearMediaTarget(): void {
    this.mediaResizeObserver?.disconnect();
    document.removeEventListener(
      "fullscreenchange",
      this.handleMediaGeometryChange,
    );
    window.removeEventListener("resize", this.handleMediaGeometryChange);
    window.removeEventListener("scroll", this.handleMediaGeometryChange, true);
    this.video?.removeEventListener("seeking", this.handleVideoSeeking);
    this.video?.removeEventListener("loadstart", this.handleVideoSeeking);
    this.video?.removeEventListener("emptied", this.handleVideoSeeking);
    this.iframe?.removeEventListener("load", this.handleIframeLoad);
    this.video = null;
    this.iframe = null;
    this.mediaTarget = null;
    this.mediaRegion = null;
    this.onMediaTarget?.(null);
  }

  private currentMediaTimeMs(): number {
    if (this.video) {
      return Math.max(0, Math.round(this.video.currentTime * 1_000));
    }
    return this.nonVideoLogicalTimeMs;
  }

  private beginTimeline(mediaTarget: HTMLElement, notify: boolean): void {
    this.adapter.begin(
      this.sourceLanguage === "auto" ? "und" : this.sourceLanguage,
    );
    this.deduplicator.reset();
    this.blackFrames = 0;
    this.consecutiveSampleErrors = 0;
    this.inactiveTabPaused = false;
    this.consecutiveEmptyFrames = 0;
    this.pendingEmptyFingerprint = undefined;
    this.pendingCandidate = undefined;
    this.preferredFrameKind = "original";
    this.recognized = 0;
    this.videoSource = ocrMediaTargetSource(mediaTarget);
    this.resetNonVideoSamplingState();
    this.resetBlackFrameEvidence();
    this.seenNonBlackFrame = false;
    this.lastVideoTimeMs = this.currentMediaTimeMs();
    this.timelineGeneration += 1;
    if (notify) this.onTrackUpdated?.();
  }

  private synchronizeTimeline(): number | null {
    const mediaTarget = this.mediaTarget;
    if (!mediaTarget) return null;
    if (!ocrMediaTargetIsCurrent(mediaTarget)) {
      this.stopWithUnavailable(message("ocrVideoChanged"));
      return null;
    }
    const source = ocrMediaTargetSource(mediaTarget);
    const currentTimeMs = this.currentMediaTimeMs();
    const seekedBackward =
      this.lastVideoTimeMs !== undefined &&
      currentTimeMs < this.lastVideoTimeMs;
    if (source !== this.videoSource || seekedBackward) {
      this.beginTimeline(mediaTarget, true);
    } else {
      this.lastVideoTimeMs = currentTimeMs;
    }
    return this.timelineGeneration;
  }

  private isTimelineCurrent(generation: number): boolean {
    if (generation !== this.timelineGeneration) return false;
    const mediaTarget = this.mediaTarget;
    if (!mediaTarget) return false;
    if (!ocrMediaTargetIsCurrent(mediaTarget)) {
      this.stopWithUnavailable(message("ocrVideoChanged"));
      return false;
    }
    const source = ocrMediaTargetSource(mediaTarget);
    const currentTimeMs = this.currentMediaTimeMs();
    const seekedBackward =
      this.lastVideoTimeMs !== undefined &&
      currentTimeMs < this.lastVideoTimeMs;
    if (source !== this.videoSource || seekedBackward) {
      this.beginTimeline(mediaTarget, true);
      return false;
    }
    this.lastVideoTimeMs = currentTimeMs;
    return true;
  }

  private resetTimelineIdentity(): void {
    this.blackFrames = 0;
    this.consecutiveSampleErrors = 0;
    this.inactiveTabPaused = false;
    this.consecutiveEmptyFrames = 0;
    this.pendingEmptyFingerprint = undefined;
    this.pendingCandidate = undefined;
    this.preferredFrameKind = "original";
    this.deduplicator.reset();
    this.videoSource = "";
    this.lastVideoTimeMs = undefined;
    this.resetNonVideoSamplingState();
    this.resetBlackFrameEvidence();
    this.seenNonBlackFrame = false;
    this.timelineGeneration += 1;
  }

  private observeNonVideoFrame(frame: PreparedOcrFrame): {
    capturedAtMs: number;
    changed: boolean;
  } {
    const cropChanged = ocrFingerprintChanged(
      this.nonVideoLastCropFingerprint,
      frame.fingerprint,
    );
    const mediaFingerprint = frame.mediaFingerprint;
    const mediaChanged = mediaFingerprint
      ? ocrFingerprintChanged(
          this.nonVideoLastMediaFingerprint,
          mediaFingerprint,
        )
      : false;
    const firstSample = this.nonVideoLastCropFingerprint === undefined;
    const changed = firstSample || cropChanged || mediaChanged;
    if (changed) {
      if (!firstSample) this.nonVideoLogicalTimeMs += OCR_SAMPLE_INTERVAL_MS;
      this.nonVideoStableSamples = 0;
      this.nonVideoNextCaptureAtMs = 0;
    } else {
      this.nonVideoStableSamples += 1;
      if (
        this.nonVideoStableSamples >= NON_VIDEO_STABLE_SAMPLES &&
        !this.pendingCandidate &&
        !this.pendingEmptyFingerprint
      ) {
        this.nonVideoNextCaptureAtMs =
          performance.now() + NON_VIDEO_PROBE_INTERVAL_MS;
      }
    }
    this.nonVideoLastCropFingerprint = frame.fingerprint.slice();
    this.nonVideoLastMediaFingerprint = mediaFingerprint?.slice();
    return { capturedAtMs: this.nonVideoLogicalTimeMs, changed };
  }

  private blackFrameHasPlaybackEvidence(capturedAtMs: number): boolean {
    const video = this.video;
    if (!video || video.paused || video.ended || video.readyState < 2) {
      this.lastBlackVideoTimeMs = capturedAtMs;
      return false;
    }
    const previous = this.lastBlackVideoTimeMs;
    this.lastBlackVideoTimeMs = capturedAtMs;
    return previous !== undefined && capturedAtMs > previous;
  }

  private resetBlackFrameEvidence(): void {
    this.blackFramesWithPlayback = 0;
    this.lastBlackVideoTimeMs = undefined;
  }

  private resetNonVideoSamplingState(): void {
    this.nonVideoLogicalTimeMs = 0;
    this.nonVideoStableSamples = 0;
    this.nonVideoNextCaptureAtMs = 0;
    this.nonVideoLastCropFingerprint = undefined;
    this.nonVideoLastMediaFingerprint = undefined;
  }
}
