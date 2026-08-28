import {
  getSharedCachedTranslation,
  setSharedCachedTranslation,
} from "@/src/cache/content-client";
import { promptVersion, sha256, translationCacheKey } from "@/src/cache/keys";
import type { TranslationResponse } from "@/src/messaging/protocol";
import { createLocalOcrEngine, type OcrRecognition } from "@/src/ocr/engine";
import { analyzeOcrPixels } from "@/src/ocr/frame-analysis";
import {
  OCR_MAX_IMAGE_HEIGHT,
  OCR_MAX_IMAGE_PIXELS,
  OCR_MAX_IMAGE_WIDTH,
  type OcrCaptureResponse,
  type OcrTextBox,
} from "@/src/ocr/types";
import type { ContentSettings } from "@/src/shared/settings";
import { NTransError } from "@/src/shared/errors";
import { message } from "@/src/shared/i18n";
import { runtimeId } from "@/src/shared/runtime-id";
import { ChromeLocalProvider } from "@/src/translation/providers/chrome-local";
import { subscribeTranslationProgress } from "@/src/translation/progress-channel";
import { scheduleTranslation } from "@/src/translation/scheduler";
import type {
  TranslationRequest,
  TranslationResult,
  TranslationSegment,
} from "@/src/translation/types";
import { browser } from "wxt/browser";

const MIN_IMAGE_WIDTH = 160;
const MIN_IMAGE_HEIGHT = 96;
const MIN_IMAGE_AREA = 24_000;
const MAX_TEXT_BOXES = 30;
const MAX_CONCURRENT_IMAGES = 2;
const CONTROL_HIDE_DELAY_MS = 360;
const MAX_IMAGE_SOURCE_BYTES = 8_000_000;

export type ImageTranslationState =
  | "disabled"
  | "idle"
  | "available"
  | "capturing"
  | "recognizing"
  | "translating"
  | "ready"
  | "cancelled"
  | "unavailable"
  | "error";

export interface ImageTranslationStatus {
  state: ImageTranslationState;
  total: number;
  completed: number;
  message?: string;
  details?: string;
  hasCurrentImage: boolean;
}

export interface ImageTranslationControllerOptions {
  settings: ContentSettings;
  onStatus?(status: ImageTranslationStatus): void;
}

interface CropResult {
  canvas: HTMLCanvasElement;
  canvasWidth: number;
  canvasHeight: number;
  sourceRect: DOMRect;
  imageRect: DOMRect;
}

interface SpatialSegment extends TranslationSegment {
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface ImageRecord {
  image: HTMLImageElement;
  overlay: HTMLElement;
  root: ShadowRoot;
  boxes: SpatialSegment[];
  controller: AbortController | undefined;
  status: ImageTranslationStatus;
}

function abortError(): DOMException {
  return new DOMException("Image translation cancelled", "AbortError");
}

function isCaptureResponse(value: unknown): value is OcrCaptureResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

function isTranslationResponse(value: unknown): value is TranslationResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

function visibleImageRect(image: HTMLImageElement): DOMRect | null {
  if (!image.isConnected || !image.complete || image.naturalWidth <= 0) {
    return null;
  }
  const style = getComputedStyle(image);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number(style.opacity) <= 0
  ) {
    return null;
  }
  const rect = image.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (
    rect.width < MIN_IMAGE_WIDTH ||
    rect.height < MIN_IMAGE_HEIGHT ||
    rect.width * rect.height < MIN_IMAGE_AREA ||
    right - left < 40 ||
    bottom - top < 32
  ) {
    return null;
  }
  return rect;
}

function eligibleImage(image: HTMLImageElement): boolean {
  if (!image.isConnected || !image.complete || image.naturalWidth <= 0)
    return false;
  const rect = image.getBoundingClientRect();
  const style = getComputedStyle(image);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) > 0 &&
    rect.width >= MIN_IMAGE_WIDTH &&
    rect.height >= MIN_IMAGE_HEIGHT &&
    rect.width * rect.height >= MIN_IMAGE_AREA
  );
}

async function decodeImageSource(
  dataUrl: string,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      cleanup();
      reject(abortError());
    };
    image.onload = () => {
      cleanup();
      resolve();
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("image_source_decode_failed"));
    };
    signal.addEventListener("abort", abort, { once: true });
    image.src = dataUrl;
  });
  return image;
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectPositionOffset(value: string, freeSpace: number): number {
  const normalized = value.trim().toLowerCase();
  if (normalized === "left" || normalized === "top") return 0;
  if (normalized === "right" || normalized === "bottom") return freeSpace;
  if (normalized === "center") return freeSpace / 2;
  if (normalized.endsWith("%")) {
    return (freeSpace * cssPixels(normalized)) / 100;
  }
  return cssPixels(normalized);
}

function displayedSourceRect(
  image: HTMLImageElement,
  source: HTMLImageElement,
  imageRect: DOMRect,
): DOMRect {
  const style = getComputedStyle(image);
  const leftInset =
    cssPixels(style.borderLeftWidth) + cssPixels(style.paddingLeft);
  const rightInset =
    cssPixels(style.borderRightWidth) + cssPixels(style.paddingRight);
  const topInset =
    cssPixels(style.borderTopWidth) + cssPixels(style.paddingTop);
  const bottomInset =
    cssPixels(style.borderBottomWidth) + cssPixels(style.paddingBottom);
  const contentRect = new DOMRect(
    imageRect.left + leftInset,
    imageRect.top + topInset,
    Math.max(1, imageRect.width - leftInset - rightInset),
    Math.max(1, imageRect.height - topInset - bottomInset),
  );
  const intrinsicWidth = Math.max(1, source.naturalWidth);
  const intrinsicHeight = Math.max(1, source.naturalHeight);
  const containScale = Math.min(
    contentRect.width / intrinsicWidth,
    contentRect.height / intrinsicHeight,
  );
  const coverScale = Math.max(
    contentRect.width / intrinsicWidth,
    contentRect.height / intrinsicHeight,
  );
  let renderedWidth = contentRect.width;
  let renderedHeight = contentRect.height;
  if (style.objectFit !== "fill") {
    const scale =
      style.objectFit === "cover"
        ? coverScale
        : style.objectFit === "none"
          ? 1
          : style.objectFit === "scale-down"
            ? Math.min(1, containScale)
            : containScale;
    renderedWidth = intrinsicWidth * scale;
    renderedHeight = intrinsicHeight * scale;
  }
  const [positionX = "50%", positionY = "50%"] = style.objectPosition
    .trim()
    .split(/\s+/u);
  return new DOMRect(
    contentRect.left +
      objectPositionOffset(positionX, contentRect.width - renderedWidth),
    contentRect.top +
      objectPositionOffset(positionY, contentRect.height - renderedHeight),
    renderedWidth,
    renderedHeight,
  );
}

async function prepareImageSource(
  image: HTMLImageElement,
  dataUrl: string,
  signal: AbortSignal,
): Promise<CropResult> {
  const imageRect = visibleImageRect(image);
  if (!imageRect) throw new Error("image_not_visible");
  const source = await decodeImageSource(dataUrl, signal);
  if (signal.aborted) throw abortError();
  const sourceWidth = source.naturalWidth;
  const sourceHeight = source.naturalHeight;
  const scale = Math.min(
    1,
    OCR_MAX_IMAGE_WIDTH / sourceWidth,
    OCR_MAX_IMAGE_HEIGHT / sourceHeight,
    Math.sqrt(OCR_MAX_IMAGE_PIXELS / (sourceWidth * sourceHeight)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(sourceWidth * scale));
  canvas.height = Math.max(1, Math.floor(sourceHeight * scale));
  canvas.dataset.ocrVariant = "original";
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("image_canvas_unavailable");
  context.drawImage(
    source,
    0,
    0,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  if (analyzeOcrPixels(pixels.data, canvas.width, canvas.height).black) {
    canvas.width = 1;
    canvas.height = 1;
    throw new Error("image_black_frame");
  }
  return {
    canvas,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    sourceRect: displayedSourceRect(image, source, imageRect),
    imageRect,
  };
}

async function blobDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  if (blob.size === 0 || blob.size > MAX_IMAGE_SOURCE_BYTES) {
    throw new Error(
      blob.size > MAX_IMAGE_SOURCE_BYTES
        ? "image_source_too_large"
        : "image_source_empty",
    );
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const abort = (): void => {
      reader.abort();
      cleanup();
      reject(abortError());
    };
    reader.onerror = () => {
      cleanup();
      reject(new Error("image_source_read_failed"));
    };
    reader.onload = () => {
      cleanup();
      if (typeof reader.result !== "string") {
        reject(new Error("image_source_read_failed"));
        return;
      }
      resolve(reader.result);
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.readAsDataURL(blob);
  });
}

async function readImageSource(
  image: HTMLImageElement,
  signal: AbortSignal,
): Promise<string> {
  const sourceUrl = image.currentSrc || image.src;
  if (!sourceUrl) throw new Error("image_source_unavailable");
  if (sourceUrl.startsWith("data:image/")) {
    if (sourceUrl.length > MAX_IMAGE_SOURCE_BYTES * 1.5) {
      throw new Error("image_source_too_large");
    }
    return sourceUrl;
  }
  if (sourceUrl.startsWith("blob:")) {
    const response = await fetch(sourceUrl, { signal });
    if (!response.ok) throw new Error("image_source_unavailable");
    return blobDataUrl(await response.blob(), signal);
  }
  if (!sourceUrl.startsWith("https://") && !sourceUrl.startsWith("http://")) {
    throw new Error("image_source_unavailable");
  }
  const response: unknown = await browser.runtime.sendMessage({
    type: "IMAGE_SOURCE_GET",
    url: sourceUrl,
  });
  if (signal.aborted) throw abortError();
  if (!isCaptureResponse(response) || !response.ok || !response.dataUrl) {
    throw new Error(
      isCaptureResponse(response) && response.error === "capture_too_large"
        ? "image_source_too_large"
        : isCaptureResponse(response) && response.message
          ? `image_source_unavailable:${response.message}`
          : "image_source_unavailable",
    );
  }
  return response.dataUrl;
}

function mergeTextBoxes(boxes: readonly OcrTextBox[]): OcrTextBox[] {
  const usable = boxes
    .filter(
      (box) =>
        box.text.trim() &&
        box.width > 1 &&
        box.height > 1 &&
        box.confidence !== 0,
    )
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const lines: OcrTextBox[] = [];
  for (const box of usable) {
    const text = box.text.replace(/\s+/gu, " ").trim().slice(0, 500);
    const centerY = box.y + box.height / 2;
    const match = [...lines].reverse().find((line) => {
      const lineCenter = line.y + line.height / 2;
      const vertical = Math.abs(centerY - lineCenter);
      const gap = box.x - (line.x + line.width);
      return (
        vertical <= Math.max(line.height, box.height) * 0.58 &&
        gap >= -Math.min(line.width, box.width) * 0.12 &&
        gap <= Math.max(line.height, box.height) * 2.4
      );
    });
    if (!match || (box.height >= 14 && box.width >= 32)) {
      lines.push({ ...box, text });
      continue;
    }
    const right = Math.max(match.x + match.width, box.x + box.width);
    const bottom = Math.max(match.y + match.height, box.y + box.height);
    match.x = Math.min(match.x, box.x);
    match.y = Math.min(match.y, box.y);
    match.width = right - match.x;
    match.height = bottom - match.y;
    match.text = `${match.text} ${text}`.trim().slice(0, 500);
    if (box.confidence !== undefined) {
      match.confidence =
        match.confidence === undefined
          ? box.confidence
          : Math.min(match.confidence, box.confidence);
    }
  }
  return lines.slice(0, MAX_TEXT_BOXES);
}

function imageTranslationSourceLanguage(
  configuredLanguage: string,
  segments: readonly TranslationSegment[],
): string {
  if (configuredLanguage !== "auto") return configuredLanguage;
  const text = segments.map((segment) => segment.text).join(" ");
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
  if (/\p{Script=Han}/u.test(text)) return "zh-CN";
  if (/[äöüß]/iu.test(text)) return "de";
  if (/[ñ¿¡]/iu.test(text)) return "es";
  if (/[àâæçéèêëîïôœùûüÿ]/iu.test(text)) return "fr";
  // OCR returns glyphs but not a dependable language tag. English is the
  // safest low-latency default for unaccented Latin image text; another
  // source language can still be selected explicitly.
  return "en";
}

const OVERLAY_STYLE = `
  :host { all: initial; position: fixed !important; inset: 0 !important; z-index: 2147483644 !important; pointer-events: none !important; color-scheme: light dark; }
  .box { position: fixed; display: grid; align-content: center; box-sizing: border-box; width: max-content; min-width: 18px; min-height: 16px; padding: 6px 10px; overflow: hidden; border: 0; border-radius: 8px; background: rgb(8 10 14 / 78%); color: #fff; font: 600 clamp(11px, var(--nt-font-size), 18px)/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 1px 3px rgb(0 0 0 / 45%); text-align: center; overflow-wrap: anywhere; white-space: normal; }
  .original { display: block; margin-bottom: 2px; color: #f4f6f8; font-size: .76em; font-weight: 500; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

const CONTROL_STYLE = `
  :host { all: initial; position: fixed !important; display: block !important; width: max-content !important; height: max-content !important; z-index: 2147483645 !important; pointer-events: none !important; color-scheme: light dark; }
  :host([hidden]) { display: none !important; }
  .bar { display: flex; width: max-content; align-items: center; gap: 4px; pointer-events: auto; }
  button { display: inline-grid; min-width: 44px; min-height: 44px; place-items: center; padding: 0 10px; border: 0; border-radius: 8px; background: rgb(8 10 14 / 82%); color: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 45%); font: 650 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer; }
  button.icon { width: 44px; padding: 0; }
  button.primary { background: rgb(8 10 14 / 88%); color: #fff; }
  button[hidden] { display: none; }
  button:disabled { cursor: wait; opacity: .68; }
  button:focus-visible { outline: 3px solid #c58a26; outline-offset: 2px; }
  svg { width: 19px; height: 19px; }
`;

export class ImageTranslationController {
  private settings: ContentSettings;
  private readonly onStatus: (status: ImageTranslationStatus) => void;
  private readonly controlHost = document.createElement(
    "norixor-image-translation-control",
  );
  private readonly translateButton = document.createElement("button");
  private readonly clearButton = document.createElement("button");
  private readonly records = new Map<HTMLImageElement, ImageRecord>();
  private readonly preparedImages = new Set<HTMLImageElement>();
  private readonly originalTabIndexes = new WeakMap<HTMLImageElement, number>();
  private readonly resizeObserver = new ResizeObserver(() =>
    this.scheduleLayout(),
  );
  private readonly observer = new MutationObserver((records) =>
    this.handleMutations(records),
  );
  private activeImage: HTMLImageElement | undefined;
  private hideTimer: number | undefined;
  private layoutFrame: number | undefined;
  private destroyed = false;

  constructor(options: ImageTranslationControllerOptions) {
    this.settings = options.settings;
    this.onStatus = options.onStatus
      ? (status) => options.onStatus?.(status)
      : () => undefined;
    // Reloading an unpacked extension destroys the previous isolated world but
    // does not reliably remove DOM hosts it injected into an already-open page.
    // Remove those inert hosts before mounting the new controller so stale
    // progress text cannot overlap the current image controls.
    document
      .querySelectorAll(
        "norixor-image-translation-control, norixor-image-translation-overlay",
      )
      .forEach((host) => host.remove());
    this.controlHost.dataset.norixortransUi = "image-translation-control";
    this.controlHost.hidden = true;
    const root = this.controlHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CONTROL_STYLE;
    const bar = document.createElement("div");
    bar.className = "bar";
    this.translateButton.type = "button";
    this.translateButton.className = "icon primary";
    this.translateButton.setAttribute(
      "aria-label",
      message("imageTranslateAction"),
    );
    this.translateButton.title = message("imageTranslateAction");
    this.translateButton.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6 16 4-4 3 3 2-2 3 3M8 8h4M10 6v4"/></svg>';
    this.clearButton.type = "button";
    this.clearButton.textContent = message("imageClearAction");
    this.clearButton.hidden = true;
    bar.append(this.clearButton, this.translateButton);
    root.append(style, bar);
    document.documentElement.append(this.controlHost);

    this.translateButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.startCurrent();
    });
    this.clearButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.cancelOrClearCurrent();
    });
    this.controlHost.addEventListener("pointerenter", () => this.cancelHide());
    this.controlHost.addEventListener("pointerdown", () => this.cancelHide());
    this.controlHost.addEventListener("pointerleave", () =>
      this.scheduleHide(),
    );
    document.addEventListener("pointerover", this.handlePointerOver, true);
    document.addEventListener("pointerout", this.handlePointerOut, true);
    document.addEventListener("focusin", this.handleFocusIn, true);
    document.addEventListener("keydown", this.handleImageKeydown, true);
    window.addEventListener("scroll", this.scheduleLayout, true);
    window.addEventListener("resize", this.scheduleLayout);
    window.visualViewport?.addEventListener("resize", this.scheduleLayout);
    window.visualViewport?.addEventListener("scroll", this.scheduleLayout);
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    document.addEventListener("load", this.handleImageLoad, true);
    if (this.settings.imageTranslation.enabled) this.scan(document);
    this.emit({
      state: this.settings.imageTranslation.enabled ? "idle" : "disabled",
      total: 0,
      completed: 0,
      hasCurrentImage: false,
    });
  }

  getStatus(): ImageTranslationStatus {
    const record = this.activeImage
      ? this.records.get(this.activeImage)
      : undefined;
    return (
      record?.status ?? {
        state: this.settings.imageTranslation.enabled ? "idle" : "disabled",
        total: 0,
        completed: 0,
        hasCurrentImage: this.activeImage !== undefined,
      }
    );
  }

  updateSettings(settings: ContentSettings): void {
    const previous = this.settings.imageTranslation;
    const previousProvider = this.settings.provider;
    this.settings = settings;
    const next = settings.imageTranslation;
    if (!next.enabled) {
      this.clearAll("disabled");
      this.activeImage = undefined;
      this.cancelHide();
      this.controlHost.hidden = true;
      this.controlHost.style.removeProperty("left");
      this.controlHost.style.removeProperty("top");
      this.controlHost.style.removeProperty("right");
      this.controlHost.style.removeProperty("bottom");
      for (const image of this.preparedImages) this.restoreImageFocus(image);
      this.preparedImages.clear();
    } else if (!previous.enabled) {
      this.scan(document);
      this.emit({
        state: "idle",
        total: 0,
        completed: 0,
        hasCurrentImage: false,
      });
    } else if (
      previous.sourceLanguage !== next.sourceLanguage ||
      previous.targetLanguage !== next.targetLanguage ||
      previous.mode !== next.mode ||
      previous.modelOverride !== next.modelOverride ||
      previous.displayMode !== next.displayMode ||
      previousProvider.fastProvider !== settings.provider.fastProvider ||
      previousProvider.baseUrl !== settings.provider.baseUrl ||
      previousProvider.microsoftRegion !== settings.provider.microsoftRegion ||
      previousProvider.deeplPlan !== settings.provider.deeplPlan
    ) {
      this.clearAll("cancelled");
    }
  }

  refreshLocale(): void {
    this.translateButton.setAttribute(
      "aria-label",
      message("imageTranslateAction"),
    );
    this.translateButton.title = message("imageTranslateAction");
    this.clearButton.textContent = message(
      this.activeImage &&
        this.records.get(this.activeImage)?.status.state === "translating"
        ? "imageCancelAction"
        : "imageClearAction",
    );
  }

  async startCurrent(): Promise<ImageTranslationStatus> {
    if (!this.settings.imageTranslation.enabled) {
      return this.emit({
        state: "disabled",
        total: 0,
        completed: 0,
        hasCurrentImage: false,
      });
    }
    const image = this.activeImage ?? this.largestVisibleImage();
    if (!image || !visibleImageRect(image)) {
      return this.emit({
        state: "unavailable",
        total: 0,
        completed: 0,
        message: message("imageStatusNoVisibleImage"),
        hasCurrentImage: false,
      });
    }
    this.activate(image);
    const existing = this.records.get(image);
    if (existing?.controller) return existing.status;
    if (
      [...this.records.values()].filter((record) => record.controller).length >=
      MAX_CONCURRENT_IMAGES
    ) {
      return this.setImageStatus(image, {
        state: "error",
        total: 0,
        completed: 0,
        message: message("imageStatusTooManyTasks"),
        hasCurrentImage: true,
      });
    }
    const record = existing ?? this.createRecord(image);
    record.overlay.hidden = true;
    record.root.querySelector(".boxes")?.replaceChildren();
    const controller = new AbortController();
    record.controller = controller;
    this.setImageStatus(image, {
      state: "capturing",
      total: 0,
      completed: 0,
      message: message("imageStatusCapturing"),
      hasCurrentImage: true,
    });
    try {
      const imageDataUrl = await readImageSource(image, controller.signal);
      const crop = await prepareImageSource(
        image,
        imageDataUrl,
        controller.signal,
      );
      this.setImageStatus(image, {
        state: "recognizing",
        total: 0,
        completed: 0,
        message: message("imageStatusRecognizing"),
        hasCurrentImage: true,
      });
      const engine = createLocalOcrEngine();
      let recognition: OcrRecognition;
      try {
        await engine.prepare?.(
          controller.signal,
          undefined,
          this.settings.imageTranslation.sourceLanguage,
        );
        const value = await engine.recognize(crop.canvas, controller.signal);
        recognition = typeof value === "string" ? { text: value } : value;
      } finally {
        crop.canvas.width = 1;
        crop.canvas.height = 1;
        await engine.destroy?.();
      }
      if (controller.signal.aborted) throw abortError();
      const boxes = mergeTextBoxes(recognition.boxes ?? []);
      if (boxes.length === 0) throw new Error("image_no_text");
      const segments = await this.createSegments(image, crop, boxes);
      record.boxes = segments;
      this.setImageStatus(image, {
        state: "translating",
        total: segments.length,
        completed: 0,
        message: message("imageStatusTranslating"),
        hasCurrentImage: true,
      });
      const results = await this.translateSegments(
        segments,
        controller.signal,
        (completed) => {
          this.setImageStatus(image, {
            state: "translating",
            total: segments.length,
            completed,
            message: message("imageStatusTranslating"),
            hasCurrentImage: true,
          });
        },
      );
      if (controller.signal.aborted || !image.isConnected) throw abortError();
      this.render(record, results);
      const ready = this.setImageStatus(image, {
        state: "ready",
        total: segments.length,
        completed: segments.length,
        hasCurrentImage: true,
      });
      this.scheduleHide();
      return ready;
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return this.setImageStatus(image, {
          state: "cancelled",
          total: record.boxes.length,
          completed: 0,
          message: message("imageStatusCancelled"),
          hasCurrentImage: true,
        });
      }
      const detail =
        error instanceof Error
          ? error.message.slice(0, 240)
          : "image_translation_failed";
      const errorCode = error instanceof NTransError ? error.code : detail;
      return this.setImageStatus(image, {
        state:
          detail.startsWith("image_source_") ||
          /ocr_runtime_missing/u.test(detail) ||
          errorCode === "provider_unavailable"
            ? "unavailable"
            : "error",
        total: record.boxes.length,
        completed: 0,
        message: this.errorMessage(errorCode),
        details: `${errorCode}: ${detail}`.slice(0, 240),
        hasCurrentImage: true,
      });
    } finally {
      if (record.controller === controller) record.controller = undefined;
      this.syncControl();
    }
  }

  cancelOrClearCurrent(): void {
    const image = this.activeImage;
    if (!image) return;
    const record = this.records.get(image);
    if (!record) return;
    if (record.controller) {
      record.controller.abort();
      return;
    }
    this.removeRecord(record);
    this.emit({
      state: "available",
      total: 0,
      completed: 0,
      hasCurrentImage: true,
    });
    this.syncControl();
  }

  clearForNavigation(): void {
    this.clearAll("cancelled");
    this.activeImage = undefined;
    this.controlHost.hidden = true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearAll("cancelled");
    this.observer.disconnect();
    this.resizeObserver.disconnect();
    for (const image of this.preparedImages) this.restoreImageFocus(image);
    this.preparedImages.clear();
    document.removeEventListener("pointerover", this.handlePointerOver, true);
    document.removeEventListener("pointerout", this.handlePointerOut, true);
    document.removeEventListener("focusin", this.handleFocusIn, true);
    document.removeEventListener("keydown", this.handleImageKeydown, true);
    document.removeEventListener("load", this.handleImageLoad, true);
    window.removeEventListener("scroll", this.scheduleLayout, true);
    window.removeEventListener("resize", this.scheduleLayout);
    window.visualViewport?.removeEventListener("resize", this.scheduleLayout);
    window.visualViewport?.removeEventListener("scroll", this.scheduleLayout);
    if (this.layoutFrame !== undefined) cancelAnimationFrame(this.layoutFrame);
    if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer);
    this.controlHost.remove();
  }

  private async createSegments(
    image: HTMLImageElement,
    crop: CropResult,
    boxes: readonly OcrTextBox[],
  ): Promise<SpatialSegment[]> {
    return Promise.all(
      boxes.map(async (box, index) => {
        const identity = `${box.text}\u001f${Math.round(box.x)}\u001f${Math.round(box.y)}\u001f${index}`;
        const id = `image-${(await sha256(identity)).slice(0, 32)}`;
        return {
          id,
          text: box.text,
          box: {
            x:
              (crop.sourceRect.x -
                crop.imageRect.x +
                (box.x / crop.canvasWidth) * crop.sourceRect.width) /
              crop.imageRect.width,
            y:
              (crop.sourceRect.y -
                crop.imageRect.y +
                (box.y / crop.canvasHeight) * crop.sourceRect.height) /
              crop.imageRect.height,
            width:
              ((box.width / crop.canvasWidth) * crop.sourceRect.width) /
              crop.imageRect.width,
            height:
              ((box.height / crop.canvasHeight) * crop.sourceRect.height) /
              crop.imageRect.height,
          },
          ...(index > 0
            ? { contextBefore: [boxes[index - 1]?.text ?? ""] }
            : {}),
          ...(index + 1 < boxes.length
            ? { contextAfter: [boxes[index + 1]?.text ?? ""] }
            : {}),
        };
      }),
    );
  }

  private async translateSegments(
    segments: SpatialSegment[],
    signal: AbortSignal,
    onCompleted: (completed: number) => void,
  ): Promise<TranslationResult[]> {
    const imageSettings = this.settings.imageTranslation;
    const request: TranslationRequest = {
      sourceLanguage: imageTranslationSourceLanguage(
        imageSettings.sourceLanguage,
        segments,
      ),
      targetLanguage: imageSettings.targetLanguage,
      mode: imageSettings.mode,
      responseMode: "batch",
      segments,
      ...(document.title.trim()
        ? { mediaTitle: document.title.slice(0, 300) }
        : {}),
      scope: `image:${location.origin}${location.pathname}`.slice(0, 4_096),
      ...(imageSettings.mode === "ai" && imageSettings.modelOverride
        ? { modelOverride: imageSettings.modelOverride }
        : {}),
    };
    if (
      imageSettings.mode === "fast" &&
      this.settings.provider.fastProvider === "chrome-local"
    ) {
      return this.translateLocally(request, signal, onCompleted);
    }
    const requestId = runtimeId("image-translation");
    let completed = 0;
    const seen = new Set<string>();
    const unsubscribe = subscribeTranslationProgress(requestId, (result) => {
      if (!seen.has(result.id)) {
        seen.add(result.id);
        completed += 1;
        onCompleted(completed);
      }
    });
    const cancel = (): void => {
      void browser.runtime.sendMessage({ type: "TRANSLATE_CANCEL", requestId });
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "TRANSLATE",
        requestId,
        request,
      });
      if (
        !isTranslationResponse(response) ||
        !response.ok ||
        !response.results
      ) {
        throw new Error(
          isTranslationResponse(response)
            ? (response.error?.code ?? "image_translation_failed")
            : "image_translation_failed",
        );
      }
      onCompleted(response.results.length);
      return response.results;
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", cancel);
    }
  }

  private async translateLocally(
    request: TranslationRequest,
    signal: AbortSignal,
    onCompleted: (completed: number) => void,
  ): Promise<TranslationResult[]> {
    const cacheKeys = await Promise.all(
      request.segments.map((segment) =>
        translationCacheKey({
          providerId: "chrome-local",
          model: "chrome-local",
          promptVersion: promptVersion("image-local"),
          sourceLanguage: request.sourceLanguage,
          targetLanguage: request.targetLanguage,
          mode: "fast",
          text: segment.text,
          ...(request.scope ? { scope: request.scope } : {}),
        }),
      ),
    );
    const cached = await Promise.all(
      cacheKeys.map((key) => getSharedCachedTranslation(key)),
    );
    const results = new Map<string, TranslationResult>();
    let completed = 0;
    const missing: TranslationSegment[] = [];
    request.segments.forEach((segment, index) => {
      const translatedText = cached[index];
      if (translatedText) {
        results.set(segment.id, { id: segment.id, translatedText });
        completed += 1;
      } else {
        missing.push(segment);
      }
    });
    onCompleted(completed);
    if (missing.length > 0) {
      const provider = new ChromeLocalProvider({
        keepAliveForTask: true,
        dynamicSourceLanguage: true,
      });
      try {
        const translated = await scheduleTranslation(
          provider,
          { ...request, segments: missing },
          signal,
          async (result) => {
            if (results.has(result.id)) return;
            results.set(result.id, result);
            const index = request.segments.findIndex(
              (segment) => segment.id === result.id,
            );
            if (index >= 0)
              await setSharedCachedTranslation(
                cacheKeys[index]!,
                result.translatedText,
              );
            completed += 1;
            onCompleted(completed);
          },
        );
        for (const result of translated) results.set(result.id, result);
      } finally {
        await provider.dispose();
      }
    }
    return request.segments.map((segment) => {
      const result = results.get(segment.id);
      if (!result) throw new Error("invalid_response");
      return result;
    });
  }

  private render(
    record: ImageRecord,
    results: readonly TranslationResult[],
  ): void {
    const byId = new Map(
      results.map((result) => [result.id, result.translatedText]),
    );
    const boxes = record.root.querySelector<HTMLElement>(".boxes");
    if (!boxes) return;
    boxes.replaceChildren();
    for (const segment of record.boxes) {
      const translated = byId.get(segment.id);
      if (!translated) continue;
      const box = document.createElement("div");
      box.className = "box";
      box.dataset.segmentId = segment.id;
      if (this.settings.imageTranslation.displayMode === "bilingual") {
        const original = document.createElement("span");
        original.className = "original";
        original.textContent = segment.text;
        box.append(original);
      }
      box.append(document.createTextNode(translated));
      boxes.append(box);
    }
    record.overlay.hidden = false;
    this.layoutRecord(record);
  }

  private createRecord(image: HTMLImageElement): ImageRecord {
    const overlay = document.createElement("norixor-image-translation-overlay");
    overlay.dataset.norixortransUi = "image-translation-overlay";
    overlay.hidden = true;
    const root = overlay.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = OVERLAY_STYLE;
    const boxes = document.createElement("div");
    boxes.className = "boxes";
    root.append(style, boxes);
    document.documentElement.append(overlay);
    const record: ImageRecord = {
      image,
      overlay,
      root,
      boxes: [],
      controller: undefined,
      status: {
        state: "available",
        total: 0,
        completed: 0,
        hasCurrentImage: true,
      },
    };
    this.records.set(image, record);
    return record;
  }

  private setImageStatus(
    image: HTMLImageElement,
    status: ImageTranslationStatus,
  ): ImageTranslationStatus {
    const record = this.records.get(image) ?? this.createRecord(image);
    record.status = status;
    if (this.activeImage === image) {
      this.emit(status);
      this.syncControl();
    }
    return status;
  }

  private emit(status: ImageTranslationStatus): ImageTranslationStatus {
    this.onStatus(status);
    return status;
  }

  private errorMessage(detail: string): string {
    if (detail === "image_source_too_large" || detail === "capture_too_large")
      return message("imageStatusSourceTooLarge");
    if (detail.startsWith("image_source_"))
      return message("imageStatusSourceUnavailable");
    if (detail === "image_not_visible")
      return message("imageStatusNoVisibleImage");
    if (detail === "image_black_frame") return message("imageStatusBlackFrame");
    if (/ocr_runtime_missing/u.test(detail))
      return message("imageStatusRuntimeMissing");
    if (detail === "image_no_text") return message("imageStatusNoText");
    if (detail === "provider_unavailable")
      return message("imageStatusProviderUnavailable");
    if (detail === "invalid_response")
      return message("imageStatusInvalidResponse");
    if (detail === "request_failed") return message("imageStatusRequestFailed");
    return message("imageStatusError");
  }

  private removeRecord(record: ImageRecord): void {
    record.controller?.abort();
    record.overlay.remove();
    this.records.delete(record.image);
  }

  private clearAll(state: "disabled" | "cancelled"): void {
    for (const record of [...this.records.values()]) this.removeRecord(record);
    this.emit({ state, total: 0, completed: 0, hasCurrentImage: false });
  }

  private scan(root: ParentNode): void {
    if (root instanceof HTMLImageElement) this.prepareImage(root);
    for (const image of root.querySelectorAll?.("img") ?? []) {
      if (image instanceof HTMLImageElement) this.prepareImage(image);
    }
  }

  private prepareImage(image: HTMLImageElement): void {
    if (
      !this.settings.imageTranslation.enabled ||
      this.preparedImages.has(image) ||
      !eligibleImage(image)
    ) {
      return;
    }
    this.preparedImages.add(image);
    this.resizeObserver.observe(image);
    const focusableAncestor = image.closest(
      "a[href],button,[tabindex],input,select,textarea",
    );
    if (!focusableAncestor && image.tabIndex < 0) {
      this.originalTabIndexes.set(image, image.tabIndex);
      image.tabIndex = 0;
      image.dataset.norixortransImageFocusable = "true";
    }
  }

  private restoreImageFocus(image: HTMLImageElement): void {
    this.resizeObserver.unobserve(image);
    if (image.dataset.norixortransImageFocusable === "true") {
      const value = this.originalTabIndexes.get(image) ?? -1;
      image.tabIndex = value;
      delete image.dataset.norixortransImageFocusable;
    }
  }

  private handleMutations(records: readonly MutationRecord[]): void {
    for (const mutation of records) {
      for (const node of mutation.addedNodes) {
        if (
          this.settings.imageTranslation.enabled &&
          node instanceof Element &&
          !node.closest("[data-norixortrans-ui]")
        ) {
          this.scan(node);
        }
      }
      for (const node of mutation.removedNodes) {
        if (!(node instanceof Element)) continue;
        const images = [
          ...(node instanceof HTMLImageElement ? [node] : []),
          ...node.querySelectorAll<HTMLImageElement>("img"),
        ];
        for (const image of images) {
          const record = this.records.get(image);
          if (record) this.removeRecord(record);
          this.restoreImageFocus(image);
          this.preparedImages.delete(image);
          if (this.activeImage === image) this.activeImage = undefined;
        }
      }
    }
  }

  private readonly handleImageLoad = (event: Event): void => {
    if (
      this.settings.imageTranslation.enabled &&
      event.target instanceof HTMLImageElement
    ) {
      this.prepareImage(event.target);
    }
  };

  private readonly handlePointerOver = (event: PointerEvent): void => {
    if (!this.settings.imageTranslation.enabled) return;
    const image = event
      .composedPath()
      .find((node) => node instanceof HTMLImageElement);
    if (image instanceof HTMLImageElement && visibleImageRect(image)) {
      this.prepareImage(image);
      this.activate(image);
    }
  };

  private readonly handlePointerOut = (event: PointerEvent): void => {
    if (!event.composedPath().includes(this.activeImage as EventTarget)) return;
    const next = event.relatedTarget;
    if (
      next instanceof Node &&
      (this.activeImage?.contains(next) || this.controlHost.contains(next))
    ) {
      return;
    }
    this.scheduleHide();
  };

  private readonly handleFocusIn = (event: FocusEvent): void => {
    if (
      !this.settings.imageTranslation.enabled ||
      !(event.target instanceof Element)
    )
      return;
    const image =
      event.target instanceof HTMLImageElement
        ? event.target
        : event.target.querySelector<HTMLImageElement>("img");
    if (image && visibleImageRect(image)) this.activate(image);
  };

  private readonly handleImageKeydown = (event: KeyboardEvent): void => {
    if (
      !this.settings.imageTranslation.enabled ||
      (event.key !== "Enter" && event.key !== " ") ||
      !(event.target instanceof HTMLImageElement) ||
      event.target.dataset.norixortransImageFocusable !== "true"
    ) {
      return;
    }
    event.preventDefault();
    this.activate(event.target);
    void this.startCurrent();
  };

  private activate(image: HTMLImageElement): void {
    this.cancelHide();
    this.activeImage = image;
    this.controlHost.hidden = false;
    // Place the control synchronously. Waiting for the next animation frame
    // leaves a newly revealed fixed host at its default (0, 0), which can also
    // make the short hover hand-off expire before the user reaches the button.
    this.positionControl(image);
    const record = this.records.get(image);
    const status = record?.status ?? {
      state: "available" as const,
      total: 0,
      completed: 0,
      hasCurrentImage: true,
    };
    this.emit(status);
    this.syncControl();
    this.scheduleLayout();
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => {
      if (this.controlHost.matches(":focus-within")) return;
      this.controlHost.hidden = true;
    }, CONTROL_HIDE_DELAY_MS);
  }

  private cancelHide(): void {
    if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  }

  private readonly scheduleLayout = (): void => {
    if (this.layoutFrame !== undefined) return;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      this.layout();
    });
  };

  private layout(): void {
    const image = this.activeImage;
    const rect = image ? visibleImageRect(image) : null;
    if (!image || !rect) {
      this.controlHost.hidden = true;
    } else {
      this.positionControl(image, rect);
    }
    for (const record of [...this.records.values()]) {
      if (!record.image.isConnected) this.removeRecord(record);
      else this.layoutRecord(record);
    }
  }

  private positionControl(
    image: HTMLImageElement,
    rect = visibleImageRect(image),
  ): void {
    if (!rect) return;
    const controlRect = this.controlHost.getBoundingClientRect();
    const controlWidth = Math.max(44, controlRect.width);
    const controlHeight = Math.max(44, controlRect.height);
    const left = Math.min(
      window.innerWidth - controlWidth - 8,
      Math.max(8, rect.right - controlWidth - 8),
    );
    const top = Math.min(
      window.innerHeight - controlHeight - 8,
      Math.max(8, rect.top + 8),
    );
    this.controlHost.style.setProperty("left", `${left}px`, "important");
    this.controlHost.style.setProperty("top", `${top}px`, "important");
    this.controlHost.style.setProperty("right", "auto", "important");
    this.controlHost.style.setProperty("bottom", "auto", "important");
  }

  private layoutRecord(record: ImageRecord): void {
    if (record.overlay.hidden) return;
    const rect = visibleImageRect(record.image);
    if (!rect) {
      record.overlay.hidden = true;
      return;
    }
    record.overlay.hidden = false;
    const elements = record.root.querySelectorAll<HTMLElement>(".box");
    elements.forEach((element) => {
      const segment = record.boxes.find(
        (item) => item.id === element.dataset.segmentId,
      );
      if (!segment) return;
      const detectedLeft = rect.left + segment.box.x * rect.width;
      const top = rect.top + segment.box.y * rect.height;
      const detectedWidth = Math.max(18, segment.box.width * rect.width);
      const height = Math.max(16, segment.box.height * rect.height);
      const visibleLeft = Math.max(rect.left, detectedLeft);
      const visibleRight = Math.min(rect.right, detectedLeft + detectedWidth);
      const visibleTop = Math.max(rect.top, top);
      const visibleBottom = Math.min(rect.bottom, top + height);
      if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
        element.hidden = true;
        return;
      }
      const visibleWidth = visibleRight - visibleLeft;
      const boxWidth = Math.min(
        Math.max(40, visibleWidth + 16),
        Math.max(40, rect.width * 0.92),
        Math.max(40, window.innerWidth - 16),
      );
      const detectedCenter = visibleLeft + visibleWidth / 2;
      const center = Math.min(
        window.innerWidth - boxWidth / 2 - 8,
        Math.max(boxWidth / 2 + 8, detectedCenter),
      );
      element.style.left = `${center}px`;
      element.style.top = `${Math.max(0, visibleTop)}px`;
      element.style.width = `${boxWidth}px`;
      element.style.maxWidth = `${boxWidth}px`;
      element.style.transform = "translateX(-50%)";
      element.style.setProperty(
        "--nt-font-size",
        `${Math.max(11, Math.min(18, height * 0.72))}px`,
      );
      element.hidden =
        visibleLeft >= window.innerWidth ||
        visibleTop >= window.innerHeight ||
        visibleRight <= 0 ||
        visibleBottom <= 0;
    });
  }

  private syncControl(): void {
    const record = this.activeImage
      ? this.records.get(this.activeImage)
      : undefined;
    const running = record?.controller !== undefined;
    this.translateButton.disabled = running;
    this.translateButton.hidden = record?.status.state === "ready";
    this.translateButton.setAttribute(
      "aria-label",
      message(
        record &&
          ["error", "unavailable", "cancelled"].includes(record.status.state)
          ? "imageRetryAction"
          : "imageTranslateAction",
      ),
    );
    this.clearButton.hidden = !record;
    this.clearButton.textContent = message(
      running ? "imageCancelAction" : "imageClearAction",
    );
  }

  private largestVisibleImage(): HTMLImageElement | undefined {
    return [...this.preparedImages]
      .map((image) => ({ image, rect: visibleImageRect(image) }))
      .filter(
        (item): item is { image: HTMLImageElement; rect: DOMRect } =>
          item.rect !== null,
      )
      .sort(
        (left, right) =>
          right.rect.width * right.rect.height -
          left.rect.width * left.rect.height,
      )[0]?.image;
  }
}
