import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type {
  LocalTranslationRuntimeInfo,
  OcrRuntimeInfo,
} from "@/src/messaging/protocol";
import {
  createLocalOcrEngine,
  ocrRecognitionText,
  type LocalOcrEngine,
} from "@/src/ocr/engine";
import {
  isOcrSourceLanguageSupported,
  type OcrRuntimeLanguage,
} from "@/src/ocr/languages";
import {
  getOcrRuntimeLanguage,
  getOcrRuntimePack,
  isOcrRuntimeLanguageCode,
} from "@/src/ocr/runtime-catalog";
import { currentUiLocale, message } from "@/src/shared/i18n";
import { displayLanguageName } from "@/src/shared/languages";
import type { SectionContext } from "./common";

/**
 * Optional download hosts. They are requested only inside the click that
 * starts a download; the background still pins the exact files and verifies
 * their size and SHA-256 before anything is stored.
 */
export const OCR_RUNTIME_ORIGINS: readonly string[] = [
  "https://media.githubusercontent.com/*",
  "https://raw.githubusercontent.com/*",
];
export const LOCAL_TRANSLATION_RUNTIME_ORIGINS: readonly string[] = [
  "https://storage.googleapis.com/*",
];

const OCR_POLL_MS = 750;
const LOCAL_ACTIVE_POLL_MS = 200;
const LOCAL_IDLE_POLL_MS = 750;

export interface RuntimeConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}

export interface RuntimeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RuntimePanelsDeps {
  sendMessage(message: unknown): Promise<unknown>;
  /** Must call `permissions.request` synchronously (user gesture). */
  requestOrigins(origins: string[]): Promise<boolean>;
  confirm(request: RuntimeConfirmRequest): Promise<boolean>;
  requestRender(): void;
  /** Called whenever the known OCR pack states change after the first load. */
  onOcrRuntimes(runtimes: readonly OcrRuntimeInfo[]): void;
  /** Called after every successful local translation pack list load. */
  onLocalTranslationRuntimes(runtimes: LocalTranslationRuntimeInfo[]): void;
  timers?: RuntimeTimers;
  createOcrEngine?: () => LocalOcrEngine;
  /** Draws the self-test sample; injectable because jsdom has no 2D canvas. */
  createSelfTestSample?: (sourceLanguage: string) => HTMLCanvasElement;
}

type Tone = "" | "success" | "error";

interface PanelFeedback {
  key: string;
  subs?: string[];
  tone: Tone;
  /** Sanitized diagnostic text, shown collapsed. */
  detail?: string;
}

interface LocalTranslationRuntimePair {
  language: string;
  runtimes: LocalTranslationRuntimeInfo[];
  state: LocalTranslationRuntimeInfo["state"];
  bytes: number;
  version?: string;
}

function isSuccessfulResponse(value: unknown): value is { ok: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
}

function isOcrRuntimeStatus(value: unknown): value is OcrRuntimeInfo {
  if (typeof value !== "object" || value === null) return false;
  const runtime = value as Record<string, unknown>;
  return (
    (runtime.pack === "zh" ||
      runtime.pack === "latin" ||
      runtime.pack === "korean") &&
    typeof runtime.labelKey === "string" &&
    Array.isArray(runtime.languages) &&
    runtime.languages.every(isOcrRuntimeLanguageCode) &&
    (runtime.state === "missing" ||
      runtime.state === "downloading" ||
      runtime.state === "installed" ||
      runtime.state === "error") &&
    (runtime.progress === undefined || typeof runtime.progress === "number") &&
    (runtime.bytes === undefined || typeof runtime.bytes === "number") &&
    (runtime.message === undefined || typeof runtime.message === "string")
  );
}

function isOcrRuntimeListResponse(
  value: unknown,
): value is { ok: true; runtimes: OcrRuntimeInfo[] } {
  return (
    isSuccessfulResponse(value) &&
    "runtimes" in value &&
    Array.isArray(value.runtimes) &&
    value.runtimes.every(isOcrRuntimeStatus)
  );
}

function isLocalTranslationRuntimeStatus(
  value: unknown,
): value is LocalTranslationRuntimeInfo {
  if (typeof value !== "object" || value === null) return false;
  const runtime = value as Record<string, unknown>;
  return (
    typeof runtime.packId === "string" &&
    typeof runtime.sourceLanguage === "string" &&
    typeof runtime.targetLanguage === "string" &&
    (runtime.state === "missing" ||
      runtime.state === "downloading" ||
      runtime.state === "installed" ||
      runtime.state === "error") &&
    (runtime.version === undefined || typeof runtime.version === "string") &&
    (runtime.bytes === undefined || typeof runtime.bytes === "number") &&
    (runtime.downloadBytes === undefined ||
      (typeof runtime.downloadBytes === "number" &&
        Number.isSafeInteger(runtime.downloadBytes) &&
        runtime.downloadBytes > 0)) &&
    (runtime.message === undefined || typeof runtime.message === "string")
  );
}

function isLocalTranslationRuntimeListResponse(
  value: unknown,
): value is { ok: true; runtimes: LocalTranslationRuntimeInfo[] } {
  return (
    isSuccessfulResponse(value) &&
    "runtimes" in value &&
    Array.isArray(value.runtimes) &&
    value.runtimes.every(isLocalTranslationRuntimeStatus)
  );
}

/** Maps a background failure code to its user-facing message key. */
export function localTranslationRuntimeFailureKey(value: unknown): string {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return "localTranslationRuntimeDownloadFailed";
  }
  switch (value.error) {
    case "bergamot_catalog_unavailable":
      return "localTranslationRuntimeCatalogUnavailable";
    case "bergamot_catalog_invalid":
      return "localTranslationRuntimeCatalogInvalid";
    case "bergamot_unsupported_language":
      return "localTranslationRuntimeUnsupported";
    case "bergamot_integrity_failed":
      return "optRtLocalIntegrityFailed";
    case "bergamot_cancelled":
      return "localTranslationRuntimeCancelled";
    default:
      return "localTranslationRuntimeStorageFailed";
  }
}

export function formatRuntimeSize(bytes: number): string {
  const locale = currentUiLocale();
  if (bytes < 1024) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "byte",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(bytes);
  }
  if (bytes < 1024 * 1024) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "kilobyte",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(bytes / 1024);
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "megabyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(bytes / (1024 * 1024));
}

/** Download progress in whole percent; the background may report 0–1 or 0–100. */
export function runtimeProgressPercent(runtime: OcrRuntimeInfo): number {
  const progress = runtime.progress ?? 0;
  return Math.round(
    Math.min(100, Math.max(0, progress <= 1 ? progress * 100 : progress)),
  );
}

function runtimePackageLabel(runtime: OcrRuntimeInfo): string {
  return message(runtime.labelKey) || runtime.pack;
}

const OCR_LANGUAGE_DISPLAY_CODES: Record<string, string> = {
  eng: "en",
  chi_sim: "zh-CN",
  chi_tra: "zh-TW",
  jpn: "ja",
  kor: "ko",
  spa: "es",
  fra: "fr",
  deu: "de",
};

function runtimeLanguageLabel(language: OcrRuntimeLanguage): string {
  const localized = message(getOcrRuntimeLanguage(language).labelKey);
  if (localized) return localized;
  const code = OCR_LANGUAGE_DISPLAY_CODES[language];
  return code ? displayLanguageName(code, currentUiLocale()) : language;
}

function runtimeLanguagesLabel(runtime: OcrRuntimeInfo): string {
  return new Intl.ListFormat(currentUiLocale(), {
    style: "long",
    type: "conjunction",
  }).format(runtime.languages.map(runtimeLanguageLabel));
}

function localTranslationLanguageLabel(language: string): string {
  if (language === "zh-Hant") return message("localTranslationLanguageTaiwan");
  return displayLanguageName(
    language === "zh-Hans" ? "zh-CN" : language,
    currentUiLocale(),
  );
}

function pairLabel(pair: LocalTranslationRuntimePair): string {
  return message("localTranslationPairValue", [
    localTranslationLanguageLabel(pair.language),
    localTranslationLanguageLabel("en"),
  ]);
}

/** Groups directional packs into one English pair per language. */
export function localTranslationRuntimePairs(
  runtimes: readonly LocalTranslationRuntimeInfo[],
): LocalTranslationRuntimePair[] {
  const grouped = new Map<string, LocalTranslationRuntimeInfo[]>();
  for (const runtime of runtimes) {
    const language =
      runtime.sourceLanguage === "en"
        ? runtime.targetLanguage
        : runtime.sourceLanguage;
    const list = grouped.get(language) ?? [];
    list.push(runtime);
    grouped.set(language, list);
  }
  return [...grouped].map(([language, list]) => {
    const versions = [
      ...new Set(
        list.flatMap((runtime) => (runtime.version ? [runtime.version] : [])),
      ),
    ];
    const state = list.some((runtime) => runtime.state === "downloading")
      ? "downloading"
      : list.length === 2 &&
          list.every((runtime) => runtime.state === "installed")
        ? "installed"
        : list.some((runtime) => runtime.state === "error")
          ? "error"
          : "missing";
    return {
      language,
      runtimes: list,
      state,
      bytes: list.reduce((total, runtime) => total + (runtime.bytes ?? 0), 0),
      ...(versions.length === 1 ? { version: versions[0] } : {}),
    };
  });
}

/** Draws a short synthetic sample matching the configured source language. */
export function drawOcrSelfTestSample(
  sourceLanguage: string,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 190;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas-unavailable");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111";
  context.font = "700 52px Arial, sans-serif";
  context.textAlign = "center";
  if (sourceLanguage !== "zh-CN") {
    context.fillText("HELLO OCR 123", canvas.width / 2, 72);
  }
  if (sourceLanguage !== "en") {
    context.font = '700 52px "PingFang SC", sans-serif';
    context.fillText("你好", canvas.width / 2, 148);
  }
  return canvas;
}

const defaultTimers: RuntimeTimers = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

function feedbackTemplate(
  value: PanelFeedback | undefined,
  id: string,
): TemplateResult {
  return html`<p
    class="feedback"
    id=${id}
    data-tone=${value?.tone ?? ""}
    role="status"
    aria-live="polite"
  >
    ${value ? message(value.key, value.subs) : ""}
  </p>`;
}

/**
 * Owns the OCR ("image recognition") and offline translation language pack
 * panels: list loading, user-initiated downloads and deletes, progress
 * polling and the recognition self-test. Packs are never downloaded unless the
 * user clicks a download button here; the background enforces the pinned
 * sources and integrity checks.
 */
export class RuntimePanels {
  private readonly timers: RuntimeTimers;
  private disposed = false;

  private ocrRuntimes: OcrRuntimeInfo[] = [];
  private ocrLoaded = false;
  private ocrLoading = false;
  private ocrPending = false;
  /** True while the pending OCR command is "download all". */
  private ocrAllPending = false;
  private ocrListRequest: Promise<void> | undefined;
  private ocrPollTimer: unknown;
  private ocrFeedback: PanelFeedback | undefined;

  private localRuntimes: LocalTranslationRuntimeInfo[] = [];
  private localLoaded = false;
  private localLoading = false;
  private localPending = false;
  private localListRequest: Promise<void> | undefined;
  private localPollTimer: unknown;
  private localFeedback: PanelFeedback | undefined;
  private localProgress:
    | {
        packIds: Set<LocalTranslationRuntimeInfo["packId"]>;
        completedPackIds: Set<LocalTranslationRuntimeInfo["packId"]>;
      }
    | undefined;

  private selfTestBusy = false;
  private selfTestAbort: AbortController | undefined;
  private selfTestFeedback: PanelFeedback | undefined;

  constructor(private readonly deps: RuntimePanelsDeps) {
    this.timers = deps.timers ?? defaultTimers;
  }

  /** Loads both lists once, then keeps polling while a download runs. */
  async start(): Promise<void> {
    await Promise.all([
      this.loadOcr(true).finally(() => this.scheduleOcrPoll()),
      this.loadLocal(true).finally(() => this.scheduleLocalPoll()),
    ]);
  }

  dispose(): void {
    this.disposed = true;
    this.clearOcrPoll();
    this.clearLocalPoll();
    this.selfTestAbort?.abort();
    this.selfTestAbort = undefined;
  }

  private render(): void {
    if (!this.disposed) this.deps.requestRender();
  }

  // OCR language packs ------------------------------------------------------

  private emitOcr(): void {
    if (this.ocrLoaded && !this.disposed)
      this.deps.onOcrRuntimes(this.ocrRuntimes);
  }

  private clearOcrPoll(): void {
    if (this.ocrPollTimer !== undefined) {
      this.timers.clearTimeout(this.ocrPollTimer);
      this.ocrPollTimer = undefined;
    }
  }

  private scheduleOcrPoll(): void {
    this.clearOcrPoll();
    if (this.disposed) return;
    if (!this.ocrRuntimes.some((runtime) => runtime.state === "downloading")) {
      return;
    }
    this.ocrPollTimer = this.timers.setTimeout(() => {
      this.ocrPollTimer = undefined;
      void this.loadOcr(false).finally(() => this.scheduleOcrPoll());
    }, OCR_POLL_MS);
  }

  private loadOcr(showLoading: boolean): Promise<void> {
    if (this.ocrListRequest) return this.ocrListRequest;
    this.ocrListRequest = (async () => {
      if (showLoading) {
        this.ocrLoading = true;
        this.render();
      }
      try {
        const response = await this.deps.sendMessage({
          type: "OCR_RUNTIME_LIST",
        });
        if (this.disposed) return;
        if (!isOcrRuntimeListResponse(response)) {
          throw new Error("ocr-runtime-list-failed");
        }
        this.ocrRuntimes = response.runtimes;
        this.ocrLoaded = true;
        if (this.ocrFeedback?.tone === "error") this.ocrFeedback = undefined;
        this.emitOcr();
      } catch {
        if (this.disposed) return;
        this.ocrFeedback = { key: "ocrRuntimesLoadFailed", tone: "error" };
      } finally {
        this.ocrLoading = false;
        this.render();
      }
    })().finally(() => {
      this.ocrListRequest = undefined;
    });
    return this.ocrListRequest;
  }

  private downloadOcr(
    command:
      | { type: "OCR_RUNTIME_DOWNLOAD"; pack: OcrRuntimeInfo["pack"] }
      | { type: "OCR_RUNTIME_DOWNLOAD_ALL" },
  ): void {
    if (this.ocrPending || this.disposed) return;
    // Requested before any await so Chrome sees the click as the gesture.
    const permission = this.deps.requestOrigins([...OCR_RUNTIME_ORIGINS]);
    this.ocrPending = true;
    this.ocrAllPending = command.type === "OCR_RUNTIME_DOWNLOAD_ALL";
    this.ocrFeedback = undefined;
    this.render();
    void (async () => {
      const granted = await permission.catch(() => false);
      if (this.disposed) return;
      if (!granted) {
        this.ocrPending = false;
        this.ocrAllPending = false;
        this.ocrFeedback = { key: "optRtOcrPermissionDenied", tone: "error" };
        this.render();
        return;
      }
      const targets = (runtime: OcrRuntimeInfo): boolean =>
        command.type === "OCR_RUNTIME_DOWNLOAD"
          ? runtime.pack === command.pack
          : runtime.state === "missing" || runtime.state === "error";
      this.ocrRuntimes = this.ocrRuntimes.map((runtime) =>
        targets(runtime)
          ? { ...runtime, state: "downloading", progress: 0 }
          : runtime,
      );
      this.emitOcr();
      this.render();
      this.scheduleOcrPoll();
      try {
        const response = await this.deps.sendMessage(command);
        if (!isSuccessfulResponse(response)) throw new Error("ocr-download");
        await this.loadOcr(false);
      } catch {
        if (!this.disposed) {
          this.ocrFeedback = {
            key:
              command.type === "OCR_RUNTIME_DOWNLOAD"
                ? "ocrRuntimeDownloadFailed"
                : "ocrRuntimeDownloadAllFailed",
            tone: "error",
          };
        }
      } finally {
        this.ocrPending = false;
        this.ocrAllPending = false;
        this.render();
        this.scheduleOcrPoll();
      }
    })();
  }

  private async deleteOcr(runtime: OcrRuntimeInfo): Promise<void> {
    if (this.ocrPending || this.disposed) return;
    const confirmed = await this.deps.confirm({
      title: message("optRtOcrDeleteTitle"),
      body: message("optRtOcrDeleteBody", runtimePackageLabel(runtime)),
      confirmLabel: message("ocrRuntimeDelete"),
      danger: true,
    });
    if (!confirmed || this.ocrPending || this.disposed) return;
    this.ocrPending = true;
    this.ocrFeedback = undefined;
    this.render();
    try {
      const response = await this.deps.sendMessage({
        type: "OCR_RUNTIME_DELETE",
        pack: runtime.pack,
      });
      if (!isSuccessfulResponse(response)) throw new Error("ocr-delete");
      await this.loadOcr(false);
      if (!this.disposed) {
        this.ocrFeedback = { key: "ocrRuntimeDeleted", tone: "success" };
      }
    } catch {
      if (!this.disposed) {
        this.ocrFeedback = { key: "ocrRuntimeDeleteFailed", tone: "error" };
      }
    } finally {
      this.ocrPending = false;
      this.render();
    }
  }

  // Self-test ---------------------------------------------------------------

  private async runSelfTest(sourceLanguage: string): Promise<void> {
    if (this.selfTestBusy || this.disposed) return;
    this.selfTestBusy = true;
    this.selfTestFeedback = { key: "optRtSelfTestPreparing", tone: "" };
    this.render();
    if (!isOcrSourceLanguageSupported(sourceLanguage)) {
      this.selfTestBusy = false;
      this.selfTestFeedback = {
        key: "optRtSelfTestSourceUnsupported",
        tone: "error",
      };
      this.render();
      return;
    }
    const engine = (this.deps.createOcrEngine ?? createLocalOcrEngine)();
    const controller = new AbortController();
    this.selfTestAbort = controller;
    try {
      await engine.prepare?.(
        controller.signal,
        ({ progress }) => {
          if (controller.signal.aborted) return;
          this.selfTestFeedback = {
            key: "optRtSelfTestLoading",
            subs: [String(Math.round(progress * 100))],
            tone: "",
          };
          this.render();
        },
        sourceLanguage,
      );
      const sample = (this.deps.createSelfTestSample ?? drawOcrSelfTestSample)(
        sourceLanguage,
      );
      const text = ocrRecognitionText(
        await engine.recognize(sample, controller.signal),
      );
      if (!text) throw new Error("ocr-empty-result");
      if (controller.signal.aborted) return;
      this.selfTestFeedback = {
        key: "optRtSelfTestSucceeded",
        subs: [text.replace(/\s+/gu, " ").trim().slice(0, 80)],
        tone: "success",
      };
    } catch (error) {
      if (controller.signal.aborted) return;
      const raw = error instanceof Error ? error.message : "";
      if (/^ocr_runtime_missing(?::|$)/u.test(raw)) {
        this.selfTestFeedback = {
          key: "optRtSelfTestPackMissing",
          tone: "error",
        };
      } else {
        // Keep a bounded, sanitized code for diagnosis without leading with
        // engine internals; the extension ID is not useful to users.
        const detail = raw
          .replace(/chrome-extension:\/\/[^/]+/gu, "extension:")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 240);
        this.selfTestFeedback = {
          key: "optRtSelfTestFailed",
          tone: "error",
          ...(detail ? { detail } : {}),
        };
      }
    } finally {
      if (this.selfTestAbort === controller) this.selfTestAbort = undefined;
      await engine.destroy?.().catch(() => undefined);
      this.selfTestBusy = false;
      this.render();
    }
  }

  // Local translation packs ------------------------------------------------

  private clearLocalPoll(): void {
    if (this.localPollTimer !== undefined) {
      this.timers.clearTimeout(this.localPollTimer);
      this.localPollTimer = undefined;
    }
  }

  private scheduleLocalPoll(): void {
    this.clearLocalPoll();
    if (this.disposed) return;
    const downloading = this.localRuntimes.some(
      (runtime) => runtime.state === "downloading",
    );
    if (!this.localPending && !downloading) return;
    this.localPollTimer = this.timers.setTimeout(
      () => {
        this.localPollTimer = undefined;
        void this.loadLocal(false).finally(() => this.scheduleLocalPoll());
      },
      this.localPending ? LOCAL_ACTIVE_POLL_MS : LOCAL_IDLE_POLL_MS,
    );
  }

  private loadLocal(showLoading: boolean): Promise<void> {
    if (this.localListRequest) return this.localListRequest;
    this.localListRequest = (async () => {
      if (showLoading) {
        this.localLoading = true;
        this.render();
      }
      try {
        const response = await this.deps.sendMessage({
          type: "LOCAL_TRANSLATION_RUNTIME_LIST",
        });
        if (this.disposed) return;
        if (!isLocalTranslationRuntimeListResponse(response)) {
          throw new Error("local-translation-runtime-list-failed");
        }
        this.localRuntimes = response.runtimes;
        this.localLoaded = true;
        if (this.localFeedback?.key === "localTranslationRuntimesLoadFailed") {
          this.localFeedback = undefined;
        }
        this.deps.onLocalTranslationRuntimes(this.localRuntimes);
      } catch {
        if (this.disposed) return;
        this.localFeedback = {
          key: "localTranslationRuntimesLoadFailed",
          tone: "error",
        };
      } finally {
        this.localLoading = false;
        this.render();
      }
    })().finally(() => {
      this.localListRequest = undefined;
    });
    return this.localListRequest;
  }

  private downloadLocal(pair: LocalTranslationRuntimePair): void {
    if (this.localPending || this.disposed) return;
    // Requested before any await so Chrome sees the click as the gesture.
    const permission = this.deps.requestOrigins([
      ...LOCAL_TRANSLATION_RUNTIME_ORIGINS,
    ]);
    this.localPending = true;
    this.localFeedback = undefined;
    this.render();
    void (async () => {
      const granted = await permission.catch(() => false);
      if (this.disposed) return;
      if (!granted) {
        this.localPending = false;
        this.localFeedback = {
          key: "optRtLocalPermissionDenied",
          tone: "error",
        };
        this.render();
        return;
      }
      const packIds = new Set(
        pair.runtimes
          .filter((runtime) => runtime.state !== "installed")
          .map((runtime) => runtime.packId),
      );
      this.localProgress = { packIds, completedPackIds: new Set() };
      this.localRuntimes = this.localRuntimes.map((runtime) =>
        packIds.has(runtime.packId)
          ? { ...runtime, state: "downloading" }
          : runtime,
      );
      this.render();
      this.scheduleLocalPoll();
      let failure: unknown;
      try {
        for (const runtime of pair.runtimes) {
          if (!packIds.has(runtime.packId) || this.disposed) continue;
          try {
            const response = await this.deps.sendMessage({
              type: "LOCAL_TRANSLATION_RUNTIME_DOWNLOAD",
              packId: runtime.packId,
            });
            if (isSuccessfulResponse(response)) {
              this.localProgress?.completedPackIds.add(runtime.packId);
              this.render();
            } else if (failure === undefined) {
              failure = response;
            }
          } catch (error) {
            if (failure === undefined) failure = error;
          }
        }
        this.clearLocalPoll();
        await this.loadLocal(false);
        if (failure !== undefined && !this.disposed) {
          this.localFeedback = {
            key: localTranslationRuntimeFailureKey(failure),
            tone: "error",
          };
        }
      } finally {
        this.localPending = false;
        this.localProgress = undefined;
        this.render();
        this.scheduleLocalPoll();
      }
    })();
  }

  private async deleteLocal(pair: LocalTranslationRuntimePair): Promise<void> {
    if (this.localPending || this.disposed) return;
    const confirmed = await this.deps.confirm({
      title: message("optRtLocalDeleteTitle"),
      body: message("optRtLocalDeleteBody", pairLabel(pair)),
      confirmLabel: message("ocrRuntimeDelete"),
      danger: true,
    });
    if (!confirmed || this.localPending || this.disposed) return;
    this.localPending = true;
    this.localFeedback = undefined;
    this.render();
    try {
      for (const runtime of pair.runtimes) {
        const response = await this.deps.sendMessage({
          type: "LOCAL_TRANSLATION_RUNTIME_DELETE",
          packId: runtime.packId,
        });
        if (!isSuccessfulResponse(response)) throw new Error("local-delete");
      }
      await this.loadLocal(false);
      if (!this.disposed) {
        this.localFeedback = {
          key: "localTranslationRuntimeDeleted",
          tone: "success",
        };
      }
    } catch {
      if (!this.disposed) {
        this.localFeedback = {
          key: "localTranslationRuntimeDeleteFailed",
          tone: "error",
        };
      }
    } finally {
      this.localPending = false;
      this.render();
    }
  }

  // Templates ----------------------------------------------------------------

  private ocrRow(runtime: OcrRuntimeInfo): TemplateResult {
    const label = runtimePackageLabel(runtime);
    const packBytes = getOcrRuntimePack(runtime.pack).reduce(
      (sum, artifact) => sum + artifact.bytes,
      0,
    );
    const percent = runtimeProgressPercent(runtime);
    const installed = runtime.state === "installed";
    const downloading = runtime.state === "downloading";
    const errorDetail =
      runtime.state === "error" && runtime.message
        ? message(
            runtime.message === "OCR runtime download timed out."
              ? "ocrRuntimeDownloadTimedOut"
              : "ocrRuntimeDownloadFailed",
          )
        : "";
    const stateText = downloading
      ? message("ocrRuntimeStateDownloading", String(percent))
      : message(
          installed
            ? "ocrRuntimeStateInstalled"
            : runtime.state === "error"
              ? "ocrRuntimeStateError"
              : "ocrRuntimeStateMissing",
        );
    return html`<li
      class="rt-item"
      data-runtime-pack=${runtime.pack}
      data-state=${runtime.state}
    >
      <div class="rt-id">
        <strong>${label}</strong>
        <small
          >${message("ocrRuntimeSupportedLanguages", runtimeLanguagesLabel(runtime))}
          ·
          ${message("ocrRuntimeGroupSummary", [
            String(runtime.languages.length),
            formatRuntimeSize(packBytes),
          ])}</small
        >
      </div>
      <div class="rt-status">
        ${
          downloading
            ? html`<nt-progress-ring
                size="20"
                .value=${percent / 100}
                label=${message("optRtOcrProgressLabel", [label, String(percent)])}
              ></nt-progress-ring>`
            : nothing
        }
        <span class="rt-state" data-state=${runtime.state}>${stateText}</span>
        ${errorDetail ? html`<small class="rt-detail">${errorDetail}</small>` : nothing}
      </div>
      <div class="rt-action">
        <nt-button
          size="sm"
          variant=${installed ? "danger" : "secondary"}
          data-runtime-pack=${runtime.pack}
          data-runtime-action=${installed ? "delete" : "download"}
          label=${message(
            installed ? "ocrRuntimeDeleteLabel" : "ocrRuntimeDownloadLabel",
            label,
          )}
          ?busy=${downloading}
          ?disabled=${this.ocrPending && !downloading}
          @click=${() => {
            if (installed) void this.deleteOcr(runtime);
            else
              this.downloadOcr({
                type: "OCR_RUNTIME_DOWNLOAD",
                pack: runtime.pack,
              });
          }}
          >${message(
            installed
              ? "ocrRuntimeDelete"
              : downloading
                ? "ocrRuntimeDownloading"
                : "ocrRuntimeDownload",
          )}</nt-button
        >
      </div>
    </li>`;
  }

  /** Recognition language packs and the self-test (video › image recognition). */
  ocrTemplate(context: SectionContext): TemplateResult {
    const downloadable = this.ocrRuntimes.some(
      (runtime) => runtime.state === "missing" || runtime.state === "error",
    );
    const showList = !this.ocrLoading && this.ocrRuntimes.length > 0;
    const selfTest = this.selfTestFeedback;
    return html`<div class="rt-panel" id="ocr-runtimes-panel">
      <div class="rt-head">
        <div>
          <strong>${message("optRtOcrPacksTitle")}</strong>
          <p class="help">${message("optRtOcrPacksHelp")}</p>
        </div>
        <nt-button
          id="ocr-runtime-download-all"
          variant="primary"
          size="sm"
          ?disabled=${
            this.ocrAllPending ? false : !downloadable || this.ocrPending
          }
          ?busy=${this.ocrAllPending}
          @click=${() => this.downloadOcr({ type: "OCR_RUNTIME_DOWNLOAD_ALL" })}
          >${message("ocrRuntimeDownloadAll")}</nt-button
        >
      </div>
      <nt-note icon="shield">${message("ocrRuntimesLocalNotice")}</nt-note>
      ${
        this.ocrLoading
          ? html`<p
              class="rt-placeholder"
              id="ocr-runtime-loading"
              role="status"
            >
              ${message("ocrRuntimesLoading")}
            </p>`
          : nothing
      }
      ${
        !this.ocrLoading && this.ocrLoaded && this.ocrRuntimes.length === 0
          ? html`<p class="rt-placeholder" id="ocr-runtime-empty">
              ${message("optRtOcrEmpty")}
            </p>`
          : nothing
      }
      <ul
        class="rt-list"
        id="ocr-runtime-list"
        aria-label=${message("optRtOcrPacksTitle")}
        aria-busy=${this.ocrLoading ? "true" : "false"}
        ?hidden=${!showList}
      >
        ${repeat(
          this.ocrRuntimes,
          (runtime) => runtime.pack,
          (runtime) => this.ocrRow(runtime),
        )}
      </ul>
      ${feedbackTemplate(this.ocrFeedback, "ocr-runtime-message")}
      <div class="rt-selftest">
        <div class="actions">
          <nt-button
            id="ocr-self-test"
            variant="secondary"
            size="sm"
            ?busy=${this.selfTestBusy}
            @click=${() =>
              void this.runSelfTest(context.settings.ocr.sourceLanguage)}
            >${message("optRtSelfTest")}</nt-button
          >
          <output
            class="feedback"
            id="ocr-test-message"
            data-tone=${selfTest?.tone ?? ""}
            aria-live="polite"
            >${selfTest ? message(selfTest.key, selfTest.subs) : ""}</output
          >
        </div>
        ${
          selfTest?.detail
            ? html`<details class="diagnostic" id="ocr-test-detail">
                <summary>${message("optRtDiagnosticDetails")}</summary>
                <pre>${selfTest.detail}</pre>
              </details>`
            : nothing
        }
      </div>
    </div>`;
  }

  private localRow(pair: LocalTranslationRuntimePair): TemplateResult {
    const label = pairLabel(pair);
    const installed = pair.state === "installed";
    const downloading = pair.state === "downloading";
    const progress = this.localProgress;
    const progressRuntimes = progress
      ? pair.runtimes.filter((runtime) => progress.packIds.has(runtime.packId))
      : [];
    const total = progressRuntimes.reduce(
      (sum, runtime) => sum + (runtime.downloadBytes ?? 0),
      0,
    );
    const received = progressRuntimes.reduce((sum, runtime) => {
      if (progress?.completedPackIds.has(runtime.packId)) {
        return sum + (runtime.downloadBytes ?? 0);
      }
      return (
        sum +
        (runtime.state === "downloading"
          ? Math.min(runtime.bytes ?? 0, runtime.downloadBytes ?? 0)
          : 0)
      );
    }, 0);
    const percent =
      total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    const progressText =
      downloading && total > 0
        ? message("localTranslationRuntimeDownloadProgress", [
            String(percent),
            formatRuntimeSize(received),
            formatRuntimeSize(total),
          ])
        : "";
    return html`<li
      class="rt-item"
      data-runtime-language=${pair.language}
      data-state=${pair.state}
    >
      <div class="rt-id">
        <strong>${label}</strong>
        ${
          pair.bytes > 0 || pair.version
            ? html`<small
                >${[
                  pair.bytes > 0 ? formatRuntimeSize(pair.bytes) : "",
                  pair.version ?? "",
                ]
                  .filter(Boolean)
                  .join(" · ")}</small
              >`
            : nothing
        }
      </div>
      <div class="rt-status">
        ${
          downloading
            ? html`<nt-progress-ring
                size="20"
                .value=${total > 0 ? received / total : null}
                label=${progressText || message("localTranslationRuntimeDownloading")}
              ></nt-progress-ring>`
            : nothing
        }
        <span class="rt-state" data-state=${pair.state}
          >${message(
            installed
              ? "localTranslationRuntimeInstalled"
              : downloading
                ? "localTranslationRuntimeDownloading"
                : pair.state === "error"
                  ? "localTranslationRuntimeError"
                  : "localTranslationRuntimeMissing",
          )}</span
        >
        ${progressText ? html`<small class="rt-detail">${progressText}</small>` : nothing}
      </div>
      <div class="rt-action">
        <nt-button
          size="sm"
          variant=${installed ? "danger" : "secondary"}
          data-runtime-action=${installed ? "delete" : "download"}
          label=${message(
            installed ? "ocrRuntimeDeleteLabel" : "ocrRuntimeDownloadLabel",
            label,
          )}
          ?busy=${downloading}
          ?disabled=${this.localPending && !downloading}
          @click=${() => {
            if (installed) void this.deleteLocal(pair);
            else this.downloadLocal(pair);
          }}
          >${message(
            installed
              ? "ocrRuntimeDelete"
              : downloading
                ? "ocrRuntimeDownloading"
                : "ocrRuntimeDownload",
          )}</nt-button
        >
      </div>
    </li>`;
  }

  /**
   * Chrome Translator summary and offline packs (services › offline
   * components). `context` is accepted for symmetry with other sections.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  localTranslationTemplate(_context: SectionContext): TemplateResult {
    const pairs = localTranslationRuntimePairs(this.localRuntimes);
    const showList = !this.localLoading && pairs.length > 0;
    return html`<div class="rt-panel" id="local-translation-settings-panel">
      <div class="rt-engine">
        <div>
          <strong>${message("providerChromeLocal")}</strong>
          <p class="help">${message("chromeLocalEngineDescription")}</p>
        </div>
        <span class="rt-state" data-state="installed"
          >${message("localTranslationBuiltIn")}</span
        >
      </div>
      <div class="rt-head">
        <div>
          <strong>${message("optRtLocalPacksTitle")}</strong>
          <p class="help">${message("localTranslationSettingsDescription")}</p>
        </div>
      </div>
      <nt-note icon="shield">${message("bergamotRuntimeLocalNotice")}</nt-note>
      ${
        this.localLoading
          ? html`<p
              class="rt-placeholder"
              id="local-translation-runtime-loading"
              role="status"
            >
              ${message("localTranslationRuntimesLoading")}
            </p>`
          : nothing
      }
      ${
        !this.localLoading && this.localLoaded && pairs.length === 0
          ? html`<p class="rt-placeholder" id="local-translation-runtime-empty">
              ${message("localTranslationRuntimesEmpty")}
            </p>`
          : nothing
      }
      <ul
        class="rt-list"
        id="local-translation-runtime-list"
        aria-label=${message("optRtLocalPacksTitle")}
        aria-busy=${this.localLoading ? "true" : "false"}
        ?hidden=${!showList}
      >
        ${repeat(
          pairs,
          (pair) => pair.language,
          (pair) => this.localRow(pair),
        )}
      </ul>
      ${feedbackTemplate(this.localFeedback, "local-translation-runtime-message")}
    </div>`;
  }
}
