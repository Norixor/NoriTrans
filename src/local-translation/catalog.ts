import { BergamotRuntimeError } from "@/src/local-translation/errors";
import pinnedModels from "@/src/local-translation/pinned-models.json";
import {
  BERGAMOT_PACKAGE_LANGUAGES,
  type BergamotArchitecture,
  type BergamotArtifact,
  type BergamotArtifactKind,
  type BergamotLanguage,
  type BergamotLanguagePackage,
  type BergamotModelBundle,
  type BergamotPackageLanguage,
} from "@/src/local-translation/types";

export const BERGAMOT_REMOTE_SETTINGS_URL =
  "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/records" as const;
export const BERGAMOT_ATTACHMENTS_BASE_URL =
  "https://firefox-settings-attachments.cdn.mozilla.net/" as const;

const MAX_CATALOG_RECORDS = 2_000;
const CATALOG_TIMEOUT_MS = 30_000;
const MAX_COMPRESSED_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_DECOMPRESSED_ARTIFACT_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^(\d+)\.(\d+)(?:\.(\d+))?(?:([ab])(\d+))?$/u;
const ATTACHMENT_LOCATION_PATTERN =
  /^main-workspace\/translations-models-v2\/[a-zA-Z0-9._/-]+\.zst$/u;
const PINNED_MODEL_BASE_URL =
  "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/models/" as const;
const ARTIFACT_KINDS = new Set<BergamotArtifactKind>([
  "model",
  "lex",
  "vocab",
  "srcvocab",
  "trgvocab",
]);

interface CatalogRecord {
  sourceLanguage: BergamotLanguage;
  targetLanguage: BergamotLanguage;
  version: string;
  architecture: BergamotArchitecture;
  platform: "all" | "desktop";
  artifact: BergamotArtifact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function catalogError(details: string): BergamotRuntimeError {
  return new BergamotRuntimeError(
    "bergamot_catalog_invalid",
    "Mozilla translation model catalog is invalid.",
    false,
    details,
  );
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw catalogError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function supportedLanguage(value: unknown): BergamotLanguage | undefined {
  if (value === "en") return "en";
  return (BERGAMOT_PACKAGE_LANGUAGES as readonly unknown[]).includes(value)
    ? (value as BergamotPackageLanguage)
    : undefined;
}

function isSupportedPair(
  source: BergamotLanguage,
  target: BergamotLanguage,
): boolean {
  return source !== target && (source === "en" || target === "en");
}

function parseCatalogRecord(
  value: unknown,
  index: number,
): CatalogRecord | undefined {
  if (!isRecord(value)) throw catalogError(`Record ${index} is not an object.`);
  const sourceLanguage = supportedLanguage(value.sourceLanguage);
  const targetLanguage = supportedLanguage(value.targetLanguage);
  if (!sourceLanguage || !targetLanguage) return undefined;
  if (!isSupportedPair(sourceLanguage, targetLanguage)) return undefined;
  const platform =
    value.filter_expression === ""
      ? "all"
      : value.filter_expression === "env.appinfo.OS != 'Android'"
        ? "desktop"
        : undefined;
  if (!platform) return undefined;
  if (value.architecture !== "base" && value.architecture !== "base-memory") {
    return undefined;
  }
  if (
    typeof value.version !== "string" ||
    !VERSION_PATTERN.test(value.version)
  ) {
    throw catalogError(`Record ${index} has an invalid version.`);
  }
  if (
    typeof value.fileType !== "string" ||
    !ARTIFACT_KINDS.has(value.fileType as BergamotArtifactKind)
  ) {
    return undefined;
  }
  if (
    typeof value.id !== "string" ||
    value.id.length < 8 ||
    value.id.length > 128 ||
    !/^[a-zA-Z0-9-]+$/u.test(value.id)
  ) {
    throw catalogError(`Record ${index} has an invalid id.`);
  }
  if (
    typeof value.name !== "string" ||
    value.name.length < 3 ||
    value.name.length > 160 ||
    !/^[a-zA-Z0-9._-]+$/u.test(value.name)
  ) {
    throw catalogError(`Record ${index} has an invalid artifact name.`);
  }
  if (
    typeof value.decompressedHash !== "string" ||
    !SHA256_PATTERN.test(value.decompressedHash)
  ) {
    throw catalogError(`Record ${index} has an invalid decompressed hash.`);
  }
  const decompressedBytes = positiveSafeInteger(
    value.decompressedSize,
    `Record ${index} decompressed size`,
  );
  if (decompressedBytes > MAX_DECOMPRESSED_ARTIFACT_BYTES) {
    throw catalogError(`Record ${index} decompressed size exceeds the limit.`);
  }
  if (!isRecord(value.attachment)) {
    throw catalogError(`Record ${index} has no attachment object.`);
  }
  const attachment = value.attachment;
  if (
    typeof attachment.hash !== "string" ||
    !SHA256_PATTERN.test(attachment.hash)
  ) {
    throw catalogError(`Record ${index} has an invalid attachment hash.`);
  }
  const compressedBytes = positiveSafeInteger(
    attachment.size,
    `Record ${index} attachment size`,
  );
  if (compressedBytes > MAX_COMPRESSED_ARTIFACT_BYTES) {
    throw catalogError(`Record ${index} attachment size exceeds the limit.`);
  }
  if (
    attachment.mimetype !== "application/zstd" ||
    typeof attachment.filename !== "string" ||
    !attachment.filename.endsWith(".zst") ||
    typeof attachment.location !== "string" ||
    attachment.location.includes("..") ||
    !ATTACHMENT_LOCATION_PATTERN.test(attachment.location)
  ) {
    throw catalogError(`Record ${index} has an invalid attachment location.`);
  }
  positiveSafeInteger(value.schema, `Record ${index} schema`);
  positiveSafeInteger(value.last_modified, `Record ${index} last_modified`);

  return {
    sourceLanguage,
    targetLanguage,
    version: value.version,
    architecture: value.architecture,
    platform,
    artifact: Object.freeze({
      id: value.id,
      kind: value.fileType as BergamotArtifactKind,
      name: value.name,
      url: new URL(
        attachment.location,
        BERGAMOT_ATTACHMENTS_BASE_URL,
      ).toString(),
      compressedBytes,
      compressedSha256: attachment.hash,
      decompressedBytes,
      decompressedSha256: value.decompressedHash,
    }),
  };
}

interface ParsedVersion {
  numbers: readonly [number, number, number];
  prereleaseRank: number;
  prereleaseNumber: number;
}

function parseVersion(value: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw catalogError(`Invalid model version ${value}.`);
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)],
    prereleaseRank: match[4] === undefined ? 2 : match[4] === "b" ? 1 : 0,
    prereleaseNumber: Number(match[5] ?? 0),
  };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.numbers.length; index += 1) {
    const delta = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return (
    a.prereleaseRank - b.prereleaseRank ||
    a.prereleaseNumber - b.prereleaseNumber
  );
}

function completeBundle(
  records: readonly CatalogRecord[],
): BergamotModelBundle | undefined {
  const first = records[0];
  if (!first) return undefined;
  const byKind = new Map<BergamotArtifactKind, BergamotArtifact>();
  for (const record of records) {
    if (byKind.has(record.artifact.kind)) return undefined;
    byKind.set(record.artifact.kind, record.artifact);
  }
  const hasSharedVocab = byKind.has("vocab");
  const hasSeparateVocabs = byKind.has("srcvocab") && byKind.has("trgvocab");
  if (
    !byKind.has("model") ||
    !byKind.has("lex") ||
    hasSharedVocab === hasSeparateVocabs
  ) {
    return undefined;
  }
  const kinds: BergamotArtifactKind[] = hasSharedVocab
    ? ["model", "lex", "vocab"]
    : ["model", "lex", "srcvocab", "trgvocab"];
  return Object.freeze({
    from: first.sourceLanguage,
    to: first.targetLanguage,
    version: first.version,
    architecture: first.architecture,
    artifacts: Object.freeze(
      kinds.map((kind) => {
        const artifact = byKind.get(kind);
        if (!artifact)
          throw catalogError(
            `Incomplete ${first.sourceLanguage}->${first.targetLanguage} bundle.`,
          );
        return artifact;
      }),
    ),
  });
}

function selectDirection(
  records: readonly CatalogRecord[],
  from: BergamotLanguage,
  to: BergamotLanguage,
): BergamotModelBundle | undefined {
  const grouped = new Map<string, CatalogRecord[]>();
  for (const record of records) {
    if (record.sourceLanguage !== from || record.targetLanguage !== to)
      continue;
    const key = `${record.version}\u0000${record.architecture}\u0000${record.platform}`;
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .flatMap((group) => {
      const bundle = completeBundle(group);
      const platform = group[0]?.platform;
      return bundle && platform ? [{ bundle, platform }] : [];
    })
    .sort(
      (left, right) =>
        compareVersions(right.bundle.version, left.bundle.version) ||
        Number(right.bundle.architecture === "base-memory") -
          Number(left.bundle.architecture === "base-memory") ||
        Number(right.platform === "desktop") -
          Number(left.platform === "desktop"),
    )[0]?.bundle;
}

export function parseBergamotCatalog(
  value: unknown,
): Map<BergamotPackageLanguage, BergamotLanguagePackage> {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw catalogError("Catalog response must contain a data array.");
  }
  if (value.data.length === 0 || value.data.length > MAX_CATALOG_RECORDS) {
    throw catalogError(`Catalog record count=${value.data.length}.`);
  }
  const records = value.data.flatMap((record, index) => {
    const parsed = parseCatalogRecord(record, index);
    return parsed ? [parsed] : [];
  });
  const packages = new Map<BergamotPackageLanguage, BergamotLanguagePackage>();
  for (const language of BERGAMOT_PACKAGE_LANGUAGES) {
    const outbound = selectDirection(records, "en", language);
    const inbound = selectDirection(records, language, "en");
    if (!outbound || !inbound) continue;
    const directions: readonly [BergamotModelBundle, BergamotModelBundle] = [
      outbound,
      inbound,
    ];
    packages.set(
      language,
      Object.freeze({
        language,
        directions: Object.freeze(directions),
      }),
    );
  }
  return packages;
}

function parsePinnedArtifact(
  value: unknown,
  bundleIndex: number,
  artifactIndex: number,
): BergamotArtifact {
  if (!isRecord(value)) {
    throw catalogError(
      `Pinned bundle ${bundleIndex} artifact ${artifactIndex} is not an object.`,
    );
  }
  if (
    typeof value.id !== "string" ||
    !/^gcs-[0-9a-f]{32}$/u.test(value.id) ||
    typeof value.kind !== "string" ||
    !ARTIFACT_KINDS.has(value.kind as BergamotArtifactKind) ||
    typeof value.name !== "string" ||
    !value.name.endsWith(".gz") ||
    typeof value.url !== "string" ||
    !value.url.startsWith(PINNED_MODEL_BASE_URL) ||
    !value.url.endsWith(".gz") ||
    typeof value.compressedSha256 !== "string" ||
    !SHA256_PATTERN.test(value.compressedSha256) ||
    typeof value.decompressedSha256 !== "string" ||
    !SHA256_PATTERN.test(value.decompressedSha256)
  ) {
    throw catalogError(
      `Pinned bundle ${bundleIndex} artifact ${artifactIndex} is invalid.`,
    );
  }
  const url = new URL(value.url);
  if (url.username || url.password || url.search || url.hash) {
    throw catalogError(
      `Pinned bundle ${bundleIndex} artifact ${artifactIndex} URL is invalid.`,
    );
  }
  const compressedBytes = positiveSafeInteger(
    value.compressedBytes,
    `Pinned bundle ${bundleIndex} artifact ${artifactIndex} compressed size`,
  );
  const decompressedBytes = positiveSafeInteger(
    value.decompressedBytes,
    `Pinned bundle ${bundleIndex} artifact ${artifactIndex} decompressed size`,
  );
  if (
    compressedBytes > MAX_COMPRESSED_ARTIFACT_BYTES ||
    decompressedBytes > MAX_DECOMPRESSED_ARTIFACT_BYTES
  ) {
    throw catalogError(
      `Pinned bundle ${bundleIndex} artifact ${artifactIndex} exceeds the size limit.`,
    );
  }
  return Object.freeze({
    id: value.id,
    kind: value.kind as BergamotArtifactKind,
    name: value.name,
    url: value.url,
    compressedBytes,
    compressedSha256: value.compressedSha256,
    decompressedBytes,
    decompressedSha256: value.decompressedSha256,
  });
}

export function parsePinnedBergamotCatalog(
  value: unknown,
): Map<BergamotPackageLanguage, BergamotLanguagePackage> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.source !== "Mozilla translations GCS release exports" ||
    !Array.isArray(value.bundles) ||
    value.bundles.length !== BERGAMOT_PACKAGE_LANGUAGES.length * 2
  ) {
    throw catalogError("Pinned model catalog header is invalid.");
  }
  const bundles = new Map<string, BergamotModelBundle>();
  value.bundles.forEach((candidate, bundleIndex) => {
    if (!isRecord(candidate)) {
      throw catalogError(`Pinned bundle ${bundleIndex} is not an object.`);
    }
    const from = supportedLanguage(candidate.from);
    const to = supportedLanguage(candidate.to);
    if (
      !from ||
      !to ||
      !isSupportedPair(from, to) ||
      typeof candidate.version !== "string" ||
      !VERSION_PATTERN.test(candidate.version) ||
      (candidate.architecture !== "base" &&
        candidate.architecture !== "base-memory") ||
      !Array.isArray(candidate.artifacts)
    ) {
      throw catalogError(`Pinned bundle ${bundleIndex} is invalid.`);
    }
    const artifacts = candidate.artifacts.map((artifact, artifactIndex) =>
      parsePinnedArtifact(artifact, bundleIndex, artifactIndex),
    );
    const kinds = new Set(artifacts.map((artifact) => artifact.kind));
    if (
      !kinds.has("model") ||
      !kinds.has("lex") ||
      kinds.has("vocab") === (kinds.has("srcvocab") && kinds.has("trgvocab")) ||
      kinds.size !== artifacts.length
    ) {
      throw catalogError(`Pinned bundle ${bundleIndex} is incomplete.`);
    }
    const key = `${from}\u0000${to}`;
    if (bundles.has(key)) {
      throw catalogError(`Pinned bundle ${bundleIndex} is duplicated.`);
    }
    bundles.set(
      key,
      Object.freeze({
        from,
        to,
        version: candidate.version,
        architecture: candidate.architecture,
        artifacts: Object.freeze(artifacts),
      }),
    );
  });
  const packages = new Map<BergamotPackageLanguage, BergamotLanguagePackage>();
  for (const language of BERGAMOT_PACKAGE_LANGUAGES) {
    const outbound = bundles.get(`en\u0000${language}`);
    const inbound = bundles.get(`${language}\u0000en`);
    if (!outbound || !inbound) {
      throw catalogError(`Pinned package ${language} is incomplete.`);
    }
    const directions: BergamotLanguagePackage["directions"] = [
      outbound,
      inbound,
    ];
    packages.set(
      language,
      Object.freeze({
        language,
        directions: Object.freeze(directions),
      }),
    );
  }
  return packages;
}

let cachedPinnedCatalog:
  Map<BergamotPackageLanguage, BergamotLanguagePackage> | undefined;

export function pinnedBergamotCatalog(): Map<
  BergamotPackageLanguage,
  BergamotLanguagePackage
> {
  cachedPinnedCatalog ??= parsePinnedBergamotCatalog(pinnedModels);
  return cachedPinnedCatalog;
}

export async function fetchBergamotCatalog(
  signal?: AbortSignal,
): Promise<Map<BergamotPackageLanguage, BergamotLanguagePackage>> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    CATALOG_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(BERGAMOT_REMOTE_SETTINGS_URL, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    throw new BergamotRuntimeError(
      "bergamot_catalog_unavailable",
      "Mozilla translation model catalog is unavailable.",
      true,
      `Failure=${error instanceof Error ? error.name : "unknown"}.`,
    );
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  if (!response.ok) {
    throw new BergamotRuntimeError(
      "bergamot_catalog_unavailable",
      "Mozilla translation model catalog is unavailable.",
      response.status >= 500 || response.status === 429,
      `HTTP status=${response.status}.`,
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw catalogError("Catalog response has an unexpected Content-Type.");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw catalogError("Catalog response is not valid JSON.");
  }
  return parseBergamotCatalog(value);
}
