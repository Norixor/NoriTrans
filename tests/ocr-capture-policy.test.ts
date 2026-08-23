import {
  captureOcrDataUrl,
  type OcrCaptureFormat,
} from "@/src/ocr/capture-policy";
import { describe, expect, it, vi } from "vitest";

describe("OCR screenshot capture policy", () => {
  it("starts with JPEG quality 90 and stops when it fits", async () => {
    const capture = vi.fn(() => Promise.resolve("jpeg-small"));

    await expect(captureOcrDataUrl(capture, 20)).resolves.toBe("jpeg-small");
    expect(capture).toHaveBeenCalledWith({ format: "jpeg", quality: 90 });
    expect(capture).toHaveBeenCalledOnce();
  });

  it("reduces JPEG quality progressively until the screenshot fits", async () => {
    const sizes = new Map<string, number>([
      ["jpeg:90", 25],
      ["jpeg:75", 18],
    ]);
    const capture = vi.fn((format: OcrCaptureFormat) => {
      const key = `${format.format}${format.quality ? `:${format.quality}` : ""}`;
      return Promise.resolve("x".repeat(sizes.get(key) ?? 10));
    });

    await expect(captureOcrDataUrl(capture, 20)).resolves.toHaveLength(18);
    expect(capture.mock.calls.map(([format]) => format)).toEqual([
      { format: "jpeg", quality: 90 },
      { format: "jpeg", quality: 75 },
    ]);
  });

  it("returns the smallest attempted encoding for a bounded failure response", async () => {
    const capture = vi.fn((format: OcrCaptureFormat) =>
      Promise.resolve("x".repeat(format.quality ?? 100)),
    );

    await expect(captureOcrDataUrl(capture, 20)).resolves.toHaveLength(45);
    expect(capture.mock.calls.map(([format]) => format)).toEqual([
      { format: "jpeg", quality: 90 },
      { format: "jpeg", quality: 75 },
      { format: "jpeg", quality: 60 },
      { format: "jpeg", quality: 45 },
    ]);
  });
});
