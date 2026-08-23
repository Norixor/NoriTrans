import type {
  LocalOcrEngine,
  OcrEngineProgress,
  OcrRecognition,
} from "@/src/ocr/engine";
import type { OcrRuntimeLanguage } from "@/src/ocr/languages";
import {
  loadRuntime,
  type LoadedOcrRuntimePack,
} from "@/src/ocr/runtime-storage";
import * as ort from "onnxruntime-web";
import {
  PaddleOcrService,
  type PaddleOcrResult,
  type RecognitionOptions,
} from "ppu-paddle-ocr/web";
import { browser } from "wxt/browser";
import type { OcrTextBox } from "@/src/ocr/types";

interface PaddleOcrServiceLike {
  initialize(): Promise<void>;
  recognize(
    source: HTMLCanvasElement,
    options: { flatten?: false; noCache?: boolean; strategy?: "per-line" },
  ): Promise<PaddleOcrResult>;
  destroy(): Promise<void>;
}

interface SpatialRecognitionLine {
  text: string;
  centerX: number;
  centerY: number;
  height: number;
  confidence: number;
}

export interface PaddleOcrEngineOptions {
  language: OcrRuntimeLanguage;
  loadRuntime?: (language: OcrRuntimeLanguage) => Promise<LoadedOcrRuntimePack>;
  createService?: (runtime: LoadedOcrRuntimePack) => PaddleOcrServiceLike;
  runtimeUrl?: (path: string) => string;
}

function abortError(): Error {
  const error = new Error("OCR cancelled.");
  error.name = "AbortError";
  return error;
}

function normalizeOcrText(text: string): string {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.replace(/[ \t]+/gu, " ").trim())
    .filter((line, index, values) => line && line !== values[index - 1]);
  const normalized = lines.join("\n").trim().slice(0, 2_000);
  return /[\p{L}\p{N}]/u.test(normalized) ? normalized : "";
}

/**
 * Subtitle regions are intentionally wider than most subtitle lines so users
 * do not have to draw a pixel-perfect box. Prefer the centered one/two-line
 * cluster and discard player badges or notices detected along either edge.
 */
function centeredSubtitleRecognition(
  result: PaddleOcrResult,
  sourceWidth: number,
  sourceHeight: number,
): { text: string; confidence: number } | null {
  if (sourceWidth <= 0 || sourceHeight <= 0 || result.lines.length === 0) {
    return null;
  }
  const lines: SpatialRecognitionLine[] = result.lines.flatMap((items) => {
    const usable = items.filter((item) => item.text.trim());
    if (usable.length === 0) return [];
    const left = Math.min(...usable.map((item) => item.box.x));
    const top = Math.min(...usable.map((item) => item.box.y));
    const right = Math.max(
      ...usable.map((item) => item.box.x + item.box.width),
    );
    const bottom = Math.max(
      ...usable.map((item) => item.box.y + item.box.height),
    );
    const text = usable
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join(" ");
    const weight = usable.reduce(
      (total, item) => total + Math.max(1, item.text.trim().length),
      0,
    );
    const confidence =
      usable.reduce(
        (total, item) =>
          total + item.confidence * Math.max(1, item.text.trim().length),
        0,
      ) / weight;
    return [
      {
        text,
        centerX: (left + right) / 2,
        centerY: (top + bottom) / 2,
        height: bottom - top,
        confidence,
      },
    ];
  });
  const centered = lines.filter(
    (line) => Math.abs(line.centerX / sourceWidth - 0.5) <= 0.3,
  );
  const anchorPool = centered.length > 0 ? centered : lines;
  const anchor = anchorPool.reduce((best, line) => {
    const bestDistance = Math.abs(best.centerX / sourceWidth - 0.5);
    const distance = Math.abs(line.centerX / sourceWidth - 0.5);
    if (distance !== bestDistance) return distance < bestDistance ? line : best;
    return line.confidence > best.confidence ? line : best;
  });
  const verticalTolerance = Math.max(anchor.height * 2.4, sourceHeight * 0.18);
  if (
    centered.length === 0 &&
    (lines.length > 2 ||
      lines.some(
        (line) =>
          Math.abs(line.centerX - anchor.centerX) > sourceWidth * 0.3 ||
          Math.abs(line.centerY - anchor.centerY) > verticalTolerance,
      ))
  ) {
    return { text: "", confidence: 0 };
  }
  const selected = anchorPool
    .filter(
      (line) => Math.abs(line.centerY - anchor.centerY) <= verticalTolerance,
    )
    .sort(
      (left, right) =>
        Math.abs(left.centerY - anchor.centerY) -
        Math.abs(right.centerY - anchor.centerY),
    )
    .slice(0, 2)
    .sort((left, right) => left.centerY - right.centerY);
  const totalWeight = selected.reduce(
    (total, line) => total + Math.max(1, line.text.length),
    0,
  );
  return {
    text: selected.map((line) => line.text).join("\n"),
    confidence:
      selected.reduce(
        (total, line) =>
          total + line.confidence * Math.max(1, line.text.length),
        0,
      ) / totalWeight,
  };
}

/** PP-OCRv5 executor hosted exclusively by the extension Offscreen Document. */
export class PaddleOcrEngine implements LocalOcrEngine {
  private readonly language: OcrRuntimeLanguage;
  private readonly loadRuntimeImpl: (
    language: OcrRuntimeLanguage,
  ) => Promise<LoadedOcrRuntimePack>;
  private readonly createServiceImpl: (
    runtime: LoadedOcrRuntimePack,
  ) => PaddleOcrServiceLike;
  private readonly runtimeUrl: (path: string) => string;
  private service: PaddleOcrServiceLike | undefined;
  private servicePromise: Promise<PaddleOcrServiceLike> | undefined;
  private generation = 0;

  constructor(options: PaddleOcrEngineOptions) {
    this.language = options.language;
    this.loadRuntimeImpl = options.loadRuntime ?? loadRuntime;
    this.runtimeUrl =
      options.runtimeUrl ?? ((path) => browser.runtime.getURL(path as never));
    this.createServiceImpl =
      options.createService ?? ((runtime) => this.createService(runtime));
  }

  availability(): Promise<"available" | "unavailable"> {
    return Promise.resolve("available");
  }

  async prepare(
    signal: AbortSignal,
    onProgress?: (progress: OcrEngineProgress) => void,
  ): Promise<void> {
    await this.serviceFor(signal, onProgress);
  }

  async recognize(
    source: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<OcrRecognition> {
    const service = await this.serviceFor(signal);
    const result = await this.abortable(
      service.recognize(source, {
        flatten: false,
        noCache: true,
        strategy: "per-line",
      }),
      signal,
    );
    const centered = centeredSubtitleRecognition(
      result,
      source.width,
      source.height,
    );
    const boxes: OcrTextBox[] = result.lines
      .flatMap((line) => line)
      .filter((item) => item.text.trim())
      .slice(0, 80)
      .map((item) => ({
        text: normalizeOcrText(item.text).slice(0, 500),
        x: Math.max(0, item.box.x),
        y: Math.max(0, item.box.y),
        width: Math.max(0, item.box.width),
        height: Math.max(0, item.box.height),
        confidence: Math.min(100, Math.max(0, item.confidence * 100)),
      }))
      .filter((item) => item.text && item.width > 0 && item.height > 0);
    return {
      text: normalizeOcrText(centered?.text ?? result.text),
      confidence: Math.min(
        100,
        Math.max(0, (centered?.confidence ?? result.confidence) * 100),
      ),
      ...(boxes.length > 0 ? { boxes } : {}),
    };
  }

  async destroy(): Promise<void> {
    this.generation += 1;
    const service = this.service;
    this.service = undefined;
    this.servicePromise = undefined;
    await service?.destroy().catch(() => undefined);
  }

  private createService(runtime: LoadedOcrRuntimePack): PaddleOcrServiceLike {
    ort.env.wasm.wasmPaths = this.runtimeUrl("ocr/ort/");
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 1)
      : 1;
    ort.env.logLevel = "error";
    return new PaddleOcrService({
      model: {
        detection: runtime.detection,
        recognition: runtime.recognition,
        charactersDictionary: runtime.dictionary,
      },
      detection: { maxSideLength: 1_280 },
      recognition: {
        strategy: "per-line",
      } as RecognitionOptions,
      processing: { engine: "canvas-native" },
      session: { logSeverityLevel: 3 },
    });
  }

  private async serviceFor(
    signal: AbortSignal,
    onProgress?: (progress: OcrEngineProgress) => void,
  ): Promise<PaddleOcrServiceLike> {
    if (signal.aborted) throw abortError();
    if (this.service) return this.service;
    if (!this.servicePromise) {
      const generation = this.generation;
      const promise = (async (): Promise<PaddleOcrServiceLike> => {
        onProgress?.({ progress: 0.05, status: "loading_runtime" });
        const runtime = await this.loadRuntimeImpl(this.language);
        if (generation !== this.generation) throw abortError();
        onProgress?.({ progress: 0.2, status: "initializing_ppocr" });
        const service = this.createServiceImpl(runtime);
        try {
          await service.initialize();
          if (generation !== this.generation) throw abortError();
          this.service = service;
          onProgress?.({ progress: 1, status: "ready" });
          return service;
        } catch (error) {
          await service.destroy().catch(() => undefined);
          throw error;
        }
      })();
      this.servicePromise = promise;
    }
    const pending = this.servicePromise;
    try {
      return await this.abortable(pending, signal);
    } finally {
      if (this.servicePromise === pending) this.servicePromise = undefined;
    }
  }

  private async abortable<T>(
    promise: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) throw abortError();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const abort = (): void => {
        if (settled) return;
        settled = true;
        reject(abortError());
      };
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
