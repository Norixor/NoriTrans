export type OcrPreprocessMode =
  "adaptive-light" | "adaptive-dark" | "global-light" | "global-dark" | "empty";

export interface OcrPreprocessResult {
  pixels: Uint8ClampedArray;
  mode: OcrPreprocessMode;
  foregroundRatio: number;
}

const MIN_FOREGROUND_RATIO = 0.002;
const MAX_FOREGROUND_RATIO = 0.32;

function luminanceAt(pixels: Uint8ClampedArray, index: number): number {
  return Math.round(
    pixels[index]! * 0.299 +
      pixels[index + 1]! * 0.587 +
      pixels[index + 2]! * 0.114,
  );
}

function localMean(
  integral: Float64Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): number {
  const stride = width + 1;
  const left = Math.max(0, x - radius);
  const top = Math.max(0, y - radius);
  const right = Math.min(width, x + radius + 1);
  const bottom = Math.min(height, y + radius + 1);
  const total =
    integral[bottom * stride + right]! -
    integral[top * stride + right]! -
    integral[bottom * stride + left]! +
    integral[top * stride + left]!;
  return total / Math.max(1, (right - left) * (bottom - top));
}

function retainConnectedPixels(
  mask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const filtered = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index] === 0) continue;
      let neighbors = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nextY = y + offsetY;
        if (nextY < 0 || nextY >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = x + offsetX;
          if (nextX < 0 || nextX >= width) continue;
          if (mask[nextY * width + nextX] !== 0) neighbors += 1;
        }
      }
      if (neighbors >= 2) filtered[index] = 1;
    }
  }
  return filtered;
}

function foregroundRatio(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) count += value;
  return count / Math.max(1, mask.length);
}

function foregroundContrast(
  mask: Uint8Array,
  differences: Float32Array,
): number {
  let total = 0;
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) continue;
    total += Math.abs(differences[index]!);
    count += 1;
  }
  return total / Math.max(1, count);
}

function binaryPixels(mask: Uint8Array): Uint8ClampedArray {
  const output = new Uint8ClampedArray(mask.length * 4);
  for (let index = 0; index < mask.length; index += 1) {
    const value = mask[index] === 1 ? 0 : 255;
    const pixel = index * 4;
    output[pixel] = value;
    output[pixel + 1] = value;
    output[pixel + 2] = value;
    output[pixel + 3] = 255;
  }
  return output;
}

function percentile(luminances: Uint8Array, target: number): number {
  const histogram = new Uint32Array(256);
  for (const luminance of luminances) {
    histogram[luminance] = (histogram[luminance] ?? 0) + 1;
  }
  const wanted = Math.max(1, Math.ceil(luminances.length * target));
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value]!;
    if (seen >= wanted) return value;
  }
  return 255;
}

function globalExtremeMask(
  luminances: Uint8Array,
  width: number,
  height: number,
  average: number,
): { mask: Uint8Array; mode: "global-light" | "global-dark" } {
  const useLight = average < 150;
  const threshold = percentile(luminances, useLight ? 0.9 : 0.1);
  const mask = new Uint8Array(luminances.length);
  for (let index = 0; index < luminances.length; index += 1) {
    if (
      (useLight && luminances[index]! >= threshold) ||
      (!useLight && luminances[index]! <= threshold)
    ) {
      mask[index] = 1;
    }
  }
  return {
    mask: retainConnectedPixels(mask, width, height),
    mode: useLight ? "global-light" : "global-dark",
  };
}

/**
 * Builds one local binary foreground mask when subtitle-like light or dark
 * strokes are sparse enough; otherwise it uses a black-white extreme mask.
 */
export function preprocessOcrPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): OcrPreprocessResult {
  const pixelCount = width * height;
  if (width <= 0 || height <= 0 || pixels.length < pixelCount * 4) {
    return {
      pixels: new Uint8ClampedArray(),
      mode: "empty",
      foregroundRatio: 0,
    };
  }

  const luminances = new Uint8Array(pixelCount);
  let total = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const luminance = luminanceAt(pixels, index * 4);
    luminances[index] = luminance;
    total += luminance;
  }
  const average = total / pixelCount;
  let variance = 0;
  for (const luminance of luminances) variance += (luminance - average) ** 2;
  const deviation = Math.sqrt(variance / pixelCount);
  if (deviation < 8) {
    return {
      pixels: binaryPixels(new Uint8Array(pixelCount)),
      mode: "empty",
      foregroundRatio: 0,
    };
  }

  const stride = width + 1;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += luminances[y * width + x]!;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1]! + row;
    }
  }

  const radius = Math.max(6, Math.min(24, Math.round(height / 18)));
  const threshold = Math.max(18, Math.min(36, deviation * 0.38));
  const light = new Uint8Array(pixelCount);
  const dark = new Uint8Array(pixelCount);
  const differences = new Float32Array(pixelCount);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const difference =
        luminances[index]! - localMean(integral, width, height, x, y, radius);
      differences[index] = difference;
      if (difference >= threshold) light[index] = 1;
      if (difference <= -threshold) dark[index] = 1;
    }
  }

  const connectedLight = retainConnectedPixels(light, width, height);
  const connectedDark = retainConnectedPixels(dark, width, height);
  const lightRatio = foregroundRatio(connectedLight);
  const darkRatio = foregroundRatio(connectedDark);
  const lightContrast = foregroundContrast(connectedLight, differences);
  const darkContrast = foregroundContrast(connectedDark, differences);
  const validLight =
    lightRatio >= MIN_FOREGROUND_RATIO && lightRatio <= MAX_FOREGROUND_RATIO;
  const validDark =
    darkRatio >= MIN_FOREGROUND_RATIO && darkRatio <= MAX_FOREGROUND_RATIO;
  if (!validLight && !validDark) {
    const global = globalExtremeMask(luminances, width, height, average);
    return {
      pixels: binaryPixels(global.mask),
      mode: global.mode,
      foregroundRatio: foregroundRatio(global.mask),
    };
  }

  const useLight =
    validLight && (!validDark || lightContrast >= darkContrast * 0.9);
  const mask = useLight ? connectedLight : connectedDark;
  const ratio = useLight ? lightRatio : darkRatio;
  return {
    pixels: binaryPixels(mask),
    mode: useLight ? "adaptive-light" : "adaptive-dark",
    foregroundRatio: ratio,
  };
}
