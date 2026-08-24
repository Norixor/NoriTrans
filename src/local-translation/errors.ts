import type {
  BergamotRuntimeErrorCode,
  BergamotRuntimeFailure,
} from "@/src/local-translation/types";

const MAX_MESSAGE_LENGTH = 240;
const MAX_DETAILS_LENGTH = 500;

export class BergamotRuntimeError extends Error {
  constructor(
    readonly code: BergamotRuntimeErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details?: string,
  ) {
    super(message.slice(0, MAX_MESSAGE_LENGTH));
    this.name = "BergamotRuntimeError";
  }

  toFailure(): BergamotRuntimeFailure {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details
        ? { details: this.details.slice(0, MAX_DETAILS_LENGTH) }
        : {}),
    };
  }
}

export function bergamotFailure(error: unknown): BergamotRuntimeFailure {
  if (error instanceof BergamotRuntimeError) return error.toFailure();
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new BergamotRuntimeError(
      "bergamot_cancelled",
      "Bergamot operation was cancelled.",
      true,
    ).toFailure();
  }
  return new BergamotRuntimeError(
    "bergamot_runtime_failed",
    "Bergamot local translation failed.",
    true,
    `Failure=${error instanceof Error ? error.name : "unknown"}.`,
  ).toFailure();
}
