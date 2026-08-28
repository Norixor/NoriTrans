export class NTransError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
    readonly details?: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "NTransError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
