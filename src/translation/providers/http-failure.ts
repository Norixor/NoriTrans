import type { RuntimeErrorCode } from "@/src/shared/runtime-errors";
import type { TranslationFailure } from "@/src/translation/types";

export interface HttpFailureClassification {
  /** Contract code carried by `TranslationFailure.code`. */
  code: TranslationFailure["code"];
  /** Localizable runtime message token for the user-facing summary. */
  messageCode: RuntimeErrorCode;
  /** Stable machine-readable reason for callers that distinguish causes. */
  reason?: TranslationFailure["reason"];
  retryable: boolean;
}

/**
 * Maps a non-2xx Provider HTTP status to the shared failure contract. Rate
 * limiting and server errors keep the generic `request_failed` code but carry
 * distinct reasons and user messages, because "check your settings" is the
 * wrong advice for a throttled or temporarily failing Provider.
 */
export function httpFailureClassification(
  status: number,
): HttpFailureClassification {
  if (status === 401 || status === 403) {
    return {
      code: "invalid_configuration",
      messageCode: "invalid_configuration",
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      code: "request_failed",
      messageCode: "rate_limited",
      reason: "rate_limited",
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      code: "request_failed",
      messageCode: "provider_error",
      reason: "provider_server_error",
      retryable: true,
    };
  }
  return {
    code: "request_failed",
    messageCode: "request_failed",
    retryable: status === 408,
  };
}
