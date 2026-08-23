import { preprocessOcrPixels } from "@/src/ocr/preprocess";
import { describe, expect, it } from "vitest";

function fixture(
  width: number,
  height: number,
  background: (x: number, y: number) => number,
  foreground: {
    value: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
  },
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside =
        x >= foreground.left &&
        x < foreground.right &&
        y >= foreground.top &&
        y < foreground.bottom;
      const value = inside ? foreground.value : background(x, y);
      const index = (y * width + x) * 4;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

describe("OCR local preprocessing", () => {
  it("isolates light subtitle strokes from a moving gradient background", () => {
    const width = 160;
    const height = 60;
    const result = preprocessOcrPixels(
      fixture(
        width,
        height,
        (x, y) => 45 + Math.round(x * 0.55) + ((x + y) % 7),
        { value: 250, left: 48, top: 25, right: 112, bottom: 35 },
      ),
      width,
      height,
    );

    expect(result.mode).toBe("adaptive-light");
    expect(result.foregroundRatio).toBeGreaterThan(0.02);
    expect(result.foregroundRatio).toBeLessThan(0.2);
    expect(result.pixels[(30 * width + 80) * 4]).toBe(0);
    expect(result.pixels[(5 * width + 5) * 4]).toBe(255);
  });

  it("isolates dark subtitle strokes on a bright textured background", () => {
    const width = 160;
    const height = 60;
    const result = preprocessOcrPixels(
      fixture(width, height, (x, y) => 205 + ((x * 3 + y * 5) % 18), {
        value: 18,
        left: 50,
        top: 27,
        right: 110,
        bottom: 33,
      }),
      width,
      height,
    );

    expect(result.mode).toBe("adaptive-dark");
    expect(result.pixels[(30 * width + 80) * 4]).toBe(0);
    expect(result.pixels[(5 * width + 5) * 4]).toBe(255);
  });

  it("keeps a black-white empty fallback for flat frames without subtitle strokes", () => {
    const width = 80;
    const height = 40;
    const pixels = fixture(width, height, () => 128, {
      value: 128,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    });
    const result = preprocessOcrPixels(pixels, width, height);

    expect(result.mode).toBe("empty");
    expect(result.foregroundRatio).toBe(0);
    expect(result.pixels).toHaveLength(width * height * 4);
    expect(new Set(result.pixels)).toEqual(new Set([255]));
  });
});
