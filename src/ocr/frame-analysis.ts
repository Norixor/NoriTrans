const HASH_WIDTH = 16;
const HASH_HEIGHT = 8;
const MAX_BLACK_FRAME_SAMPLES = 4_096;
const SUBTITLE_FINGERPRINT_AMPLIFICATION = 4;
const SUBTITLE_FINGERPRINT_QUANTIZATION = 8;
const LOCAL_FINGERPRINT_CHANGE = SUBTITLE_FINGERPRINT_QUANTIZATION;
const FORCED_RECOGNITION_INTERVAL = 8;

export interface OcrFrameAnalysis {
  fingerprint: Uint8Array;
  black: boolean;
}

export function analyzeOcrPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): OcrFrameAnalysis {
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) {
    return { fingerprint: new Uint8Array(), black: true };
  }
  const fingerprint = new Uint8Array(HASH_WIDTH * HASH_HEIGHT);
  const luminanceAt = (x: number, y: number): number => {
    const index = (y * width + x) * 4;
    return Math.round(
      (pixels[index]! * 299 +
        pixels[index + 1]! * 587 +
        pixels[index + 2]! * 114) /
        1_000,
    );
  };
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_WIDTH; x += 1) {
      const sourceX = Math.min(
        width - 1,
        Math.floor(((x + 0.5) * width) / HASH_WIDTH),
      );
      const sourceY = Math.min(
        height - 1,
        Math.floor(((y + 0.5) * height) / HASH_HEIGHT),
      );
      fingerprint[y * HASH_WIDTH + x] = luminanceAt(sourceX, sourceY);
    }
  }

  // The perceptual hash is intentionally small for frame deduplication, but it
  // can miss thin white glyphs on black video. Protected-video detection uses
  // a denser bounded grid so legitimate black-background subtitles reach OCR.
  const sampleStep = Math.max(
    1,
    Math.floor(Math.sqrt((width * height) / MAX_BLACK_FRAME_SAMPLES)),
  );
  let minimum = 255;
  let maximum = 0;
  let total = 0;
  let samples = 0;
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const luminance = luminanceAt(x, y);
      minimum = Math.min(minimum, luminance);
      maximum = Math.max(maximum, luminance);
      total += luminance;
      samples += 1;
    }
  }
  const average = total / Math.max(1, samples);
  return {
    fingerprint,
    black: average < 7 && maximum - minimum < 14,
  };
}

export function ocrFrameDifference(
  previous: Uint8Array | undefined,
  current: Uint8Array,
): number {
  if (!previous || previous.length !== current.length || current.length === 0)
    return 1;
  let difference = 0;
  for (let index = 0; index < current.length; index += 1) {
    difference += Math.abs(current[index]! - previous[index]!);
  }
  return difference / current.length / 255;
}

export function ocrFingerprintChanged(
  previous: Uint8Array | undefined,
  current: Uint8Array,
  threshold = 0.012,
): boolean {
  if (!previous || previous.length !== current.length || current.length === 0)
    return true;
  let maximumCellDifference = 0;
  for (let index = 0; index < current.length; index += 1) {
    maximumCellDifference = Math.max(
      maximumCellDifference,
      Math.abs(current[index]! - previous[index]!),
    );
  }
  return (
    ocrFrameDifference(previous, current) >= threshold ||
    maximumCellDifference >= LOCAL_FINGERPRINT_CHANGE
  );
}

/**
 * Builds a text-mask fingerprint from the preprocessed black-on-white crop.
 *
 * A single luminance sample per cell is very sensitive to moving video pixels
 * and can also miss thin glyph strokes. Cell occupancy keeps subtitle strokes
 * spatially meaningful while averaging away isolated background noise. Sparse
 * text is amplified before bounded quantization so real cue changes still
 * cross the frame-deduplication threshold.
 */
export function ocrSubtitleFingerprint(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) {
    return new Uint8Array();
  }
  const fingerprint = new Uint8Array(HASH_WIDTH * HASH_HEIGHT);
  for (let cellY = 0; cellY < HASH_HEIGHT; cellY += 1) {
    const top = Math.floor((cellY * height) / HASH_HEIGHT);
    const bottom = Math.max(
      top + 1,
      Math.floor(((cellY + 1) * height) / HASH_HEIGHT),
    );
    for (let cellX = 0; cellX < HASH_WIDTH; cellX += 1) {
      const left = Math.floor((cellX * width) / HASH_WIDTH);
      const right = Math.max(
        left + 1,
        Math.floor(((cellX + 1) * width) / HASH_WIDTH),
      );
      let foreground = 0;
      let samples = 0;
      for (let y = top; y < Math.min(height, bottom); y += 1) {
        for (let x = left; x < Math.min(width, right); x += 1) {
          const index = (y * width + x) * 4;
          const luminance =
            (pixels[index]! * 299 +
              pixels[index + 1]! * 587 +
              pixels[index + 2]! * 114) /
            1_000;
          if (luminance < 128) foreground += 1;
          samples += 1;
        }
      }
      const amplified = Math.min(
        255,
        (foreground / Math.max(1, samples)) *
          255 *
          SUBTITLE_FINGERPRINT_AMPLIFICATION,
      );
      fingerprint[cellY * HASH_WIDTH + cellX] = Math.min(
        255,
        Math.round(amplified / SUBTITLE_FINGERPRINT_QUANTIZATION) *
          SUBTITLE_FINGERPRINT_QUANTIZATION,
      );
    }
  }
  return fingerprint;
}

export class OcrFrameDeduplicator {
  private recognized: Uint8Array | undefined;
  private skippedFrames = 0;

  constructor(private readonly threshold = 0.012) {}

  shouldRecognize(fingerprint: Uint8Array): boolean {
    if (
      !this.recognized ||
      this.recognized.length !== fingerprint.length ||
      fingerprint.length === 0
    ) {
      this.recognized = fingerprint.slice();
      this.skippedFrames = 0;
      return true;
    }
    this.skippedFrames += 1;
    const changed =
      ocrFingerprintChanged(this.recognized, fingerprint, this.threshold) ||
      this.skippedFrames >= FORCED_RECOGNITION_INTERVAL;
    if (changed) {
      this.recognized = fingerprint.slice();
      this.skippedFrames = 0;
    }
    return changed;
  }

  reset(): void {
    this.recognized = undefined;
    this.skippedFrames = 0;
  }
}
