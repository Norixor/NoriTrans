export type TranslationMode = "fast" | "ai";
export type TranslationResponseMode = "stream" | "batch";
export type TranslationTextFormat = "plain-text-v1" | "protected-text-v1";

export type ProviderRuntime = "background" | "document";

/** One independently validated translation unit with an ID stable for the task. */
export interface TranslationSegment {
  id: string;
  text: string;
  /** Wire format the renderer must restore after translation. */
  format?: TranslationTextFormat;
  /** Read-only neighboring text supplied for consistency, not for translation. */
  contextBefore?: string[];
  contextAfter?: string[];
}

/** Provider-neutral request shared by page, subtitle, and image pipelines. */
export interface TranslationRequest {
  sourceLanguage: string;
  targetLanguage: string;
  mode: TranslationMode;
  responseMode?: TranslationResponseMode;
  segments: TranslationSegment[];
  /** Optional page or media title used only as translation context. */
  mediaTitle?: string;
  prompt?: string;
  scope?: string;
  /** Optional per-surface AI model; omitted or blank inherits global settings. */
  modelOverride?: string;
}

/** A successful result whose ID must match exactly one requested segment. */
export interface TranslationResult {
  id: string;
  translatedText: string;
}

/** Hard limits and execution constraints used by the shared scheduler. */
export interface ProviderCapabilities {
  maxBatchCharacters: number;
  maxBatchSegments: number;
  supportsContext: boolean;
  runtime: ProviderRuntime;
}

export type TranslationProgressCallback = (
  result: TranslationResult,
) => void | Promise<void>;

export interface TranslationProvider {
  readonly id: string;
  readonly mode: TranslationMode;
  readonly capabilities: ProviderCapabilities;
  /**
   * Returns exactly one validated result per requested segment. Implementations
   * must stop or invalidate work when `signal` aborts and may report completed
   * IDs through `onProgress` before the final array is available.
   */
  translateBatch(
    request: TranslationRequest,
    signal: AbortSignal,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]>;
}

/** Safe, bounded failure information suitable for crossing extension contexts. */
export interface TranslationFailure {
  code:
    | "provider_unavailable"
    | "permission_required"
    | "invalid_configuration"
    | "invalid_response"
    | "request_failed"
    | "cancelled";
  message: string;
  /** Whether retrying the same request without configuration changes is useful. */
  retryable: boolean;
  /** Bounded structural diagnostics; never raw provider bodies or source text. */
  details?: string;
}
