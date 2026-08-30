import {
  BrowserLocalOcrEngine,
  normalizeRecognizedText,
} from "@/src/ocr/engine";
import {
  isOcrSourceLanguageSupported,
  ocrRuntimeLanguages,
} from "@/src/ocr/languages";
import { PaddleOcrEngine } from "@/src/ocr/paddle-engine";
import {
  analyzeOcrPixels,
  OcrFrameDeduplicator,
  ocrFrameDifference,
  ocrSubtitleFingerprint,
} from "@/src/ocr/frame-analysis";
import { prepareOcrFrame } from "@/src/ocr/frame";
import {
  normalizeOcrSelection,
  ocrRegionRelativeToBounds,
  projectOcrRegionToViewport,
  suggestedSubtitleRegion,
} from "@/src/ocr/geometry";
import {
  ocrMediaTargetIsCurrent,
  selectOcrMediaTarget,
} from "@/src/ocr/media-target";
import { OcrSampler } from "@/src/ocr/sampler";
import { filterOcrSubtitleText, OcrSession } from "@/src/ocr/session";
import { OcrSubtitleAdapter } from "@/src/ocr/subtitle-adapter";
import type { OcrCaptureResponse } from "@/src/ocr/types";
import { DEFAULT_SETTINGS, mergeSettings } from "@/src/shared/settings";
import { afterEach, describe, expect, it, vi } from "vitest";

const preparedOcrFrames = vi.hoisted(() => ({
  fingerprints: [] as number[],
  blackFrames: [] as boolean[],
  mediaBlackFrames: [] as Array<boolean | undefined>,
  originalCanvasFrames: [] as boolean[],
}));

vi.mock("@/src/ocr/frame", () => ({
  prepareOcrFrame: vi.fn(() => {
    const fingerprint = preparedOcrFrames.fingerprints.shift() ?? 0;
    const includeOriginal =
      preparedOcrFrames.originalCanvasFrames.shift() ?? false;
    const canvas = document.createElement("canvas");
    canvas.dataset.ocrVariant = "binary";
    const originalCanvas = document.createElement("canvas");
    originalCanvas.dataset.ocrVariant = "original";
    return Promise.resolve({
      canvas,
      ...(includeOriginal ? { originalCanvas } : {}),
      fingerprint: new Uint8Array(128).fill(fingerprint),
      black: preparedOcrFrames.blackFrames.shift() ?? false,
      ...(preparedOcrFrames.mediaBlackFrames.length > 0
        ? { mediaBlack: preparedOcrFrames.mediaBlackFrames.shift() }
        : {}),
    });
  }),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: { getMessage: (key: string) => key },
    runtime: { sendMessage: vi.fn() },
  },
}));

vi.mock("@/src/shared/i18n", () => ({
  message: (key: string) => key,
}));

afterEach(() => {
  vi.useRealTimers();
  preparedOcrFrames.fingerprints = [];
  preparedOcrFrames.blackFrames = [];
  preparedOcrFrames.mediaBlackFrames = [];
  preparedOcrFrames.originalCanvasFrames = [];
  delete (globalThis as typeof globalThis & { TextDetector?: unknown })
    .TextDetector;
  document.body.replaceChildren();
});

describe("experimental image subtitle OCR", () => {
  it("selects downloadable OCR runtimes from the configured subtitle language", () => {
    expect(ocrRuntimeLanguages()).toEqual(["chi_sim"]);
    expect(ocrRuntimeLanguages("auto")).toEqual(["chi_sim"]);
    expect(ocrRuntimeLanguages("en-US")).toEqual(["eng"]);
    expect(ocrRuntimeLanguages("zh-CN")).toEqual(["chi_sim"]);
    expect(ocrRuntimeLanguages("zh-Hans")).toEqual(["chi_sim"]);
    expect(ocrRuntimeLanguages("zh-Hant")).toEqual(["chi_tra"]);
    expect(ocrRuntimeLanguages("ja")).toEqual(["jpn"]);
    expect(ocrRuntimeLanguages("ko")).toEqual(["kor"]);
    expect(ocrRuntimeLanguages("es")).toEqual(["spa"]);
    expect(ocrRuntimeLanguages("fr")).toEqual(["fra"]);
    expect(ocrRuntimeLanguages("de")).toEqual(["deu"]);
    expect(() => ocrRuntimeLanguages("it")).toThrow(RangeError);
    expect(isOcrSourceLanguageSupported("auto")).toBe(true);
    expect(isOcrSourceLanguageSupported("zh-Hant")).toBe(true);
    expect(isOcrSourceLanguageSupported("ja")).toBe(true);
    expect(isOcrSourceLanguageSupported("it")).toBe(false);
  });

  it("rejects OCR source languages that have no managed recognition runtime", async () => {
    const availability = vi.fn(() => Promise.resolve("available" as const));
    const session = new OcrSession({
      enabled: true,
      sourceLanguage: "it",
      adapter: new OcrSubtitleAdapter(),
      engine: {
        availability,
        recognize: () => Promise.resolve("should not run"),
      },
    });

    await expect(session.start()).resolves.toMatchObject({
      state: "unavailable",
      recognized: 0,
      message: "ocrSourceLanguageUnsupported",
    });
    expect(availability).not.toHaveBeenCalled();
  });

  it("can cancel while the OCR runtime availability check is pending", async () => {
    let resolveAvailability!: (value: "available") => void;
    const availability = vi.fn(
      () =>
        new Promise<"available">((resolve) => {
          resolveAvailability = resolve;
        }),
    );
    const select = vi.fn();
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      engine: {
        availability,
        recognize: () => Promise.resolve("should not run"),
      },
      selector: {
        select,
        destroy: vi.fn(),
      } as never,
    });

    const start = session.start();
    await Promise.resolve();
    expect(session.getStatus()).toMatchObject({
      state: "initializing",
      progress: 0,
    });

    session.stop("cancelled");
    resolveAvailability("available");

    await expect(start).resolves.toMatchObject({ state: "cancelled" });
    expect(select).not.toHaveBeenCalled();
    session.destroy();
  });

  it("does not let an obsolete preparation failure clear a restarted OCR session", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 800, 450);
    document.body.append(video);
    let rejectFirstPreparation: ((error: Error) => void) | undefined;
    let rejectFirstSelection: ((error: Error) => void) | undefined;
    const prepare = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirstPreparation = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const select = vi
      .fn<
        () => Promise<{ x: number; y: number; width: number; height: number }>
      >()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirstSelection = reject;
          }),
      )
      .mockResolvedValue({ x: 0, y: 0.7, width: 1, height: 0.3 });
    const endSession = vi.fn(() => Promise.resolve());
    const onStopped = vi.fn();
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture: () => Promise.resolve({ ok: false, error: "rate_limited" }),
      engine: {
        availability: () => Promise.resolve("available"),
        prepare,
        recognize: () => Promise.resolve("Subtitle"),
        endSession,
      },
      selector: { select, destroy: vi.fn() } as never,
      onStopped,
    });

    const obsoleteStart = session.start();
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    await session.start();
    expect(session.getStatus()).toMatchObject({ state: "capturing" });

    rejectFirstPreparation?.(new Error("late obsolete runtime failure"));
    await Promise.resolve();
    rejectFirstSelection?.(
      new DOMException("Obsolete selection cancelled", "AbortError"),
    );
    await obsoleteStart;

    expect(session.getStatus()).toMatchObject({ state: "capturing" });
    expect(onStopped).not.toHaveBeenCalled();
    // Each explicit start() performs its normal preflight stop; the obsolete
    // catch must not add a third endSession() against the restarted engine.
    expect(endSession).toHaveBeenCalledTimes(2);
    session.destroy();
  });

  it("stops region selection and explains when the required runtime is missing", async () => {
    const player = document.createElement("iframe");
    player.src = "https://player.example.test/watch/current";
    player.getBoundingClientRect = () => new DOMRect(0, 0, 800, 450);
    document.body.append(player);
    let rejectSelection: ((error: Error) => void) | undefined;
    const select = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectSelection = reject;
        }),
    );
    const destroy = vi.fn(() => {
      rejectSelection?.(
        new DOMException("OCR region selection cancelled.", "AbortError"),
      );
    });
    const session = new OcrSession({
      enabled: true,
      sourceLanguage: "ja",
      adapter: new OcrSubtitleAdapter(),
      engine: {
        availability: () => Promise.resolve("available"),
        prepare: () => Promise.reject(new Error("ocr_runtime_missing:jpn")),
        recognize: () => Promise.resolve("should not run"),
      },
      selector: { select, destroy } as never,
    });

    await expect(session.start()).resolves.toMatchObject({
      state: "error",
      recognized: 0,
      message: "ocrRuntimeMissing",
    });
    expect(destroy).toHaveBeenCalled();
  });

  it("reports OCR runtime preparation progress while the user selects a region", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 800, 450);
    document.body.append(video);
    let reportProgress:
      ((value: { progress: number; status: string }) => void) | undefined;
    let resolveSelection:
      | ((value: {
          x: number;
          y: number;
          width: number;
          height: number;
        }) => void)
      | undefined;
    const statuses: Array<ReturnType<OcrSession["getStatus"]>> = [];
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      engine: {
        availability: () => Promise.resolve("available"),
        prepare: (_signal, onProgress) => {
          reportProgress = onProgress;
          return Promise.resolve();
        },
        recognize: () => Promise.resolve("Subtitle"),
      },
      selector: {
        select: () =>
          new Promise((resolve) => {
            resolveSelection = resolve;
          }),
        destroy: vi.fn(),
      } as never,
      onStatus: (status) => statuses.push(status),
    });

    const start = session.start();
    await vi.waitFor(() => expect(reportProgress).toBeTypeOf("function"));
    expect(session.getStatus()).toMatchObject({ state: "selecting" });

    reportProgress?.({ progress: 0.5, status: "loading" });
    expect(session.getStatus()).toMatchObject({
      state: "selecting",
      progress: 0.5,
    });
    expect(statuses).toContainEqual(
      expect.objectContaining({ state: "selecting", progress: 0.5 }),
    );

    resolveSelection?.({ x: 0, y: 0.7, width: 1, height: 0.3 });
    await start;
    session.destroy();
  });

  it("keeps single Latin subtitles while filtering punctuation and digit noise", () => {
    expect(filterOcrSubtitleText(" I ")).toBe("I");
    expect(filterOcrSubtitleText("A")).toBe("A");
    expect(filterOcrSubtitleText("7")).toBe("");
    expect(filterOcrSubtitleText("...")).toBe("");
    expect(filterOcrSubtitleText("OK")).toBe("OK");
    expect(filterOcrSubtitleText("我")).toBe("我");
    expect(filterOcrSubtitleText("你好")).toBe("你好");
    expect(
      filterOcrSubtitleText("FA aa - = “Ne bh.)\nHELLOOCR 123 =\n23 rye"),
    ).toBe("HELLOOCR 123");
    expect(filterOcrSubtitleText("© SECOND OCRLINE Za\nINE Fg")).toBe(
      "SECOND OCRLINE",
    );
    expect(filterOcrSubtitleText("SECOND' OCR LINE")).toBe("SECOND OCR LINE");
    expect(filterOcrSubtitleText("ACTORS' LOUNGE")).toBe("ACTORS' LOUNGE");
    expect(filterOcrSubtitleText("HELLO OCR123")).toBe("HELLO OCR 123");
    expect(filterOcrSubtitleText("Use COVID19 and H264")).toBe(
      "Use COVID19 and H264",
    );
    expect(
      filterOcrSubtitleText("First real line\nSecond real line"),
    ).toContain("\n");
    expect(
      filterOcrSubtitleText(
        "This is the first subtitle line\nThis is the second subtitle line\nThis is the third subtitle line",
      ),
    ).toContain("\n");
    expect(
      filterOcrSubtitleText(
        "a\nh [=] 172 LH a Ee a “4\nA H [=] 172 LH A EE A “4",
      ),
    ).toBe("");
    expect(filterOcrSubtitleText("one\ntwo\nthree\nfour")).toBe("");
  });
  it("is disabled by default and safely migrates old settings", () => {
    expect(DEFAULT_SETTINGS.ocr.enabled).toBe(false);
    expect(mergeSettings({ subtitles: { enabled: true } }).ocr.enabled).toBe(
      false,
    );
    expect(mergeSettings({ ocr: { enabled: true } }).ocr.enabled).toBe(true);
  });

  it("clamps and normalizes reversed selections inside the video", () => {
    const region = normalizeOcrSelection(
      { x: 250, y: 180 },
      { x: -20, y: 40 },
      { left: 20, top: 50, right: 220, bottom: 160 },
      400,
      200,
    );
    expect(region).toEqual({ x: 0.05, y: 0.25, width: 0.5, height: 0.55 });
    const suggested = suggestedSubtitleRegion(
      { left: 40, top: 20, right: 360, bottom: 180 },
      400,
      200,
    );
    expect(suggested?.x).toBeCloseTo(0.1);
    expect(suggested?.y).toBeCloseTo(0.66);
    expect(suggested?.width).toBeCloseTo(0.8);
    expect(suggested?.height).toBeCloseTo(0.24);
    const relativeSuggested = suggested
      ? ocrRegionRelativeToBounds(
          suggested,
          { left: 40, top: 20, right: 360, bottom: 180 },
          400,
          200,
        )
      : null;
    expect(relativeSuggested?.x).toBeCloseTo(0);
    expect(relativeSuggested?.y).toBeCloseTo(0.7);
    expect(relativeSuggested?.width).toBeCloseTo(1);
    expect(relativeSuggested?.height).toBeCloseTo(0.3);
    expect(
      normalizeOcrSelection(
        { x: 10, y: 10 },
        { x: 15, y: 15 },
        { left: 0, top: 0, right: 100, bottom: 100 },
        100,
        100,
      ),
    ).toBeNull();
  });

  it("keeps a selected OCR region attached to a resized or fullscreen video", () => {
    const relative = ocrRegionRelativeToBounds(
      { x: 0.2, y: 0.4, width: 0.4, height: 0.1 },
      { left: 100, top: 100, right: 900, bottom: 500 },
      1_000,
      800,
    );
    expect(relative).toMatchObject({ x: 0.125, y: 0.55, width: 0.5 });
    expect(relative?.height).toBeCloseTo(0.2);
    const projected = relative
      ? projectOcrRegionToViewport(
          relative,
          { left: 0, top: 0, right: 1_000, bottom: 800 },
          1_000,
          800,
        )
      : null;
    expect(projected).toMatchObject({ x: 0.125, y: 0.55, width: 0.5 });
    expect(projected?.height).toBeCloseTo(0.2);
  });

  it("reprojects iframe OCR status and sampling after resize and fullscreen", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80, 90, 100];
    let bounds = DOMRect.fromRect({ x: 80, y: 60, width: 800, height: 450 });
    const player = document.createElement("iframe");
    player.src = "https://player.example.test/watch/current";
    player.getBoundingClientRect = () => bounds;
    document.body.append(player);
    const mediaRegion = { x: 0.1, y: 0.55, width: 0.7, height: 0.2 };
    const initialRegion = projectOcrRegionToViewport(
      mediaRegion,
      bounds,
      window.innerWidth,
      window.innerHeight,
    );
    if (!initialRegion) throw new Error("missing initial OCR projection");
    const statuses: Array<ReturnType<OcrSession["getStatus"]>> = [];
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve("Projected subtitle"),
      },
      selector: {
        select: () => Promise.resolve(initialRegion),
        destroy: vi.fn(),
      } as never,
      onStatus: (status) => statuses.push(status),
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(prepareOcrFrame).mock.calls.at(-1)?.[1]).toEqual(
      initialRegion,
    );

    bounds = DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    window.dispatchEvent(new Event("resize"));
    expect(statuses.at(-1)?.region).toBeUndefined();

    bounds = DOMRect.fromRect({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const fullscreenRegion = projectOcrRegionToViewport(
      mediaRegion,
      bounds,
      window.innerWidth,
      window.innerHeight,
    );
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(statuses.at(-1)?.region).toEqual(fullscreenRegion);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(prepareOcrFrame).mock.calls.at(-1)?.[1]).toEqual(
      fullscreenRegion,
    );

    bounds = DOMRect.fromRect({ x: 140, y: 100, width: 600, height: 320 });
    const resizedRegion = projectOcrRegionToViewport(
      mediaRegion,
      bounds,
      window.innerWidth,
      window.innerHeight,
    );
    window.dispatchEvent(new Event("resize"));
    expect(statuses.at(-1)?.region).toEqual(resizedRegion);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(prepareOcrFrame).mock.calls.at(-1)?.[1]).toEqual(
      resizedRegion,
    );

    session.stop("cancelled");
    expect(session.getStatus().region).toBeUndefined();
    const statusCountAfterStop = statuses.length;
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(statuses).toHaveLength(statusCountAfterStop);
  });

  it("uses a large cross-origin player iframe when no HTML video exists", () => {
    const smallCanvas = document.createElement("canvas");
    smallCanvas.getBoundingClientRect = () => new DOMRect(0, 0, 100, 60);
    const player = document.createElement("iframe");
    player.src = "https://vfiles.gtimg.cn/tvideo/libcocos-frame/player.html";
    player.getBoundingClientRect = () => new DOMRect(40, 50, 800, 450);
    document.body.append(smallCanvas, player);

    expect(selectOcrMediaTarget()).toBe(player);
    expect(ocrMediaTargetIsCurrent(player)).toBe(true);
    player.remove();
    expect(ocrMediaTargetIsCurrent(player)).toBe(false);
  });

  it("allows a visible compact video to enter manual OCR selection", () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(30, 40, 200, 120);
    document.body.append(video);

    expect(selectOcrMediaTarget()).toBe(video);
    expect(ocrMediaTargetIsCurrent(video)).toBe(true);
  });

  it("prefers a known player iframe over an unrelated top-page autoplay video", () => {
    const heroVideo = document.createElement("video");
    Object.defineProperty(heroVideo, "paused", {
      configurable: true,
      value: false,
    });
    heroVideo.getBoundingClientRect = () => new DOMRect(0, 0, 900, 260);
    const player = document.createElement("iframe");
    player.src = "https://player.example.test/watch/current";
    player.getBoundingClientRect = () => new DOMRect(40, 280, 800, 450);
    document.body.append(heroVideo, player);

    expect(selectOcrMediaTarget()).toBe(player);
  });

  it("selects picture-in-picture as the active target but refuses to capture it", async () => {
    const pictureInPictureDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "pictureInPictureElement",
    );
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    document.body.append(video);
    Object.defineProperty(document, "pictureInPictureElement", {
      configurable: true,
      value: video,
    });
    const selector = { select: vi.fn(), destroy: vi.fn() };
    const capture = vi.fn();
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve(""),
      },
      selector: selector as never,
    });

    try {
      expect(selectOcrMediaTarget()).toBe(video);
      await expect(session.start()).resolves.toMatchObject({
        state: "unavailable",
        recognized: 0,
        message: "ocrPictureInPictureUnsupported",
      });
      expect(selector.select).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    } finally {
      session.destroy();
      if (pictureInPictureDescriptor) {
        Object.defineProperty(
          document,
          "pictureInPictureElement",
          pictureInPictureDescriptor,
        );
      } else {
        Reflect.deleteProperty(document, "pictureInPictureElement");
      }
    }
  });

  it("recognizes and publishes OCR cues from a canvas-player iframe", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80];
    const player = document.createElement("iframe");
    player.src = "https://vfiles.gtimg.cn/tvideo/libcocos-frame/player.html";
    player.getBoundingClientRect = () => new DOMRect(20, 30, 800, 450);
    document.body.append(player);
    const adapter = new OcrSubtitleAdapter();
    const selectedTargets: Array<HTMLElement | null> = [];
    const prepare = vi.fn(() => Promise.resolve());
    const select = vi.fn(() =>
      Promise.resolve({ x: 0.1, y: 0.6, width: 0.7, height: 0.25 }),
    );
    const session = new OcrSession({
      enabled: true,
      sourceLanguage: "en",
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        prepare,
        recognize: () => Promise.resolve("Canvas subtitle"),
      },
      selector: { select, destroy: vi.fn() } as never,
      onMediaTarget: (target) => selectedTargets.push(target),
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(select).toHaveBeenCalledWith(player, expect.any(AbortSignal));
    expect(prepare).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      expect.any(Function),
      "en",
    );
    expect((await adapter.collect())?.cues.at(-1)).toMatchObject({
      originalText: "Canvas subtitle",
      endMs: null,
    });
    expect((await adapter.collect())?.language).toBe("en");
    expect(selectedTargets).toContain(player);
    session.destroy();
    expect(selectedTargets.at(-1)).toBeNull();
  });

  it("backs off a stable iframe without forcing duplicate OCR", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = Array.from({ length: 6 }, () => 80);
    const player = document.createElement("iframe");
    player.src = "https://vfiles.gtimg.cn/tvideo/libcocos-frame/player.html";
    player.getBoundingClientRect = () => new DOMRect(20, 30, 800, 450);
    document.body.append(player);
    const capture = vi.fn(() =>
      Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
    );
    const recognize = vi.fn(() => Promise.resolve("Stable subtitle"));
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(5_500);

    expect(capture).toHaveBeenCalledTimes(6);
    expect(recognize).toHaveBeenCalledOnce();
    expect(session.getStatus()).toMatchObject({
      state: "active",
      recognized: 1,
    });
    session.destroy();
  });

  it("resumes iframe OCR after visual motion without counting the static wait", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80, 80, 80, 80, 90];
    const player = document.createElement("iframe");
    player.src = "https://vfiles.gtimg.cn/tvideo/libcocos-frame/player.html";
    player.getBoundingClientRect = () => new DOMRect(20, 30, 800, 450);
    document.body.append(player);
    const adapter = new OcrSubtitleAdapter();
    const capture = vi.fn(() =>
      Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
    );
    const recognize = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("First subtitle")
      .mockResolvedValueOnce("Second subtitle");
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(3_500);

    expect(capture).toHaveBeenCalledTimes(5);
    expect(recognize).toHaveBeenCalledTimes(2);
    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({
        originalText: "First subtitle",
        startMs: 0,
        endMs: 500,
      }),
      expect.objectContaining({
        originalText: "Second subtitle",
        startMs: 500,
        endMs: null,
      }),
    ]);
    session.destroy();
  });

  it("publishes a single Latin letter from OCR through the subtitle adapter", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve("I"),
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);

    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({ originalText: "I" }),
    ]);
    session.destroy();
  });

  it("retries a transient recognition failure and releases the failed frame", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80, 90];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    let failedCanvas: HTMLCanvasElement | undefined;
    const recognize = vi
      .fn<(canvas: HTMLCanvasElement) => Promise<string>>()
      .mockImplementationOnce((canvas) => {
        failedCanvas = canvas;
        return Promise.reject(new Error("temporary runtime failure"));
      })
      .mockResolvedValueOnce("Recovered subtitle");
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getStatus().state).toBe("capturing");
    expect(failedCanvas?.width).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    expect((await adapter.collect())?.cues.at(-1)?.originalText).toBe(
      "Recovered subtitle",
    );
    expect(session.getStatus()).toMatchObject({
      state: "active",
      recognized: 1,
    });
    session.destroy();
  });

  it("stops after three consecutive recognition failures", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80, 90, 100];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const onStopped = vi.fn();
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.reject(new Error("persistent failure")),
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
      onStopped,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getStatus().state).toBe("capturing");
    await vi.advanceTimersByTimeAsync(500);
    expect(session.getStatus().state).toBe("capturing");
    await vi.advanceTimersByTimeAsync(500);

    expect(session.getStatus()).toMatchObject({
      state: "error",
      recognized: 0,
      message: "ocrRecognitionFailed",
    });
    expect(onStopped).toHaveBeenCalledTimes(1);
    session.destroy();
  });

  it("requires consecutive agreement for uncertain OCR and rejects very low confidence", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80, 80, 90];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    const recognize = vi
      .fn()
      .mockResolvedValueOnce({ text: "Hello subtitle", confidence: 54 })
      .mockResolvedValueOnce({ text: "Hello subtitle", confidence: 58 })
      .mockResolvedValueOnce({ text: "h [=] 172 a", confidence: 12 });
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(adapter.collect()).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({ originalText: "Hello subtitle" }),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await adapter.collect())?.cues).toHaveLength(1);
    expect(session.getStatus().recognized).toBe(1);
    session.destroy();
  });

  it("keeps the original crop for PP-OCR subtitle recognition", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80, 80];
    preparedOcrFrames.originalCanvasFrames = [true, true];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    const recognize = vi.fn((canvas: HTMLCanvasElement) =>
      Promise.resolve(
        canvas.dataset.ocrVariant === "original"
          ? { text: "Small subtitle", confidence: 48 }
          : { text: "", confidence: 8 },
      ),
    );
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(adapter.collect()).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({ originalText: "Small subtitle" }),
    ]);
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(
      recognize.mock.calls.map(([canvas]) => canvas.dataset.ocrVariant),
    ).toEqual(["original", "original"]);
    session.destroy();
  });

  it("verifies suspicious collapsed Latin subtitles with the binary crop", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80];
    preparedOcrFrames.originalCanvasFrames = [true];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    const recognize = vi.fn((canvas: HTMLCanvasElement) =>
      Promise.resolve(
        canvas.dataset.ocrVariant === "original"
          ? { text: "SECONDJOCRLINE", confidence: 91 }
          : { text: "SECOND OCR LINE", confidence: 78 },
      ),
    );
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);

    expect((await adapter.collect())?.cues.at(-1)?.originalText).toBe(
      "SECOND OCR LINE",
    );
    expect(
      recognize.mock.calls.map(([canvas]) => canvas.dataset.ocrVariant),
    ).toEqual(["original", "binary"]);
    session.destroy();
  });

  it("restores a conservative Latin-number boundary before publishing", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80];
    preparedOcrFrames.originalCanvasFrames = [true];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    const recognize = vi.fn((canvas: HTMLCanvasElement) =>
      Promise.resolve(
        canvas.dataset.ocrVariant === "original"
          ? { text: "HELLO OCR123", confidence: 91 }
          : { text: "HELLO OCR 123", confidence: 76 },
      ),
    );
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);

    expect((await adapter.collect())?.cues.at(-1)?.originalText).toBe(
      "HELLO OCR 123",
    );
    expect(
      recognize.mock.calls.map(([canvas]) => canvas.dataset.ocrVariant),
    ).toEqual(["original"]);
    session.destroy();
  });

  it("invalidates an iframe timeline on load and ignores late recognition", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80, 80];
    const player = document.createElement("iframe");
    player.src = "https://player.example.test/watch/current";
    player.getBoundingClientRect = () => new DOMRect(20, 30, 800, 450);
    document.body.append(player);
    const adapter = new OcrSubtitleAdapter();
    let resolveFirstRecognition: ((text: string) => void) | undefined;
    const recognize = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRecognition = resolve;
          }),
      )
      .mockResolvedValueOnce("A");
    const onStopped = vi.fn();
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () =>
          Promise.resolve({ x: 0.1, y: 0.6, width: 0.7, height: 0.25 }),
        destroy: vi.fn(),
      } as never,
      onStopped,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(resolveFirstRecognition).toBeTypeOf("function"),
    );

    player.dispatchEvent(new Event("load"));

    expect(session.getStatus()).toMatchObject({
      state: "unavailable",
      message: "ocrVideoChanged",
      recognized: 0,
    });
    await expect(adapter.collect()).resolves.toBeNull();
    expect(onStopped).toHaveBeenCalledOnce();

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({ originalText: "A" }),
    ]);
    expect(recognize).toHaveBeenCalledTimes(2);

    resolveFirstRecognition?.("stale iframe subtitle");
    await vi.advanceTimersByTimeAsync(0);
    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({ originalText: "A" }),
    ]);

    session.stop("idle");
    player.dispatchEvent(new Event("load"));
    expect(session.getStatus().state).toBe("idle");
  });

  it("timestamps a cue at capture time instead of delayed recognition completion", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      value: 5,
      writable: true,
    });
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    let resolveRecognition: ((text: string) => void) | undefined;
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () =>
          new Promise((resolve) => {
            resolveRecognition = resolve;
          }),
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(resolveRecognition).toBeTypeOf("function"));
    video.currentTime = 8;
    resolveRecognition?.("Delayed subtitle");
    await vi.advanceTimersByTimeAsync(0);

    expect((await adapter.collect())?.cues.at(-1)).toMatchObject({
      startMs: 5_000,
      originalText: "Delayed subtitle",
    });
    session.destroy();
  });

  it("drops a recognized frame confirmed as feedback from the translated overlay", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [81];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    const ignoreRecognizedText = vi.fn((text: string) =>
      text.includes("Translated overlay"),
    );
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve("Translated overlay"),
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
      ignoreRecognizedText,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(ignoreRecognizedText).toHaveBeenCalledWith("Translated overlay");
    expect(await adapter.collect()).toBeNull();
    expect(session.getStatus()).toMatchObject({
      state: "active",
      recognized: 0,
    });
    session.destroy();
  });

  it("temporarily excludes an overlapping extension subtitle from capture", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [81];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);

    const overlayHost = document.createElement("div");
    overlayHost.dataset.noritransUi = "subtitle-overlay";
    overlayHost.style.visibility = "visible";
    const root = overlayHost.attachShadow({ mode: "open" });
    const cueCard = document.createElement("div");
    cueCard.className = "cue-card";
    cueCard.getBoundingClientRect = () => new DOMRect(80, 280, 480, 50);
    root.append(cueCard);
    document.body.append(overlayHost);
    const floatingControl = document.createElement(
      "noritrans-floating-control",
    );
    floatingControl.dataset.noritransUi = "unified-floating-control";
    floatingControl.style.visibility = "visible";
    document.body.append(floatingControl);

    const capture = vi.fn(() => {
      expect(overlayHost.style.getPropertyValue("visibility")).toBe("hidden");
      expect(overlayHost.style.getPropertyPriority("visibility")).toBe(
        "important",
      );
      expect(floatingControl.style.getPropertyValue("visibility")).toBe(
        "hidden",
      );
      return Promise.resolve({
        ok: true as const,
        dataUrl: "data:image/png,x",
      });
    });
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve("Original video subtitle"),
      },
      selector: {
        select: () =>
          Promise.resolve({
            x: 0,
            y: 260 / window.innerHeight,
            width: 640 / window.innerWidth,
            height: 90 / window.innerHeight,
          }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(capture).toHaveBeenCalledOnce();
    expect(overlayHost.style.getPropertyValue("visibility")).toBe("visible");
    expect(overlayHost.style.getPropertyPriority("visibility")).toBe("");
    expect(floatingControl.style.getPropertyValue("visibility")).toBe(
      "visible",
    );
    session.destroy();
  });

  it("also excludes an overlapping extension notice after its cue was cleared", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [82];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);

    const overlayHost = document.createElement("div");
    overlayHost.dataset.noritransUi = "subtitle-overlay";
    overlayHost.style.visibility = "visible";
    const root = overlayHost.attachShadow({ mode: "open" });
    const cueCard = document.createElement("div");
    cueCard.className = "cue-card";
    cueCard.hidden = true;
    const notice = document.createElement("div");
    notice.className = "notice";
    notice.textContent = "Local translation unavailable";
    notice.getBoundingClientRect = () => new DOMRect(80, 280, 480, 50);
    root.append(cueCard, notice);
    document.body.append(overlayHost);

    const capture = vi.fn(() => {
      expect(overlayHost.style.getPropertyValue("visibility")).toBe("hidden");
      return Promise.resolve({
        ok: true as const,
        dataUrl: "data:image/png,x",
      });
    });
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve("Original video subtitle"),
      },
      selector: {
        select: () =>
          Promise.resolve({
            x: 0,
            y: 260 / window.innerHeight,
            width: 640 / window.innerWidth,
            height: 90 / window.innerHeight,
          }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(capture).toHaveBeenCalledOnce();
    expect(overlayHost.style.getPropertyValue("visibility")).toBe("visible");
    session.destroy();
  });

  it("keeps the capture-excluded subtitle visible across capture restarts", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [81, 82];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);

    const overlayHost = document.createElement("div");
    overlayHost.dataset.noritransUi = "subtitle-overlay";
    overlayHost.style.visibility = "visible";
    const root = overlayHost.attachShadow({ mode: "open" });
    const cueCard = document.createElement("div");
    cueCard.className = "cue-card";
    cueCard.getBoundingClientRect = () => new DOMRect(80, 280, 480, 50);
    root.append(cueCard);
    document.body.append(overlayHost);

    const captureResolvers: Array<(response: OcrCaptureResponse) => void> = [];
    const capture = vi.fn(
      () =>
        new Promise<OcrCaptureResponse>((resolve) => {
          captureResolvers.push(resolve);
        }),
    );
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve("Original video subtitle"),
      },
      selector: {
        select: () =>
          Promise.resolve({
            x: 0,
            y: 260 / window.innerHeight,
            width: 640 / window.innerWidth,
            height: 90 / window.innerHeight,
          }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(overlayHost.style.visibility).toBe("visible");

    await session.start();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect(overlayHost.style.visibility).toBe("visible");

    captureResolvers[0]?.({ ok: true, dataUrl: "data:image/png,old" });
    await vi.advanceTimersByTimeAsync(0);
    expect(overlayHost.style.visibility).toBe("visible");

    captureResolvers[1]?.({ ok: true, dataUrl: "data:image/png,new" });
    await vi.advanceTimersByTimeAsync(0);
    expect(overlayHost.style.visibility).toBe("visible");
    session.destroy();
  });

  it("skips screenshots while a loaded video is paused or ended and resumes on play", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80, 90];
    const video = document.createElement("video");
    let paused = true;
    let ended = false;
    Object.defineProperties(video, {
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, get: () => ended },
      readyState: { configurable: true, get: () => 4 },
    });
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const capture = vi.fn(() =>
      Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
    );
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve("Playing subtitle"),
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(capture).not.toHaveBeenCalled();

    paused = false;
    video.dispatchEvent(new Event("play"));
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledOnce();

    ended = true;
    video.dispatchEvent(new Event("ended"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(capture).toHaveBeenCalledOnce();

    ended = false;
    video.dispatchEvent(new Event("play"));
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(2);
    session.destroy();
  });

  it("pauses on an inactive tab and resumes without another region selection", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80];
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    const capture = vi
      .fn<(signal: AbortSignal) => Promise<OcrCaptureResponse>>()
      .mockResolvedValueOnce({ ok: false, error: "inactive_tab" })
      .mockResolvedValueOnce({ ok: true, dataUrl: "data:image/png,x" });
    const select = vi.fn(() =>
      Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
    );
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve("Resumed subtitle"),
      },
      selector: { select, destroy: vi.fn() } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getStatus()).toMatchObject({
      state: "capturing",
      message: "ocrInactiveTabPaused",
      recognized: 0,
    });
    expect(await adapter.collect()).toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    expect((await adapter.collect())?.cues.at(-1)?.originalText).toBe(
      "Resumed subtitle",
    );
    expect(session.getStatus()).toMatchObject({
      state: "active",
      recognized: 1,
    });
    expect(select).toHaveBeenCalledOnce();
    session.destroy();
  });

  it("explains when even the compressed local screenshot is too large", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture: () =>
        Promise.resolve({ ok: false as const, error: "capture_too_large" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve(""),
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(session.getStatus()).toMatchObject({
      state: "unavailable",
      message: "ocrCaptureTooLarge",
    });
    session.destroy();
  });

  it("detects black frames and deduplicates nearly identical frames", () => {
    const black = new Uint8ClampedArray(32 * 16 * 4);
    for (let index = 3; index < black.length; index += 4) black[index] = 255;
    const analysis = analyzeOcrPixels(black, 32, 16);
    expect(analysis.black).toBe(true);
    const deduplicator = new OcrFrameDeduplicator();
    expect(deduplicator.shouldRecognize(analysis.fingerprint)).toBe(true);
    expect(deduplicator.shouldRecognize(analysis.fingerprint)).toBe(false);
    expect(ocrFrameDifference(analysis.fingerprint, analysis.fingerprint)).toBe(
      0,
    );
  });

  it("deduplicates sparse processed-frame noise but detects a moved subtitle", () => {
    const width = 960;
    const height = 160;
    const binaryFrame = (subtitleLeft: number, noisy: boolean) => {
      const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
      const paintBlack = (
        left: number,
        top: number,
        right: number,
        bottom: number,
      ) => {
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const index = (y * width + x) * 4;
            pixels[index] = 0;
            pixels[index + 1] = 0;
            pixels[index + 2] = 0;
          }
        }
      };
      paintBlack(subtitleLeft, 72, subtitleLeft + 260, 80);
      paintBlack(subtitleLeft + 30, 88, subtitleLeft + 230, 96);
      if (noisy) {
        paintBlack(27, 21, 29, 23);
        paintBlack(817, 131, 819, 133);
      }
      return pixels;
    };

    const baseline = ocrSubtitleFingerprint(
      binaryFrame(340, false),
      width,
      height,
    );
    const noisy = ocrSubtitleFingerprint(binaryFrame(340, true), width, height);
    const changed = ocrSubtitleFingerprint(
      binaryFrame(180, true),
      width,
      height,
    );

    expect(ocrFrameDifference(baseline, noisy)).toBeLessThan(0.012);
    expect(ocrFrameDifference(baseline, changed)).toBeGreaterThanOrEqual(0.012);
  });

  it("detects a localized single-cell subtitle change below the global threshold", () => {
    const baseline = new Uint8Array(128);
    const oneCellChanged = baseline.slice();
    oneCellChanged[63] = 8;
    expect(ocrFrameDifference(baseline, oneCellChanged)).toBeLessThan(0.012);

    const deduplicator = new OcrFrameDeduplicator();
    expect(deduplicator.shouldRecognize(baseline)).toBe(true);
    expect(deduplicator.shouldRecognize(oneCellChanged)).toBe(true);
  });

  it("forces a bounded low-frequency OCR retry for fingerprint collisions", () => {
    const fingerprint = new Uint8Array(128).fill(80);
    const deduplicator = new OcrFrameDeduplicator();
    expect(deduplicator.shouldRecognize(fingerprint)).toBe(true);
    for (let skipped = 0; skipped < 7; skipped += 1) {
      expect(deduplicator.shouldRecognize(fingerprint)).toBe(false);
    }
    expect(deduplicator.shouldRecognize(fingerprint)).toBe(true);
  });

  it("does not misclassify thin white subtitles on black video as a black frame", () => {
    const width = 320;
    const height = 180;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
    for (let y = 159; y <= 165; y += 1) {
      for (let x = 90; x < 230; x += 1) {
        const index = (y * width + x) * 4;
        pixels[index] = 255;
        pixels[index + 1] = 255;
        pixels[index + 2] = 255;
      }
    }

    expect(analyzeOcrPixels(pixels, width, height).black).toBe(false);
  });

  it("stops with a protected-video message after bounded consecutive black captures", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = Array.from({ length: 11 }, () => 0);
    preparedOcrFrames.blackFrames = Array.from({ length: 11 }, () => true);
    preparedOcrFrames.mediaBlackFrames = Array.from({ length: 11 }, () => true);
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    let videoTime = 0;
    Object.defineProperties(video, {
      paused: { configurable: true, get: () => false },
      ended: { configurable: true, get: () => false },
      readyState: { configurable: true, get: () => 4 },
      currentTime: { configurable: true, get: () => videoTime },
    });
    document.body.append(video);
    const capture = vi.fn(() => {
      videoTime += 0.5;
      return Promise.resolve({
        ok: true as const,
        dataUrl: "data:image/png,x",
      });
    });
    const recognize = vi.fn(() => Promise.resolve("must not run"));
    const onStopped = vi.fn();
    const adapter = new OcrSubtitleAdapter();
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
      onStopped,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(capture).toHaveBeenCalledTimes(11);
    expect(recognize).not.toHaveBeenCalled();
    expect(session.getStatus()).toMatchObject({
      state: "unavailable",
      message: "ocrProtectedVideoUnsupported",
    });
    expect(onStopped).toHaveBeenCalledOnce();
    await expect(adapter.collect()).resolves.toBeNull();
    session.destroy();
  });

  it("keeps probing a black iframe instead of declaring DRM from pixels alone", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = Array.from({ length: 10 }, () => 0);
    preparedOcrFrames.blackFrames = Array.from({ length: 10 }, () => true);
    preparedOcrFrames.mediaBlackFrames = Array.from({ length: 10 }, () => true);
    const player = document.createElement("iframe");
    player.src = "https://vfiles.gtimg.cn/tvideo/libcocos-frame/player.html";
    player.getBoundingClientRect = () => new DOMRect(20, 30, 800, 450);
    document.body.append(player);
    const capture = vi.fn(() =>
      Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
    );
    const recognize = vi.fn(() => Promise.resolve("must not run"));
    const onStopped = vi.fn();
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
      onStopped,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(14_000);

    expect(capture).toHaveBeenCalledTimes(10);
    expect(recognize).not.toHaveBeenCalled();
    expect(session.getStatus()).toMatchObject({
      state: "active",
      message: "ocrBlackFrameWaiting",
    });
    expect(onStopped).not.toHaveBeenCalled();
    session.destroy();
  });

  it("stops an iframe when a previously visible player becomes persistently black", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [
      80,
      ...Array.from({ length: 11 }, () => 0),
    ];
    preparedOcrFrames.blackFrames = [
      false,
      ...Array.from({ length: 11 }, () => true),
    ];
    preparedOcrFrames.mediaBlackFrames = [
      false,
      // A tiny browser/extension surface can keep the low-resolution whole
      // media probe from being perfectly black. A stable black crop after a
      // previously visible iframe still supplies bounded protected-frame
      // evidence.
      ...Array.from({ length: 11 }, () => false),
    ];
    const player = document.createElement("iframe");
    player.src = "https://player.example.test/watch";
    player.getBoundingClientRect = () => new DOMRect(20, 30, 800, 450);
    document.body.append(player);
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve("Visible subtitle"),
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(session.getStatus()).toMatchObject({
      state: "unavailable",
      message: "ocrProtectedVideoUnsupported",
    });
    session.destroy();
  });

  it("treats a black subtitle strip over a visible video as empty instead of protected", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = Array.from({ length: 20 }, () => 0);
    preparedOcrFrames.blackFrames = Array.from({ length: 20 }, () => true);
    preparedOcrFrames.mediaBlackFrames = Array.from(
      { length: 20 },
      () => false,
    );
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const capture = vi.fn(() =>
      Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
    );
    const recognize = vi.fn(() => Promise.resolve("must not run"));
    const onStopped = vi.fn();
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
      onStopped,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(9_000);

    expect(capture).toHaveBeenCalledTimes(19);
    expect(recognize).not.toHaveBeenCalled();
    expect(session.getStatus()).toMatchObject({ state: "active" });
    expect(session.getStatus().message).not.toBe(
      "ocrProtectedVideoUnsupported",
    );
    expect(onStopped).not.toHaveBeenCalled();
    session.destroy();
  });

  it("limits sampling to at most 2 FPS and aborts the session", async () => {
    vi.useFakeTimers();
    const sampler = new OcrSampler(1_000);
    const task = vi.fn(() => Promise.resolve());
    const signal = sampler.start(task);
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    sampler.stop();
    expect(signal.aborted).toBe(true);
  });

  it("reports local OCR as unavailable without capturing or uploading", async () => {
    const capture = vi.fn();
    const adapter = new OcrSubtitleAdapter();
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture,
      engine: {
        availability: () => Promise.resolve("unavailable"),
        recognize: () => Promise.resolve(""),
      },
    });
    expect((await session.start()).state).toBe("unavailable");
    expect(capture).not.toHaveBeenCalled();
    expect(await adapter.collect()).toBeNull();
  });

  it("rejects OCR startup when an existing subtitle source is preferred", () => {
    const onStatus = vi.fn();
    const onStopped = vi.fn();
    const session = new OcrSession({
      enabled: true,
      adapter: new OcrSubtitleAdapter(),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve(""),
      },
      onStatus,
      onStopped,
    });

    expect(session.rejectStart("existing subtitles")).toMatchObject({
      state: "unavailable",
      recognized: 0,
      message: "existing subtitles",
    });
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "unavailable" }),
    );
    expect(onStopped).toHaveBeenCalledOnce();
  });

  it("normalizes local detector output and honors cancellation", async () => {
    expect(
      normalizeRecognizedText([
        { rawValue: " Hello   world " },
        { rawValue: "Hello world" },
        { rawValue: "你好" },
      ]),
    ).toBe("Hello world\n你好");
    expect(await new BrowserLocalOcrEngine().availability()).toBe(
      "unavailable",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      new BrowserLocalOcrEngine().recognize(
        {} as HTMLCanvasElement,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("loads a locally installed PP-OCR runtime and normalizes its output", async () => {
    const service = {
      initialize: vi.fn(() => Promise.resolve()),
      recognize: vi.fn(() =>
        Promise.resolve({
          text: " Hello   world \n你好\n你好\n",
          confidence: 0.87,
          lines: [],
        }),
      ),
      destroy: vi.fn(() => Promise.resolve()),
    };
    const loadRuntime = vi.fn(() =>
      Promise.resolve({
        pack: "zh" as const,
        detection: new ArrayBuffer(1),
        recognition: new ArrayBuffer(1),
        dictionary: new ArrayBuffer(1),
      }),
    );
    const engine = new PaddleOcrEngine({
      language: "chi_sim",
      loadRuntime,
      createService: () => service,
    });

    await engine.prepare?.(new AbortController().signal);
    await expect(
      engine.recognize(
        document.createElement("canvas"),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "Hello world\n你好", confidence: 87 });
    expect(loadRuntime).toHaveBeenCalledWith("chi_sim");
    expect(service.initialize).toHaveBeenCalledOnce();
    expect(service.recognize).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      { flatten: false, noCache: true, strategy: "per-line" },
    );
    await engine.destroy?.();
    expect(service.destroy).toHaveBeenCalledOnce();
  });

  it("keeps centered subtitle lines and rejects side player notices", async () => {
    const service = {
      initialize: vi.fn(() => Promise.resolve()),
      recognize: vi.fn(() =>
        Promise.resolve({
          text: "帮我贩私\n试看5分钟，会员免费观看本片",
          confidence: 0.92,
          lines: [
            [
              {
                text: "帮我贩私",
                confidence: 0.9,
                box: { x: 310, y: 90, width: 380, height: 42 },
              },
            ],
            [
              {
                text: "试看5分钟，会员免费观看本片",
                confidence: 0.97,
                box: { x: 760, y: 92, width: 230, height: 36 },
              },
            ],
          ],
        }),
      ),
      destroy: vi.fn(() => Promise.resolve()),
    };
    const engine = new PaddleOcrEngine({
      language: "chi_sim",
      loadRuntime: () =>
        Promise.resolve({
          pack: "zh",
          detection: new ArrayBuffer(1),
          recognition: new ArrayBuffer(1),
          dictionary: new ArrayBuffer(1),
        }),
      createService: () => service,
    });
    const canvas = document.createElement("canvas");
    canvas.width = 1_000;
    canvas.height = 220;

    await expect(
      engine.recognize(canvas, new AbortController().signal),
    ).resolves.toEqual({
      text: "帮我贩私",
      confidence: 90,
      boxes: [
        {
          text: "帮我贩私",
          x: 310,
          y: 90,
          width: 380,
          height: 42,
          confidence: 90,
        },
        {
          text: "试看5分钟，会员免费观看本片",
          x: 760,
          y: 92,
          width: 230,
          height: 36,
          confidence: 97,
        },
      ],
    });
    await engine.destroy?.();
  });

  it("keeps a single off-center subtitle in the manually selected region", async () => {
    const service = {
      initialize: vi.fn(() => Promise.resolve()),
      recognize: vi.fn(() =>
        Promise.resolve({
          text: "别停下来",
          confidence: 0.94,
          lines: [
            [
              {
                text: "别停下来",
                confidence: 0.94,
                box: { x: 40, y: 92, width: 180, height: 36 },
              },
            ],
          ],
        }),
      ),
      destroy: vi.fn(() => Promise.resolve()),
    };
    const engine = new PaddleOcrEngine({
      language: "chi_sim",
      loadRuntime: () =>
        Promise.resolve({
          pack: "zh",
          detection: new ArrayBuffer(1),
          recognition: new ArrayBuffer(1),
          dictionary: new ArrayBuffer(1),
        }),
      createService: () => service,
    });
    const canvas = document.createElement("canvas");
    canvas.width = 1_000;
    canvas.height = 220;

    await expect(
      engine.recognize(canvas, new AbortController().signal),
    ).resolves.toEqual({
      text: "别停下来",
      confidence: 94,
      boxes: [
        {
          text: "别停下来",
          x: 40,
          y: 92,
          width: 180,
          height: 36,
          confidence: 94,
        },
      ],
    });
    await engine.destroy?.();
  });

  it("keeps a tight two-line off-center subtitle cluster", async () => {
    const service = {
      initialize: vi.fn(() => Promise.resolve()),
      recognize: vi.fn(() =>
        Promise.resolve({
          text: "Keep moving\n不要停下来",
          confidence: 0.91,
          lines: [
            [
              {
                text: "Keep moving",
                confidence: 0.9,
                box: { x: 40, y: 72, width: 190, height: 34 },
              },
            ],
            [
              {
                text: "不要停下来",
                confidence: 0.92,
                box: { x: 55, y: 112, width: 180, height: 34 },
              },
            ],
          ],
        }),
      ),
      destroy: vi.fn(() => Promise.resolve()),
    };
    const engine = new PaddleOcrEngine({
      language: "chi_sim",
      loadRuntime: () =>
        Promise.resolve({
          pack: "zh",
          detection: new ArrayBuffer(1),
          recognition: new ArrayBuffer(1),
          dictionary: new ArrayBuffer(1),
        }),
      createService: () => service,
    });
    const canvas = document.createElement("canvas");
    canvas.width = 1_000;
    canvas.height = 220;

    await expect(
      engine.recognize(canvas, new AbortController().signal),
    ).resolves.toEqual({
      text: "Keep moving\n不要停下来",
      confidence: 90.625,
      boxes: [
        {
          text: "Keep moving",
          x: 40,
          y: 72,
          width: 190,
          height: 34,
          confidence: 90,
        },
        {
          text: "不要停下来",
          x: 55,
          y: 112,
          width: 180,
          height: 34,
          confidence: 92,
        },
      ],
    });
    await engine.destroy?.();
  });

  it("recreates the PP-OCR service after initialization fails", async () => {
    const failedService = {
      initialize: vi.fn(() => Promise.reject(new Error("init failed"))),
      recognize: vi.fn(),
      destroy: vi.fn(() => Promise.resolve()),
    };
    const workingService = {
      initialize: vi.fn(() => Promise.resolve()),
      recognize: vi.fn(() =>
        Promise.resolve({ text: "Recovered", confidence: 0.9, lines: [] }),
      ),
      destroy: vi.fn(() => Promise.resolve()),
    };
    const createService = vi
      .fn()
      .mockReturnValueOnce(failedService)
      .mockReturnValueOnce(workingService);
    const engine = new PaddleOcrEngine({
      language: "eng",
      loadRuntime: () =>
        Promise.resolve({
          pack: "latin",
          detection: new ArrayBuffer(1),
          recognition: new ArrayBuffer(1),
          dictionary: new ArrayBuffer(1),
        }),
      createService,
    });

    await expect(
      engine.prepare?.(new AbortController().signal),
    ).rejects.toThrow("init failed");
    await expect(
      engine.prepare?.(new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(createService).toHaveBeenCalledTimes(2);
    expect(failedService.destroy).toHaveBeenCalledOnce();
    await engine.destroy?.();
    expect(workingService.destroy).toHaveBeenCalledOnce();
  });

  it("turns recognized text into a bounded stream track for translation and overlay", async () => {
    const adapter = new OcrSubtitleAdapter();
    const listener = vi.fn();
    adapter.subscribe(listener);
    adapter.begin("zh-CN");
    expect(adapter.push("第一句", 1_000)).toBe(true);
    expect(adapter.push("第一句", 1_100)).toBe(false);
    expect(adapter.push("Second line", 2_000)).toBe(true);
    const track = await adapter.collect();
    expect(track).toMatchObject({
      source: "ocr",
      completeness: "stream",
      language: "zh-CN",
    });
    expect(track?.cues).toHaveLength(2);
    expect(track?.cues[0]).toMatchObject({
      endMs: 2_000,
      originalText: "第一句",
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(adapter.end(2_500)).toBe(true);
    expect((await adapter.collect())?.cues.at(-1)?.endMs).toBe(2_500);
    expect(adapter.end(2_600)).toBe(false);
    expect(adapter.push("Second line", 3_000)).toBe(true);
    expect((await adapter.collect())?.cues.at(-1)).toMatchObject({
      startMs: 3_000,
      endMs: null,
      originalText: "Second line",
    });
    expect(listener).toHaveBeenCalledTimes(4);
    adapter.stop();
    expect(await adapter.collect()).toBeNull();
  });

  it("stabilizes transient punctuation and single-character OCR jitter without swallowing a real next cue", async () => {
    const adapter = new OcrSubtitleAdapter();
    const listener = vi.fn();
    adapter.subscribe(listener);
    adapter.begin("en");

    expect(adapter.push("Hello world", 1_000)).toBe(true);
    expect(adapter.push("Hello world!", 1_800)).toBe(false);
    expect(adapter.push("Hello wor1d", 2_200)).toBe(false);
    expect(adapter.push("Hello world", 2_800)).toBe(false);
    expect(adapter.push("Goodbye world", 3_200)).toBe(true);

    expect(
      (await adapter.collect())?.cues.map((cue) => cue.originalText),
    ).toEqual(["Hello world", "Goodbye world"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("accepts a sustained one-character change after the bounded OCR stability window", async () => {
    const adapter = new OcrSubtitleAdapter();
    adapter.begin("en");
    expect(adapter.push("Order 12345", 1_000)).toBe(true);
    expect(adapter.push("Order 12346", 1_500)).toBe(false);
    expect(adapter.push("Order 12346", 3_000)).toBe(false);
    expect(adapter.push("Order 12346", 4_100)).toBe(true);

    expect(
      (await adapter.collect())?.cues.map((cue) => cue.originalText),
    ).toEqual(["Order 12345", "Order 12346"]);
  });

  it("publishes a complete, internally consistent retained window after cue trimming", async () => {
    const adapter = new OcrSubtitleAdapter();
    const snapshots: Array<
      NonNullable<Awaited<ReturnType<typeof adapter.collect>>>
    > = [];
    adapter.subscribe((track) => snapshots.push(track));
    adapter.begin("en");

    for (let index = 0; index < 125; index += 1) {
      expect(adapter.push(`cue ${index}`, index * 1_000)).toBe(true);
    }

    const track = await adapter.collect();
    expect(track?.cues).toHaveLength(120);
    expect(track?.cues[0]).toMatchObject({
      originalText: "cue 5",
      startMs: 5_000,
      endMs: 6_000,
    });
    expect(track?.cues.at(-1)).toMatchObject({
      originalText: "cue 124",
      startMs: 124_000,
      endMs: null,
    });
    expect(new Set(track?.cues.map((cue) => cue.id)).size).toBe(120);
    expect(snapshots.every((snapshot) => snapshot.cues.length <= 120)).toBe(
      true,
    );
    expect(snapshots.at(-1)).toEqual(track);
  });

  it("ends an active cue after bounded continuously changing empty OCR frames", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [0, 255, 0];
    const video = document.createElement("video");
    let videoTime = 0;
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => videoTime,
        set: (value: number) => {
          videoTime = value;
        },
      },
      currentSrc: { configurable: true, get: () => "https://example.com/a" },
    });
    video.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
        width: 640,
        height: 360,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) satisfies DOMRect;
    document.body.append(video);
    const capture = vi.fn(() => {
      videoTime += 1;
      return Promise.resolve({
        ok: true as const,
        dataUrl: "data:image/png,x",
      });
    });
    const recognize = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("Persistent subtitle")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    const adapter = new OcrSubtitleAdapter();
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture,
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(recognize).toHaveBeenCalledTimes(3);
    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({
        startMs: 0,
        endMs: 2_000,
        originalText: "Persistent subtitle",
      }),
    ]);
    session.destroy();
  });

  it("starts a fresh OCR timeline after seeking backward or changing currentSrc", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80, 80, 80, 80];
    const video = document.createElement("video");
    let videoTime = 10;
    let videoSource = "https://example.com/a.mp4";
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => videoTime,
        set: (value: number) => {
          videoTime = value;
        },
      },
      currentSrc: { configurable: true, get: () => videoSource },
    });
    video.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
        width: 640,
        height: 360,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) satisfies DOMRect;
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    const trackUpdated = vi.fn();
    const recognize = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("before seek")
      .mockResolvedValueOnce("after seek")
      .mockResolvedValueOnce("after forward seek")
      .mockResolvedValueOnce("after source change");
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize,
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
      onTrackUpdated: trackUpdated,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect((await adapter.collect())?.cues[0]?.originalText).toBe(
      "before seek",
    );

    videoTime = 9.9;
    await vi.advanceTimersByTimeAsync(500);
    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({
        startMs: 9_900,
        originalText: "after seek",
      }),
    ]);

    videoTime = 30;
    video.dispatchEvent(new Event("seeking"));
    await vi.advanceTimersByTimeAsync(500);
    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({
        startMs: 30_000,
        originalText: "after forward seek",
      }),
    ]);

    videoSource = "https://example.com/b.mp4";
    videoTime = 1;
    await vi.advanceTimersByTimeAsync(500);
    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({
        startMs: 1_000,
        originalText: "after source change",
      }),
    ]);
    expect(session.getStatus().recognized).toBe(1);
    expect(trackUpdated).toHaveBeenCalledTimes(8);
    session.destroy();
  });

  it("resets OCR cues when a reused video emits loadstart or emptied", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [81, 82, 83];
    const video = document.createElement("video");
    let videoTime = 10;
    Object.defineProperties(video, {
      currentTime: { configurable: true, get: () => videoTime },
      currentSrc: {
        configurable: true,
        get: () => "https://example.com/reused.mp4",
      },
    });
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: vi
          .fn<() => Promise<string>>()
          .mockResolvedValueOnce("before reload")
          .mockResolvedValueOnce("after loadstart")
          .mockResolvedValueOnce("after emptied"),
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect((await adapter.collect())?.cues.at(-1)?.originalText).toBe(
      "before reload",
    );

    videoTime = 0;
    video.dispatchEvent(new Event("loadstart"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({
        startMs: 0,
        originalText: "after loadstart",
      }),
    ]);

    videoTime = 5;
    video.dispatchEvent(new Event("emptied"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await adapter.collect())?.cues).toEqual([
      expect.objectContaining({
        startMs: 5_000,
        originalText: "after emptied",
      }),
    ]);
    session.destroy();
  });

  it("stops OCR when another player becomes active", async () => {
    vi.useFakeTimers();
    preparedOcrFrames.fingerprints = [80];
    const first = document.createElement("video");
    const second = document.createElement("video");
    first.getBoundingClientRect = second.getBoundingClientRect = () =>
      new DOMRect(0, 0, 640, 360);
    Object.defineProperty(first, "paused", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(second, "paused", {
      configurable: true,
      value: true,
    });
    document.body.append(first, second);
    const adapter = new OcrSubtitleAdapter();
    const session = new OcrSession({
      enabled: true,
      adapter,
      capture: () =>
        Promise.resolve({ ok: true as const, dataUrl: "data:image/png,x" }),
      engine: {
        availability: () => Promise.resolve("available"),
        recognize: () => Promise.resolve("First player subtitle"),
      },
      selector: {
        select: () => Promise.resolve({ x: 0, y: 0.7, width: 1, height: 0.3 }),
        destroy: vi.fn(),
      } as never,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    Object.defineProperty(first, "paused", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(second, "paused", {
      configurable: true,
      value: false,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(session.getStatus()).toMatchObject({
      state: "unavailable",
      message: "ocrVideoChanged",
    });
    await expect(adapter.collect()).resolves.toBeNull();
    session.destroy();
  });
});
