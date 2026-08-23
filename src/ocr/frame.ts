import {
  analyzeOcrPixels,
  ocrSubtitleFingerprint,
  type OcrFrameAnalysis,
} from "@/src/ocr/frame-analysis";
import type { NormalizedOcrRegion } from "@/src/ocr/types";
import { preprocessOcrPixels } from "@/src/ocr/preprocess";

const MAX_CAPTURE_DATA_URL_LENGTH = 12_000_000;
// PP-OCR detection cost grows with input area. A 960x360 ceiling preserves a
// useful subtitle glyph height while bounding each inference to 345,600 pixels
// (44% below the former reachable 1280x480 maximum).
const MAX_CROP_WIDTH = 960;
const MAX_CROP_HEIGHT = 360;
const MAX_CROP_PIXELS = 345_600;
const MAX_MEDIA_PROBE_WIDTH = 192;
const MAX_MEDIA_PROBE_HEIGHT = 108;

export interface PreparedOcrFrame extends OcrFrameAnalysis {
  canvas: HTMLCanvasElement;
  /** Original-color PP-OCR input; thresholded canvas remains a rare fallback. */
  originalCanvas?: HTMLCanvasElement;
  /** Whole visible media probe used to distinguish DRM black frames from black subtitle bars. */
  mediaBlack?: boolean;
  /** Low-resolution whole-media fingerprint used to detect iframe/canvas motion. */
  mediaFingerprint?: Uint8Array;
}

function analyzeImageRegion(
  image: HTMLImageElement,
  region: NormalizedOcrRegion,
): OcrFrameAnalysis | undefined {
  const sourceX = Math.max(0, Math.floor(region.x * image.naturalWidth));
  const sourceY = Math.max(0, Math.floor(region.y * image.naturalHeight));
  const sourceWidth = Math.min(
    image.naturalWidth - sourceX,
    Math.max(1, Math.ceil(region.width * image.naturalWidth)),
  );
  const sourceHeight = Math.min(
    image.naturalHeight - sourceY,
    Math.max(1, Math.ceil(region.height * image.naturalHeight)),
  );
  if (sourceWidth <= 0 || sourceHeight <= 0) return undefined;

  const scale = Math.min(
    1,
    MAX_MEDIA_PROBE_WIDTH / sourceWidth,
    MAX_MEDIA_PROBE_HEIGHT / sourceHeight,
  );
  const probe = document.createElement("canvas");
  probe.width = Math.max(1, Math.floor(sourceWidth * scale));
  probe.height = Math.max(1, Math.floor(sourceHeight * scale));
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    probe.width,
    probe.height,
  );
  const imageData = context.getImageData(0, 0, probe.width, probe.height);
  const analysis = analyzeOcrPixels(imageData.data, probe.width, probe.height);
  probe.width = 1;
  probe.height = 1;
  return analysis;
}

function waitForImage(
  image: HTMLImageElement,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      cleanup();
      reject(new DOMException("OCR cancelled.", "AbortError"));
    };
    image.onload = () => {
      cleanup();
      resolve();
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("capture_decode_failed"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function prepareOcrFrame(
  dataUrl: string,
  region: NormalizedOcrRegion,
  signal: AbortSignal,
  mediaRegion?: NormalizedOcrRegion,
): Promise<PreparedOcrFrame> {
  if (
    !dataUrl.startsWith("data:image/") ||
    dataUrl.length > MAX_CAPTURE_DATA_URL_LENGTH
  ) {
    throw new Error("capture_invalid");
  }
  const image = new Image();
  const loaded = waitForImage(image, signal);
  image.src = dataUrl;
  await loaded;
  if (signal.aborted) throw new DOMException("OCR cancelled.", "AbortError");

  const rawX = Math.floor(region.x * image.naturalWidth);
  const rawY = Math.floor(region.y * image.naturalHeight);
  const rawWidth = Math.max(1, Math.ceil(region.width * image.naturalWidth));
  const rawHeight = Math.max(1, Math.ceil(region.height * image.naturalHeight));
  const padding = Math.max(2, Math.min(4, Math.round(rawHeight * 0.02)));
  const sourceX = Math.max(0, rawX - padding);
  const sourceY = Math.max(0, rawY - padding);
  const sourceWidth = Math.min(
    image.naturalWidth - sourceX,
    rawWidth + (rawX - sourceX) + padding,
  );
  const sourceHeight = Math.min(
    image.naturalHeight - sourceY,
    rawHeight + (rawY - sourceY) + padding,
  );
  const preferredScale =
    sourceHeight < 180 ? Math.min(3, 180 / sourceHeight) : 1;
  const scale = Math.min(
    preferredScale,
    MAX_CROP_WIDTH / sourceWidth,
    MAX_CROP_HEIGHT / sourceHeight,
    Math.sqrt(MAX_CROP_PIXELS / (sourceWidth * sourceHeight)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(sourceWidth * scale));
  canvas.height = Math.max(1, Math.floor(sourceHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("canvas_unavailable");
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const originalCanvas = document.createElement("canvas");
  originalCanvas.width = canvas.width;
  originalCanvas.height = canvas.height;
  originalCanvas.getContext("2d")?.drawImage(canvas, 0, 0);
  canvas.dataset.ocrVariant = "binary";
  originalCanvas.dataset.ocrVariant = "original";
  const originalAnalysis = analyzeOcrPixels(
    imageData.data,
    canvas.width,
    canvas.height,
  );
  const mediaAnalysis = mediaRegion
    ? analyzeImageRegion(image, mediaRegion)
    : undefined;
  const preprocessed = preprocessOcrPixels(
    imageData.data,
    canvas.width,
    canvas.height,
  );
  imageData.data.set(preprocessed.pixels);
  context.putImageData(imageData, 0, 0);
  const fingerprint = ocrSubtitleFingerprint(
    imageData.data,
    canvas.width,
    canvas.height,
  );
  return {
    canvas,
    originalCanvas,
    fingerprint,
    black: originalAnalysis.black,
    ...(mediaAnalysis === undefined
      ? {}
      : {
          mediaBlack: mediaAnalysis.black,
          mediaFingerprint: mediaAnalysis.fingerprint,
        }),
  };
}
