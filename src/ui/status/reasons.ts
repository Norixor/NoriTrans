import { STATUS_REASON } from "@/src/shared/status-reasons";
import type {
  LocalizedText,
  StatusActionId,
  StatusMessageKey,
} from "@/src/ui/status/types";

/**
 * How a reason steers the actions: `settings` reasons need the user to fix
 * the Provider configuration before a retry can help.
 */
export type ReasonRemedy = "settings" | "retry" | "none";

interface ReasonEntry {
  key: StatusMessageKey;
  remedy: ReasonRemedy;
  /** Action that resolves an `unavailable` state caused by this reason. */
  unavailableAction?: StatusActionId;
}

/**
 * One sentence per known reason code (README §2.3). Codes come verbatim from
 * `TranslationFailure.reason`, runtime error tokens, `TranslationFailure.code`
 * and `STATUS_REASON`; anything else is reported as unknown with its code.
 */
const REASONS: Readonly<Record<string, ReasonEntry>> = {
  rate_limited: { key: "statusReasonRateLimited", remedy: "retry" },
  request_timeout: { key: "statusReasonTimeout", remedy: "retry" },
  provider_server_error: { key: "statusReasonServerError", remedy: "retry" },
  provider_error: { key: "statusReasonServerError", remedy: "retry" },
  network_error: { key: "statusReasonNetworkError", remedy: "retry" },
  invalid_response: { key: "statusReasonInvalidResponse", remedy: "retry" },
  request_failed: { key: "statusReasonRequestFailed", remedy: "retry" },
  invalid_configuration: {
    key: "statusReasonInvalidConfiguration",
    remedy: "settings",
    unavailableAction: "openProviderSettings",
  },
  permission_required: {
    key: "statusReasonPermissionRequired",
    remedy: "settings",
    unavailableAction: "openProviderSettings",
  },
  provider_unavailable: {
    key: "statusReasonProviderUnavailable",
    remedy: "settings",
    unavailableAction: "openProviderSettings",
  },
  chrome_pair_unavailable: {
    key: "statusReasonLanguagePairUnsupported",
    remedy: "settings",
    unavailableAction: "openProviderSettings",
  },
  bergamot_unsupported_language: {
    key: "statusReasonLanguagePairUnsupported",
    remedy: "settings",
    unavailableAction: "openProviderSettings",
  },
  chrome_language_detection_failed: {
    key: "statusReasonLanguageDetectionFailed",
    remedy: "settings",
    unavailableAction: "openProviderSettings",
  },
  bergamot_package_missing: {
    key: "statusReasonLocalModelMissing",
    remedy: "settings",
    unavailableAction: "openProviderSettings",
  },
  content_settings_unavailable: {
    key: "statusReasonSettingsUnavailable",
    remedy: "retry",
  },
  page_content_changed: { key: "statusReasonPageChanged", remedy: "retry" },
  [STATUS_REASON.restrictedPage]: {
    key: "statusReasonRestrictedPage",
    remedy: "none",
  },
  [STATUS_REASON.frameTranslatorBlocked]: {
    key: "statusReasonRestrictedPage",
    remedy: "none",
  },
  [STATUS_REASON.subtitleNoTrack]: {
    key: "statusReasonNoTrack",
    remedy: "none",
    unavailableAction: "tryOcr",
  },
  [STATUS_REASON.subtitleNoVideo]: {
    key: "statusReasonNoVideo",
    remedy: "none",
  },
  [STATUS_REASON.sourceLanguageMismatch]: {
    key: "statusReasonLanguageMismatch",
    remedy: "none",
    unavailableAction: "useAutoDetect",
  },
  [STATUS_REASON.streamFallback]: {
    key: "statusReasonStreamFallback",
    remedy: "none",
  },
  [STATUS_REASON.streamFallbackRefresh]: {
    key: "statusReasonStreamFallbackRefresh",
    remedy: "none",
  },
  [STATUS_REASON.ocrLocalTranslationUnavailable]: {
    key: "statusReasonOcrTranslationUnavailable",
    remedy: "none",
  },
  [STATUS_REASON.ocrProtectedVideo]: {
    key: "statusReasonOcrProtectedVideo",
    remedy: "none",
  },
};

/** Codes that describe the stream track itself rather than a failure. */
export function isStreamReasonCode(code: string | undefined): boolean {
  return (
    code === STATUS_REASON.streamFallback ||
    code === STATUS_REASON.streamFallbackRefresh
  );
}

export function isKnownReasonCode(code: string): boolean {
  return Object.hasOwn(REASONS, code);
}

export interface ResolvedReason {
  text: LocalizedText;
  remedy: ReasonRemedy;
  unavailableAction?: StatusActionId;
}

/**
 * Maps a reason code to its sentence. An unknown code yields the generic
 * sentence carrying the code as a diagnostic identifier, and a missing code
 * yields the "no specific reason" sentence; neither guesses a cause.
 */
export function resolveReason(code: string | undefined): ResolvedReason {
  if (code === undefined) {
    return {
      text: { key: "statusReasonUnspecified", substitutions: [] },
      remedy: "retry",
    };
  }
  const entry = Object.hasOwn(REASONS, code) ? REASONS[code] : undefined;
  if (!entry) {
    return {
      text: { key: "statusReasonUnknown", substitutions: [code] },
      remedy: "retry",
    };
  }
  return {
    text: { key: entry.key, substitutions: [] },
    remedy: entry.remedy,
    ...(entry.unavailableAction
      ? { unavailableAction: entry.unavailableAction }
      : {}),
  };
}
