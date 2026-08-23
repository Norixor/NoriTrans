export interface NormalizedOcrRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OcrStatusState =
  | "disabled"
  | "idle"
  | "selecting"
  | "initializing"
  | "capturing"
  | "recognizing"
  | "active"
  | "cancelled"
  | "unavailable"
  | "error";

export interface OcrStatus {
  state: OcrStatusState;
  message?: string;
  recognized: number;
  progress?: number;
  /** Current capture box normalized against the visible viewport. */
  region?: NormalizedOcrRegion;
}

export interface OcrCaptureResponse {
  ok: boolean;
  dataUrl?: string;
  message?: string;
  error?:
    | "inactive_tab"
    | "permission_required"
    | "rate_limited"
    | "capture_failed"
    | "capture_too_large";
}

export const OCR_BACKGROUND_TARGET = "norixortrans-ocr-background";
export const OCR_OFFSCREEN_TARGET = "norixortrans-ocr-offscreen";
export const OCR_CLIENT_TARGET = "norixortrans-ocr-client";
/** Content sampling and background capture gate share the same 2 FPS ceiling. */
export const OCR_SAMPLE_INTERVAL_MS = 500;

export const OCR_MAX_IMAGE_DATA_URL_LENGTH = 4_500_000;
export const OCR_MAX_IMAGE_WIDTH = 1_280;
export const OCR_MAX_IMAGE_HEIGHT = 480;
export const OCR_MAX_IMAGE_PIXELS = 800_000;

export interface OcrPrepareRequest {
  target: typeof OCR_BACKGROUND_TARGET | typeof OCR_OFFSCREEN_TARGET;
  type: "OCR_OFFSCREEN_PREPARE";
  sessionId: string;
  requestId: string;
  sourceLanguage?: string;
}

export interface OcrRecognizeRequest {
  target: typeof OCR_BACKGROUND_TARGET | typeof OCR_OFFSCREEN_TARGET;
  type: "OCR_OFFSCREEN_RECOGNIZE";
  sessionId: string;
  requestId: string;
  image: {
    dataUrl: string;
    width: number;
    height: number;
  };
}

export interface OcrCancelRequest {
  target: typeof OCR_BACKGROUND_TARGET | typeof OCR_OFFSCREEN_TARGET;
  type: "OCR_OFFSCREEN_CANCEL";
  sessionId: string;
  requestId: string;
}

export interface OcrEndSessionRequest {
  target: typeof OCR_BACKGROUND_TARGET | typeof OCR_OFFSCREEN_TARGET;
  type: "OCR_OFFSCREEN_END_SESSION";
  sessionId: string;
  requestId: string;
}

export interface OcrRuntimeInvalidateRequest {
  target: typeof OCR_BACKGROUND_TARGET | typeof OCR_OFFSCREEN_TARGET;
  type: "OCR_OFFSCREEN_RUNTIME_INVALIDATE";
  sessionId: string;
  requestId: string;
  language:
    "eng" | "chi_sim" | "chi_tra" | "jpn" | "kor" | "spa" | "fra" | "deu";
}

export type OcrOffscreenRequest =
  | OcrPrepareRequest
  | OcrRecognizeRequest
  | OcrCancelRequest
  | OcrEndSessionRequest
  | OcrRuntimeInvalidateRequest;

export interface OcrOffscreenResponse {
  target: typeof OCR_CLIENT_TARGET;
  type: "OCR_OFFSCREEN_RESPONSE";
  sessionId: string;
  requestId: string;
  ok: boolean;
  text?: string;
  confidence?: number;
  boxes?: OcrTextBox[];
  error?: string;
}

export interface OcrTextBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
}

export interface OcrOffscreenProgress {
  target: typeof OCR_BACKGROUND_TARGET | typeof OCR_CLIENT_TARGET;
  type: "OCR_OFFSCREEN_PROGRESS";
  sessionId: string;
  requestId: string;
  progress: number;
  status: string;
}

export interface OcrCaptureRequest {
  target: typeof OCR_BACKGROUND_TARGET;
  type: "OCR_CAPTURE_FRAME";
  sessionId: string;
  requestId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isOcrIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 128 &&
    /^[a-zA-Z0-9._:-]+$/u.test(value)
  );
}

function isSupportedOcrImageDataUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > OCR_MAX_IMAGE_DATA_URL_LENGTH
  ) {
    return false;
  }
  const prefix = value.startsWith("data:image/png;base64,")
    ? "data:image/png;base64,"
    : value.startsWith("data:image/jpeg;base64,")
      ? "data:image/jpeg;base64,"
      : "";
  if (!prefix) return false;
  const encoded = value.slice(prefix.length);
  return (
    encoded.length > 0 &&
    encoded.length % 4 === 0 &&
    /^[a-zA-Z0-9+/]+={0,2}$/u.test(encoded)
  );
}

function hasValidEnvelope(value: Record<string, unknown>): boolean {
  return isOcrIdentifier(value.sessionId) && isOcrIdentifier(value.requestId);
}

export function isOcrOffscreenRequest(
  value: unknown,
  target: typeof OCR_BACKGROUND_TARGET | typeof OCR_OFFSCREEN_TARGET,
): value is OcrOffscreenRequest {
  if (!isRecord(value) || value.target !== target || !hasValidEnvelope(value))
    return false;
  switch (value.type) {
    case "OCR_OFFSCREEN_PREPARE":
      return (
        value.sourceLanguage === undefined ||
        (typeof value.sourceLanguage === "string" &&
          value.sourceLanguage.length > 0 &&
          value.sourceLanguage.length <= 64)
      );
    case "OCR_OFFSCREEN_CANCEL":
    case "OCR_OFFSCREEN_END_SESSION":
      return true;
    case "OCR_OFFSCREEN_RUNTIME_INVALIDATE":
      return [
        "eng",
        "chi_sim",
        "chi_tra",
        "jpn",
        "kor",
        "spa",
        "fra",
        "deu",
      ].includes(String(value.language));
    case "OCR_OFFSCREEN_RECOGNIZE": {
      if (!isRecord(value.image)) return false;
      const { width, height, dataUrl } = value.image;
      return (
        typeof width === "number" &&
        Number.isInteger(width) &&
        width > 0 &&
        width <= OCR_MAX_IMAGE_WIDTH &&
        typeof height === "number" &&
        Number.isInteger(height) &&
        height > 0 &&
        height <= OCR_MAX_IMAGE_HEIGHT &&
        width * height <= OCR_MAX_IMAGE_PIXELS &&
        isSupportedOcrImageDataUrl(dataUrl)
      );
    }
    default:
      return false;
  }
}

export function isOcrCaptureRequest(
  value: unknown,
): value is OcrCaptureRequest {
  return (
    isRecord(value) &&
    value.target === OCR_BACKGROUND_TARGET &&
    value.type === "OCR_CAPTURE_FRAME" &&
    hasValidEnvelope(value)
  );
}

export function shouldRejectMalformedOcrBackgroundMessage(
  value: unknown,
): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if ("target" in value && value.target !== OCR_BACKGROUND_TARGET) return false;
  return (
    value.type === "OCR_CAPTURE_FRAME" ||
    value.type.startsWith("OCR_OFFSCREEN_")
  );
}

export function isOcrOffscreenResponse(
  value: unknown,
  sessionId: string,
  requestId: string,
): value is OcrOffscreenResponse {
  if (
    !isRecord(value) ||
    value.target !== OCR_CLIENT_TARGET ||
    value.type !== "OCR_OFFSCREEN_RESPONSE" ||
    value.sessionId !== sessionId ||
    value.requestId !== requestId ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  return value.ok
    ? (value.text === undefined ||
        (typeof value.text === "string" && value.text.length <= 2_000)) &&
        (value.confidence === undefined ||
          (typeof value.confidence === "number" &&
            Number.isFinite(value.confidence) &&
            value.confidence >= 0 &&
            value.confidence <= 100)) &&
        (value.boxes === undefined ||
          (Array.isArray(value.boxes) &&
            value.boxes.length <= 80 &&
            value.boxes.every(
              (box) =>
                isRecord(box) &&
                typeof box.text === "string" &&
                box.text.length > 0 &&
                box.text.length <= 500 &&
                [box.x, box.y, box.width, box.height].every(
                  (part) =>
                    typeof part === "number" &&
                    Number.isFinite(part) &&
                    part >= 0,
                ) &&
                (box.confidence === undefined ||
                  (typeof box.confidence === "number" &&
                    Number.isFinite(box.confidence) &&
                    box.confidence >= 0 &&
                    box.confidence <= 100)),
            )))
    : typeof value.error === "string" && value.error.length <= 240;
}

export function isOcrOffscreenProgress(
  value: unknown,
  target:
    typeof OCR_BACKGROUND_TARGET | typeof OCR_CLIENT_TARGET = OCR_CLIENT_TARGET,
): value is OcrOffscreenProgress {
  return (
    isRecord(value) &&
    value.target === target &&
    value.type === "OCR_OFFSCREEN_PROGRESS" &&
    isOcrIdentifier(value.sessionId) &&
    isOcrIdentifier(value.requestId) &&
    typeof value.progress === "number" &&
    Number.isFinite(value.progress) &&
    value.progress >= 0 &&
    value.progress <= 1 &&
    typeof value.status === "string" &&
    value.status.length <= 120
  );
}
