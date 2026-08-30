import type { TranslationSegment } from "@/src/translation/types";
import type { BergamotLanguagePackId } from "@/src/local-translation/languages";
import type { LocalTranslationRuntimeInfo } from "@/src/local-translation/runtime-storage";

export const BERGAMOT_BACKGROUND_TARGET =
  "noritrans-bergamot-background" as const;
export const BERGAMOT_OFFSCREEN_TARGET =
  "noritrans-bergamot-offscreen" as const;
export const BERGAMOT_CLIENT_TARGET = "noritrans-bergamot-client" as const;

export const BERGAMOT_PACKAGE_LANGUAGES = [
  "es",
  "fr",
  "de",
  "ja",
  "ko",
  "zh-Hans",
  "zh-Hant",
] as const;

export type BergamotPackageLanguage =
  (typeof BERGAMOT_PACKAGE_LANGUAGES)[number];
export type BergamotLanguage = "en" | BergamotPackageLanguage;
export type BergamotArchitecture = "base" | "base-memory";
export type BergamotArtifactKind =
  "model" | "lex" | "vocab" | "srcvocab" | "trgvocab";

export interface BergamotArtifact {
  id: string;
  kind: BergamotArtifactKind;
  name: string;
  url: string;
  compressedBytes: number;
  compressedSha256: string;
  decompressedBytes: number;
  decompressedSha256: string;
}

export interface BergamotModelBundle {
  from: BergamotLanguage;
  to: BergamotLanguage;
  version: string;
  architecture: BergamotArchitecture;
  artifacts: readonly BergamotArtifact[];
}

export interface BergamotLanguagePackage {
  language: BergamotPackageLanguage;
  directions: readonly [BergamotModelBundle, BergamotModelBundle];
}

export type BergamotPackageState = "missing" | "installed" | "error";

export interface BergamotPackageInfo {
  language: BergamotPackageLanguage;
  state: BergamotPackageState;
  bytes?: number;
  installedAt?: number;
  versions?: readonly string[];
  message?: string;
}

export type BergamotInstallPhase =
  | "catalog"
  | "downloading"
  | "decompressing"
  | "verifying"
  | "storing"
  | "complete";

export interface BergamotInstallProgress {
  phase: BergamotInstallPhase;
  receivedBytes: number;
  totalBytes: number;
}

export type BergamotRuntimeErrorCode =
  | "bergamot_cancelled"
  | "bergamot_catalog_invalid"
  | "bergamot_catalog_unavailable"
  | "bergamot_integrity_failed"
  | "bergamot_invalid_request"
  | "bergamot_package_missing"
  | "bergamot_runtime_failed"
  | "bergamot_unsupported_language";

export interface BergamotRuntimeFailure {
  code: BergamotRuntimeErrorCode;
  message: string;
  retryable: boolean;
  details?: string;
}

interface BergamotEnvelope {
  target: typeof BERGAMOT_BACKGROUND_TARGET | typeof BERGAMOT_OFFSCREEN_TARGET;
  requestId: string;
}

export interface BergamotListRequest extends BergamotEnvelope {
  type: "BERGAMOT_OFFSCREEN_LIST";
}

export interface BergamotInstallRequest extends BergamotEnvelope {
  type: "BERGAMOT_OFFSCREEN_INSTALL";
  packId: BergamotLanguagePackId;
}

export interface BergamotDeleteRequest extends BergamotEnvelope {
  type: "BERGAMOT_OFFSCREEN_DELETE";
  packId: BergamotLanguagePackId;
}

export interface BergamotTranslateRequest extends BergamotEnvelope {
  type: "BERGAMOT_OFFSCREEN_TRANSLATE";
  sourceLanguage: BergamotLanguage;
  targetLanguage: BergamotLanguage;
  segments: Array<Pick<TranslationSegment, "id" | "text">>;
}

export interface BergamotCancelRequest extends BergamotEnvelope {
  type: "BERGAMOT_OFFSCREEN_CANCEL";
}

export interface BergamotResetRequest extends BergamotEnvelope {
  type: "BERGAMOT_OFFSCREEN_RESET";
}

export type BergamotOffscreenRequest =
  | BergamotListRequest
  | BergamotInstallRequest
  | BergamotDeleteRequest
  | BergamotTranslateRequest
  | BergamotCancelRequest
  | BergamotResetRequest;

export type BergamotResponseValue =
  | { runtimes: LocalTranslationRuntimeInfo[] }
  | { runtime: LocalTranslationRuntimeInfo }
  | { deleted: boolean }
  | { reset: true }
  | { translations: Array<{ id: string; translatedText: string }> };

export interface BergamotOffscreenResponse {
  target: typeof BERGAMOT_CLIENT_TARGET;
  type: "BERGAMOT_OFFSCREEN_RESPONSE";
  requestId: string;
  ok: boolean;
  value?: BergamotResponseValue;
  error?: BergamotRuntimeFailure;
}

export interface BergamotOffscreenProgress {
  target: typeof BERGAMOT_BACKGROUND_TARGET | typeof BERGAMOT_CLIENT_TARGET;
  type: "BERGAMOT_OFFSCREEN_PROGRESS";
  requestId: string;
  packId: BergamotLanguagePackId;
  progress: BergamotInstallProgress;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isBergamotRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 128 &&
    /^[a-zA-Z0-9._:-]+$/u.test(value)
  );
}

export function isBergamotPackageLanguage(
  value: unknown,
): value is BergamotPackageLanguage {
  return (BERGAMOT_PACKAGE_LANGUAGES as readonly unknown[]).includes(value);
}

export function normalizeBergamotLanguage(
  value: string,
): BergamotLanguage | undefined {
  const normalized = value.trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "es" || normalized.startsWith("es-")) return "es";
  if (normalized === "fr" || normalized.startsWith("fr-")) return "fr";
  if (normalized === "de" || normalized.startsWith("de-")) return "de";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
  if (
    normalized === "zh-tw" ||
    normalized === "zh-hk" ||
    normalized === "zh-mo" ||
    normalized === "zh-hant" ||
    normalized.startsWith("zh-hant-")
  ) {
    return "zh-Hant";
  }
  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-sg" ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-hans-")
  ) {
    return "zh-Hans";
  }
  return undefined;
}

function isTranslationSegment(
  value: unknown,
): value is { id: string; text: string } {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 256 &&
    typeof value.text === "string" &&
    value.text.length <= 8_000
  );
}

export function isBergamotOffscreenRequest(
  value: unknown,
  target: typeof BERGAMOT_BACKGROUND_TARGET | typeof BERGAMOT_OFFSCREEN_TARGET,
): value is BergamotOffscreenRequest {
  if (
    !isRecord(value) ||
    value.target !== target ||
    !isBergamotRequestId(value.requestId)
  ) {
    return false;
  }
  switch (value.type) {
    case "BERGAMOT_OFFSCREEN_LIST":
    case "BERGAMOT_OFFSCREEN_CANCEL":
    case "BERGAMOT_OFFSCREEN_RESET":
      return true;
    case "BERGAMOT_OFFSCREEN_INSTALL":
    case "BERGAMOT_OFFSCREEN_DELETE":
      return (
        typeof value.packId === "string" &&
        [
          "en-es",
          "es-en",
          "en-fr",
          "fr-en",
          "en-de",
          "de-en",
          "en-ja",
          "ja-en",
          "en-ko",
          "ko-en",
          "en-zh-Hans",
          "zh-Hans-en",
          "en-zh-Hant",
          "zh-Hant-en",
        ].includes(value.packId)
      );
    case "BERGAMOT_OFFSCREEN_TRANSLATE": {
      if (
        !isBergamotPackageLanguage(value.sourceLanguage) &&
        value.sourceLanguage !== "en"
      ) {
        return false;
      }
      if (
        !isBergamotPackageLanguage(value.targetLanguage) &&
        value.targetLanguage !== "en"
      ) {
        return false;
      }
      if (
        !Array.isArray(value.segments) ||
        value.segments.length === 0 ||
        value.segments.length > 20 ||
        !value.segments.every(isTranslationSegment)
      ) {
        return false;
      }
      const ids = new Set(value.segments.map((segment) => segment.id));
      const characters = value.segments.reduce(
        (total, segment) => total + segment.text.length,
        0,
      );
      return ids.size === value.segments.length && characters <= 16_000;
    }
    default:
      return false;
  }
}

function isRuntimeFailure(value: unknown): value is BergamotRuntimeFailure {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    value.code.startsWith("bergamot_") &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 240 &&
    typeof value.retryable === "boolean" &&
    (value.details === undefined ||
      (typeof value.details === "string" && value.details.length <= 500))
  );
}

export function isBergamotOffscreenResponse(
  value: unknown,
  requestId: string,
): value is BergamotOffscreenResponse {
  if (
    !isRecord(value) ||
    value.target !== BERGAMOT_CLIENT_TARGET ||
    value.type !== "BERGAMOT_OFFSCREEN_RESPONSE" ||
    value.requestId !== requestId ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  return value.ok
    ? isRecord(value.value) && value.error === undefined
    : value.value === undefined && isRuntimeFailure(value.error);
}

export function isBergamotOffscreenProgress(
  value: unknown,
  target:
    | typeof BERGAMOT_BACKGROUND_TARGET
    | typeof BERGAMOT_CLIENT_TARGET = BERGAMOT_CLIENT_TARGET,
): value is BergamotOffscreenProgress {
  if (
    !isRecord(value) ||
    value.target !== target ||
    value.type !== "BERGAMOT_OFFSCREEN_PROGRESS" ||
    !isBergamotRequestId(value.requestId) ||
    typeof value.packId !== "string" ||
    ![
      "en-es",
      "es-en",
      "en-fr",
      "fr-en",
      "en-de",
      "de-en",
      "en-ja",
      "ja-en",
      "en-ko",
      "ko-en",
      "en-zh-Hans",
      "zh-Hans-en",
      "en-zh-Hant",
      "zh-Hant-en",
    ].includes(value.packId) ||
    !isRecord(value.progress)
  ) {
    return false;
  }
  const { phase, receivedBytes, totalBytes } = value.progress;
  return (
    [
      "catalog",
      "downloading",
      "decompressing",
      "verifying",
      "storing",
      "complete",
    ].includes(String(phase)) &&
    typeof receivedBytes === "number" &&
    Number.isSafeInteger(receivedBytes) &&
    receivedBytes >= 0 &&
    typeof totalBytes === "number" &&
    Number.isSafeInteger(totalBytes) &&
    totalBytes >= receivedBytes
  );
}
