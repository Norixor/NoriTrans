export const OCR_CAPTURE_MAX_DATA_URL_LENGTH = 12_000_000;

const JPEG_QUALITY_STEPS = [90, 75, 60, 45] as const;

export interface OcrCaptureFormat {
  format: "png" | "jpeg";
  quality?: number;
}

/** Progressively reduces screenshot encoding cost before giving up. */
export async function captureOcrDataUrl(
  capture: (format: OcrCaptureFormat) => Promise<string>,
  maximumLength = OCR_CAPTURE_MAX_DATA_URL_LENGTH,
): Promise<string> {
  let dataUrl = "";
  for (const quality of JPEG_QUALITY_STEPS) {
    dataUrl = await capture({ format: "jpeg", quality });
    if (dataUrl.length <= maximumLength) return dataUrl;
  }
  return dataUrl;
}
