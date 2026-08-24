import { decompress } from "fzstd";
import { pinnedBergamotCatalog } from "@/src/local-translation/catalog";
import { BergamotRuntimeError } from "@/src/local-translation/errors";
import {
  BERGAMOT_LANGUAGE_PACKS,
  getBergamotLanguagePack,
  type BergamotLanguagePackId,
} from "@/src/local-translation/languages";
import type {
  BergamotArtifact,
  BergamotInstallProgress,
  BergamotLanguage,
  BergamotLanguagePackage,
  BergamotModelBundle,
  BergamotPackageLanguage,
} from "@/src/local-translation/types";

export const BERGAMOT_RUNTIME_CACHE_NAME =
  "norixortrans-bergamot-models-v1" as const;

const METADATA_SCHEMA_VERSION = 1 as const;
const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000;
const DOWNLOAD_STALL_TIMEOUT_MS = 45_000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 10 * 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface LocalTranslationRuntimeInfo {
  packId: BergamotLanguagePackId;
  sourceLanguage: string;
  targetLanguage: string;
  state: "missing" | "downloading" | "installed" | "error";
  version?: string;
  bytes?: number;
  downloadBytes?: number;
  message?: string;
}

interface StoredPackMetadata {
  schemaVersion: typeof METADATA_SCHEMA_VERSION;
  packId: BergamotLanguagePackId;
  installedAt: number;
  bytes: number;
  bundle: BergamotModelBundle;
}

export interface LoadedBergamotModel {
  model: ArrayBuffer;
  shortlist: ArrayBuffer;
  vocabs: ArrayBuffer[];
  config: Record<string, unknown>;
}

export interface BergamotRuntimeByteStore {
  get(key: string): Promise<{ bytes: Uint8Array; sha256?: string } | undefined>;
  inspect(key: string): Promise<{ bytes: number; sha256?: string } | undefined>;
  set(key: string, bytes: Uint8Array, sha256?: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface BergamotRuntimeStorageDependencies {
  fetch: typeof fetch;
  store: BergamotRuntimeByteStore;
  now: () => number;
  sha256: (bytes: Uint8Array) => Promise<string>;
  catalog: (
    signal?: AbortSignal,
  ) => Promise<Map<BergamotPackageLanguage, BergamotLanguagePackage>>;
}

export interface BergamotInstallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BergamotInstallProgress) => void;
}

interface InstallJob {
  promise: Promise<StoredPackMetadata>;
  listeners: Set<(progress: BergamotInstallProgress) => void>;
  latestProgress?: BergamotInstallProgress;
}

function cacheRequest(key: string): Request {
  return new Request(
    `https://norixortrans.invalid/bergamot-runtime/${encodeURIComponent(key)}`,
  );
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function defaultByteStore(): BergamotRuntimeByteStore {
  const open = (): Promise<Cache> => caches.open(BERGAMOT_RUNTIME_CACHE_NAME);
  return {
    async get(key) {
      const response = await (await open()).match(cacheRequest(key));
      if (!response) return undefined;
      const hash = response.headers.get("x-content-sha256");
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        ...(hash ? { sha256: hash } : {}),
      };
    },
    async inspect(key) {
      const response = await (await open()).match(cacheRequest(key));
      if (!response) return undefined;
      const contentLength = response.headers.get("content-length");
      if (!contentLength || !/^\d+$/u.test(contentLength)) return undefined;
      const hash = response.headers.get("x-content-sha256");
      return {
        bytes: Number(contentLength),
        ...(hash ? { sha256: hash } : {}),
      };
    },
    async set(key, bytes, hash) {
      await (
        await open()
      ).put(
        cacheRequest(key),
        new Response(ownedArrayBuffer(bytes), {
          headers: {
            "content-length": String(bytes.byteLength),
            ...(hash ? { "x-content-sha256": hash } : {}),
          },
        }),
      );
    },
    async delete(key) {
      await (await open()).delete(cacheRequest(key));
    },
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function defaultDependencies(): BergamotRuntimeStorageDependencies {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    store: defaultByteStore(),
    now: Date.now,
    sha256,
    catalog: () => Promise.resolve(pinnedBergamotCatalog()),
  };
}

function metadataKey(packId: BergamotLanguagePackId): string {
  return `package:${packId}`;
}

function artifactKey(artifact: Pick<BergamotArtifact, "id">): string {
  return `artifact:${artifact.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStoredArtifact(value: unknown): value is BergamotArtifact {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    ["model", "lex", "vocab", "srcvocab", "trgvocab"].includes(
      String(value.kind),
    ) &&
    typeof value.name === "string" &&
    typeof value.url === "string" &&
    (value.url.startsWith(
      "https://firefox-settings-attachments.cdn.mozilla.net/",
    ) ||
      value.url.startsWith(
        "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/models/",
      )) &&
    typeof value.compressedBytes === "number" &&
    Number.isSafeInteger(value.compressedBytes) &&
    value.compressedBytes > 0 &&
    typeof value.decompressedBytes === "number" &&
    Number.isSafeInteger(value.decompressedBytes) &&
    value.decompressedBytes > 0 &&
    typeof value.compressedSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.compressedSha256) &&
    typeof value.decompressedSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.decompressedSha256)
  );
}

function isStoredBundle(value: unknown): value is BergamotModelBundle {
  if (
    !isRecord(value) ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    typeof value.version !== "string" ||
    (value.architecture !== "base" && value.architecture !== "base-memory") ||
    !Array.isArray(value.artifacts) ||
    !value.artifacts.every(isStoredArtifact)
  ) {
    return false;
  }
  const kinds = new Set(value.artifacts.map((artifact) => artifact.kind));
  return (
    kinds.has("model") &&
    kinds.has("lex") &&
    (kinds.has("vocab") || (kinds.has("srcvocab") && kinds.has("trgvocab")))
  );
}

function parseMetadata(
  bytes: Uint8Array | undefined,
  packId: BergamotLanguagePackId,
): StoredPackMetadata | undefined {
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    const pack = getBergamotLanguagePack(packId);
    if (
      !isRecord(value) ||
      value.schemaVersion !== METADATA_SCHEMA_VERSION ||
      value.packId !== packId ||
      typeof value.installedAt !== "number" ||
      !Number.isSafeInteger(value.installedAt) ||
      value.installedAt <= 0 ||
      typeof value.bytes !== "number" ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes <= 0 ||
      !isStoredBundle(value.bundle) ||
      value.bundle.from !== pack.sourceLanguage ||
      value.bundle.to !== pack.targetLanguage
    ) {
      return undefined;
    }
    return value as unknown as StoredPackMetadata;
  } catch {
    return undefined;
  }
}

function serializeMetadata(metadata: StoredPackMetadata): Uint8Array {
  return encoder.encode(JSON.stringify(metadata));
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  cancel: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cancel();
      reject(new DOMException("Timed out", "TimeoutError"));
    }, timeoutMs);
    operation.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function downloadArtifact(
  artifact: BergamotArtifact,
  dependencies: BergamotRuntimeStorageDependencies,
  signal: AbortSignal | undefined,
  onChunk: (received: number) => void,
): Promise<Uint8Array> {
  assertNotAborted(signal);
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const deadlineAt = Date.now() + DOWNLOAD_TOTAL_TIMEOUT_MS;
  try {
    const response = await withTimeout(
      dependencies.fetch(artifact.url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: artifact.url.endsWith(".gz")
            ? "application/gzip, application/octet-stream"
            : "application/zstd, application/octet-stream",
        },
      }),
      DOWNLOAD_CONNECT_TIMEOUT_MS,
      abort,
    );
    if (!response.ok) {
      throw new BergamotRuntimeError(
        "bergamot_catalog_unavailable",
        "Mozilla translation model attachment is unavailable.",
        response.status >= 500 || response.status === 429,
        `HTTP status=${response.status}; artifact=${artifact.kind}.`,
      );
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      contentType !== "application/zstd" &&
      contentType !== "application/gzip" &&
      contentType !== "application/x-gzip" &&
      contentType !== "application/octet-stream"
    ) {
      throw new BergamotRuntimeError(
        "bergamot_integrity_failed",
        "Translation model attachment has an unexpected content type.",
        false,
        `Artifact=${artifact.kind}.`,
      );
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^\d+$/u.test(contentLength) ||
        Number(contentLength) !== artifact.compressedBytes)
    ) {
      throw new BergamotRuntimeError(
        "bergamot_integrity_failed",
        "Translation model compressed size did not match the catalog.",
        false,
        `Artifact=${artifact.kind}.`,
      );
    }
    if (!response.body) {
      throw new BergamotRuntimeError(
        "bergamot_catalog_unavailable",
        "Translation model attachment has no readable body.",
        true,
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        controller.abort();
        throw new DOMException("Timed out", "TimeoutError");
      }
      const result = await withTimeout(
        reader.read(),
        Math.min(DOWNLOAD_STALL_TIMEOUT_MS, remainingMs),
        () => {
          controller.abort();
          void reader.cancel();
        },
      );
      if (result.done) break;
      received += result.value.byteLength;
      if (received > artifact.compressedBytes) {
        await reader.cancel();
        throw new BergamotRuntimeError(
          "bergamot_integrity_failed",
          "Translation model attachment exceeded its catalog size.",
          false,
          `Artifact=${artifact.kind}.`,
        );
      }
      chunks.push(result.value);
      onChunk(received);
    }
    if (received !== artifact.compressedBytes) {
      throw new BergamotRuntimeError(
        "bergamot_integrity_failed",
        "Translation model compressed size did not match the catalog.",
        false,
        `Artifact=${artifact.kind}.`,
      );
    }
    const compressed = concatenate(chunks, received);
    if ((await dependencies.sha256(compressed)) !== artifact.compressedSha256) {
      throw new BergamotRuntimeError(
        "bergamot_integrity_failed",
        "Translation model compressed checksum did not match the catalog.",
        false,
        `Artifact=${artifact.kind}.`,
      );
    }
    return compressed;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (error instanceof BergamotRuntimeError) throw error;
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === "TimeoutError")
    ) {
      throw new BergamotRuntimeError(
        "bergamot_catalog_unavailable",
        "Mozilla translation model attachment could not be downloaded.",
        true,
        `Artifact=${artifact.kind}; failure=${error.name}.`,
      );
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function decompressArtifact(
  artifact: BergamotArtifact,
  compressed: Uint8Array,
): Promise<Uint8Array> {
  try {
    const output = artifact.url.endsWith(".gz")
      ? new Uint8Array(
          await new Response(
            new Blob([ownedArrayBuffer(compressed)])
              .stream()
              .pipeThrough(new DecompressionStream("gzip")),
          ).arrayBuffer(),
        )
      : decompress(compressed, new Uint8Array(artifact.decompressedBytes));
    if (output.byteLength === artifact.decompressedBytes) return output;
  } catch (error) {
    throw new BergamotRuntimeError(
      "bergamot_integrity_failed",
      "Translation model attachment could not be decompressed.",
      false,
      `Artifact=${artifact.kind}; failure=${error instanceof Error ? error.name : "unknown"}.`,
    );
  }
  throw new BergamotRuntimeError(
    "bergamot_integrity_failed",
    "Translation model decompressed size did not match the catalog.",
    false,
    `Artifact=${artifact.kind}.`,
  );
}

export class BergamotRuntimeStorage {
  private readonly dependencies: BergamotRuntimeStorageDependencies;
  private readonly jobs = new Map<BergamotLanguagePackId, InstallJob>();
  private readonly errors = new Map<BergamotLanguagePackId, string>();

  constructor(
    dependencies: BergamotRuntimeStorageDependencies = defaultDependencies(),
  ) {
    this.dependencies = dependencies;
  }

  async list(): Promise<LocalTranslationRuntimeInfo[]> {
    const catalog = await this.dependencies.catalog();
    return Promise.all(
      BERGAMOT_LANGUAGE_PACKS.map(async (pack) => {
        const bundle = catalog
          .get(pack.packageLanguage)
          ?.directions.find(
            (candidate) =>
              candidate.from === pack.sourceLanguage &&
              candidate.to === pack.targetLanguage,
          );
        const downloadBytes = bundle?.artifacts.reduce(
          (total, artifact) => total + artifact.compressedBytes,
          0,
        );
        const job = this.jobs.get(pack.id);
        if (job) {
          return {
            packId: pack.id,
            sourceLanguage: pack.sourceLanguage,
            targetLanguage: pack.targetLanguage,
            state: "downloading" as const,
            ...(job.latestProgress
              ? { bytes: job.latestProgress.receivedBytes }
              : {}),
            ...(downloadBytes ? { downloadBytes } : {}),
          };
        }
        const metadata = await this.installedMetadata(pack.id);
        const error = this.errors.get(pack.id);
        if (!metadata && error) {
          return {
            packId: pack.id,
            sourceLanguage: pack.sourceLanguage,
            targetLanguage: pack.targetLanguage,
            state: "error" as const,
            message: error,
            ...(downloadBytes ? { downloadBytes } : {}),
          };
        }
        return metadata
          ? {
              ...this.info(metadata),
              ...(downloadBytes ? { downloadBytes } : {}),
            }
          : {
              packId: pack.id,
              sourceLanguage: pack.sourceLanguage,
              targetLanguage: pack.targetLanguage,
              state: "missing" as const,
              ...(downloadBytes ? { downloadBytes } : {}),
            };
      }),
    );
  }

  async install(
    packId: BergamotLanguagePackId,
    options: BergamotInstallOptions = {},
  ): Promise<LocalTranslationRuntimeInfo> {
    assertNotAborted(options.signal);
    const active = this.jobs.get(packId);
    if (active) {
      if (options.onProgress) active.listeners.add(options.onProgress);
      if (options.onProgress && active.latestProgress) {
        options.onProgress(active.latestProgress);
      }
      return this.info(await active.promise);
    }
    const listeners = new Set<(progress: BergamotInstallProgress) => void>();
    if (options.onProgress) listeners.add(options.onProgress);
    const job: InstallJob = {
      listeners,
      promise: Promise.resolve(undefined as never),
    };
    const report = (progress: BergamotInstallProgress): void => {
      job.latestProgress = progress;
      for (const listener of job.listeners) listener(progress);
    };
    job.promise = this.performInstall(packId, options.signal, report);
    this.jobs.set(packId, job);
    try {
      const metadata = await job.promise;
      this.errors.delete(packId);
      return this.info(metadata);
    } catch (error) {
      const message =
        error instanceof BergamotRuntimeError
          ? error.message
          : "Bergamot language pack installation failed.";
      this.errors.set(packId, message.slice(0, 240));
      throw error;
    } finally {
      if (this.jobs.get(packId) === job) this.jobs.delete(packId);
    }
  }

  async deleteRuntime(packId: BergamotLanguagePackId): Promise<boolean> {
    if (this.jobs.has(packId)) {
      throw new BergamotRuntimeError(
        "bergamot_runtime_failed",
        "Cannot delete a language pack while it is installing.",
        true,
      );
    }
    const metadata = await this.readMetadata(packId);
    await this.dependencies.store.delete(metadataKey(packId));
    this.errors.delete(packId);
    if (!metadata) return false;
    const referenced = await this.referencedArtifactIds(packId);
    await Promise.all(
      metadata.bundle.artifacts
        .filter((artifact) => !referenced.has(artifact.id))
        .map((artifact) =>
          this.dependencies.store.delete(artifactKey(artifact)),
        ),
    );
    return true;
  }

  async installedModels(): Promise<
    Array<{ from: BergamotLanguage; to: BergamotLanguage }>
  > {
    const models: Array<{ from: BergamotLanguage; to: BergamotLanguage }> = [];
    for (const pack of BERGAMOT_LANGUAGE_PACKS) {
      if (await this.installedMetadata(pack.id)) {
        models.push({ from: pack.sourceLanguage, to: pack.targetLanguage });
      }
    }
    return models;
  }

  async loadModel(
    from: BergamotLanguage,
    to: BergamotLanguage,
  ): Promise<LoadedBergamotModel> {
    const pack = BERGAMOT_LANGUAGE_PACKS.find(
      (candidate) =>
        candidate.sourceLanguage === from && candidate.targetLanguage === to,
    );
    const metadata = pack ? await this.installedMetadata(pack.id) : undefined;
    if (!pack || !metadata) {
      throw new BergamotRuntimeError(
        "bergamot_package_missing",
        "Required Bergamot language pack is not installed.",
        false,
        `Direction=${from}->${to}.`,
      );
    }
    const loaded = new Map<string, ArrayBuffer>();
    for (const artifact of metadata.bundle.artifacts) {
      const stored = await this.dependencies.store.get(artifactKey(artifact));
      if (
        !stored ||
        stored.bytes.byteLength !== artifact.decompressedBytes ||
        stored.sha256 !== artifact.decompressedSha256 ||
        (await this.dependencies.sha256(stored.bytes)) !==
          artifact.decompressedSha256
      ) {
        throw new BergamotRuntimeError(
          "bergamot_package_missing",
          "Installed Bergamot language pack is incomplete or corrupt.",
          false,
          `Pack=${pack.id}; artifact=${artifact.kind}.`,
        );
      }
      loaded.set(artifact.kind, ownedArrayBuffer(stored.bytes));
    }
    const model = loaded.get("model");
    const shortlist = loaded.get("lex");
    const sharedVocab = loaded.get("vocab");
    const sourceVocab = loaded.get("srcvocab");
    const targetVocab = loaded.get("trgvocab");
    if (
      !model ||
      !shortlist ||
      (!sharedVocab && (!sourceVocab || !targetVocab))
    ) {
      throw new BergamotRuntimeError(
        "bergamot_package_missing",
        "Installed Bergamot language pack is incomplete or corrupt.",
        false,
        `Pack=${pack.id}.`,
      );
    }
    return {
      model,
      shortlist,
      vocabs: sharedVocab ? [sharedVocab] : [sourceVocab!, targetVocab!],
      config: { "gemm-precision": "int8shiftAlphaAll" },
    };
  }

  private async performInstall(
    packId: BergamotLanguagePackId,
    signal: AbortSignal | undefined,
    report: (progress: BergamotInstallProgress) => void,
  ): Promise<StoredPackMetadata> {
    const pack = getBergamotLanguagePack(packId);
    report({ phase: "catalog", receivedBytes: 0, totalBytes: 0 });
    const catalog = await this.dependencies.catalog(signal);
    const packageValue = catalog.get(pack.packageLanguage);
    const bundle = packageValue?.directions.find(
      (candidate) =>
        candidate.from === pack.sourceLanguage &&
        candidate.to === pack.targetLanguage,
    );
    if (!bundle) {
      throw new BergamotRuntimeError(
        "bergamot_unsupported_language",
        "Mozilla does not provide a complete stable model for this language direction.",
        false,
        `Pack=${packId}.`,
      );
    }
    const totalBytes = bundle.artifacts.reduce(
      (total, artifact) => total + artifact.compressedBytes,
      0,
    );
    let receivedBytes = 0;
    const newlyStored = new Set<string>();
    try {
      for (const artifact of bundle.artifacts) {
        assertNotAborted(signal);
        const key = artifactKey(artifact);
        const existing = await this.dependencies.store.inspect(key);
        const existingBytes =
          existing?.bytes === artifact.decompressedBytes &&
          existing.sha256 === artifact.decompressedSha256
            ? await this.dependencies.store.get(key)
            : undefined;
        const existingValid = Boolean(
          existingBytes &&
          existingBytes.bytes.byteLength === artifact.decompressedBytes &&
          (await this.dependencies.sha256(existingBytes.bytes)) ===
            artifact.decompressedSha256,
        );
        if (existingValid) {
          receivedBytes += artifact.compressedBytes;
          report({ phase: "downloading", receivedBytes, totalBytes });
          continue;
        }
        const compressed = await downloadArtifact(
          artifact,
          this.dependencies,
          signal,
          (artifactReceived) =>
            report({
              phase: "downloading",
              receivedBytes: receivedBytes + artifactReceived,
              totalBytes,
            }),
        );
        report({ phase: "decompressing", receivedBytes, totalBytes });
        const decompressed = await decompressArtifact(artifact, compressed);
        report({ phase: "verifying", receivedBytes, totalBytes });
        if (
          (await this.dependencies.sha256(decompressed)) !==
          artifact.decompressedSha256
        ) {
          throw new BergamotRuntimeError(
            "bergamot_integrity_failed",
            "Translation model decompressed checksum did not match the catalog.",
            false,
            `Artifact=${artifact.kind}.`,
          );
        }
        report({ phase: "storing", receivedBytes, totalBytes });
        await this.dependencies.store.set(
          key,
          decompressed,
          artifact.decompressedSha256,
        );
        if (!existing) newlyStored.add(key);
        receivedBytes += artifact.compressedBytes;
      }
      const metadata: StoredPackMetadata = {
        schemaVersion: METADATA_SCHEMA_VERSION,
        packId,
        installedAt: this.dependencies.now(),
        bytes: bundle.artifacts.reduce(
          (total, artifact) => total + artifact.decompressedBytes,
          0,
        ),
        bundle,
      };
      await this.dependencies.store.set(
        metadataKey(packId),
        serializeMetadata(metadata),
      );
      report({ phase: "complete", receivedBytes: totalBytes, totalBytes });
      return metadata;
    } catch (error) {
      await Promise.all(
        [...newlyStored].map((key) => this.dependencies.store.delete(key)),
      );
      throw error;
    }
  }

  private async readMetadata(
    packId: BergamotLanguagePackId,
  ): Promise<StoredPackMetadata | undefined> {
    const stored = await this.dependencies.store.get(metadataKey(packId));
    return parseMetadata(stored?.bytes, packId);
  }

  private async installedMetadata(
    packId: BergamotLanguagePackId,
  ): Promise<StoredPackMetadata | undefined> {
    const metadata = await this.readMetadata(packId);
    if (!metadata) return undefined;
    for (const artifact of metadata.bundle.artifacts) {
      const stored = await this.dependencies.store.inspect(
        artifactKey(artifact),
      );
      if (
        stored?.bytes !== artifact.decompressedBytes ||
        stored.sha256 !== artifact.decompressedSha256
      ) {
        return undefined;
      }
    }
    return metadata;
  }

  private async referencedArtifactIds(
    excludedPackId: BergamotLanguagePackId,
  ): Promise<Set<string>> {
    const referenced = new Set<string>();
    for (const pack of BERGAMOT_LANGUAGE_PACKS) {
      if (pack.id === excludedPackId) continue;
      const metadata = await this.readMetadata(pack.id);
      for (const artifact of metadata?.bundle.artifacts ?? []) {
        referenced.add(artifact.id);
      }
    }
    return referenced;
  }

  private info(metadata: StoredPackMetadata): LocalTranslationRuntimeInfo {
    const pack = getBergamotLanguagePack(metadata.packId);
    return {
      packId: metadata.packId,
      sourceLanguage: pack.sourceLanguage,
      targetLanguage: pack.targetLanguage,
      state: "installed",
      version: `${metadata.bundle.version} · ${metadata.bundle.architecture}`,
      bytes: metadata.bytes,
    };
  }
}

const defaultStorage = new BergamotRuntimeStorage();

export function list(): Promise<LocalTranslationRuntimeInfo[]> {
  return defaultStorage.list();
}

export function install(
  packId: BergamotLanguagePackId,
  options?: BergamotInstallOptions,
): Promise<LocalTranslationRuntimeInfo> {
  return defaultStorage.install(packId, options);
}

export function deleteRuntime(
  packId: BergamotLanguagePackId,
): Promise<boolean> {
  return defaultStorage.deleteRuntime(packId);
}

export function installedModels(): Promise<
  Array<{ from: BergamotLanguage; to: BergamotLanguage }>
> {
  return defaultStorage.installedModels();
}

export function loadModel(
  from: BergamotLanguage,
  to: BergamotLanguage,
): Promise<LoadedBergamotModel> {
  return defaultStorage.loadModel(from, to);
}
