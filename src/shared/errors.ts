export class NorixorTransError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
    readonly details?: string,
  ) {
    super(message);
    this.name = "NorixorTransError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
