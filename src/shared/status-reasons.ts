import { NoriTransError } from "@/src/shared/errors";
import { runtimeErrorCode } from "@/src/shared/runtime-errors";

/**
 * Stable, machine-readable reason codes carried by `PageStatus.reasonCode`
 * and `SubtitleStatus.reasonCode`.
 *
 * Failure reasons reuse the existing vocabularies verbatim: a
 * `TranslationFailure.reason` / `NoriTransError.reason` (for example
 * `rate_limited`, `request_timeout`, `provider_server_error`), a runtime error
 * token code (for example `page_content_changed`) or a
 * `TranslationFailure.code` (for example `invalid_configuration`). The
 * constants below only name states that have no error object behind them.
 * Consumers must treat any other well-formed value as an unknown reason
 * rather than guessing its meaning.
 */
export const STATUS_REASON = {
  /** A child frame whose permissions policy blocks the local Translator API. */
  frameTranslatorBlocked: "local_translator_frame_blocked",
  /** Subtitle discovery ended without a readable track. */
  subtitleNoTrack: "subtitle_no_track",
  /** No video element is available for subtitle translation. */
  subtitleNoVideo: "subtitle_no_video",
  /** A track exists but differs from the configured subtitle source language. */
  sourceLanguageMismatch: "source_language_mismatch",
  /** Only displayed cues are readable, so the AI mode fell back to fast. */
  streamFallback: "stream_fallback",
  /** As `streamFallback`, but reloading the page may expose the full track. */
  streamFallbackRefresh: "stream_fallback_refresh",
  /** OCR text was recognized but the local translator could not prepare. */
  ocrLocalTranslationUnavailable: "ocr_local_translation_unavailable",
  /** The OCR capture area stayed black, which usually means protected video. */
  ocrProtectedVideo: "ocr_protected_video",
  /** The browser does not let extensions read this page (internal pages). */
  restrictedPage: "restricted_page",
} as const;

const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

/** Accepts only short snake_case identifiers so a code never carries text. */
export function isStatusReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_PATTERN.test(value);
}

function failureFields(
  value: unknown,
): { code?: unknown; reason?: unknown; message?: unknown } | undefined {
  if (value instanceof NoriTransError) {
    return { code: value.code, reason: value.reason, message: value.message };
  }
  if (typeof value === "object" && value !== null && "code" in value) {
    const record = value as Record<string, unknown>;
    return {
      code: record.code,
      reason: record.reason,
      message: record.message,
    };
  }
  return undefined;
}

/**
 * Derives the status reason code for a failure: the specific Provider reason
 * first, then the runtime token behind the message (which distinguishes, for
 * example, rate limiting from a generic request failure), then the contract
 * code. Returns undefined when nothing machine-readable is available, so the
 * caller never invents a cause.
 */
export function failureReasonCode(value: unknown): string | undefined {
  const fields = failureFields(value);
  if (fields) {
    if (isStatusReasonCode(fields.reason)) return fields.reason;
    const tokenCode = runtimeErrorCode(fields.message);
    if (tokenCode) return tokenCode;
    return isStatusReasonCode(fields.code) ? fields.code : undefined;
  }
  return runtimeErrorCode(value);
}
