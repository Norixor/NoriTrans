import {
  getOcrRuntimeLanguage,
  getOcrRuntimePackage,
  getOcrRuntimePack,
  OCR_DETECTION_ARTIFACT,
  OCR_RUNTIME_PACK_CATALOG,
  OCR_RUNTIME_PACKAGE_VERSION,
  type OcrRuntimeArtifact,
  type OcrRuntimeLanguageCode,
  type OcrRuntimePack,
} from "@/src/ocr/runtime-catalog";
import type { OcrRuntimeInfo } from "@/src/messaging/protocol";

export const OCR_RUNTIME_CACHE_NAME = "noritrans-ppocr-runtime-v1";
export const MAX_RUNTIME_ARTIFACT_BYTES = 32 * 1024 * 1024;
const OCR_RUNTIME_DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000;
const OCR_RUNTIME_DOWNLOAD_STALL_TIMEOUT_MS = 30_000;
const OCR_RUNTIME_DOWNLOAD_TOTAL_TIMEOUT_MS = 180_000;

const GENERIC_INSTALL_ERROR = "OCR runtime installation failed.";
const MAX_SAFE_ERROR_MESSAGE_LENGTH = 200;

export interface OcrRuntimeMetadata {
  code: OcrRuntimeLanguageCode;
  version: typeof OCR_RUNTIME_PACKAGE_VERSION;
  pack: OcrRuntimePack;
  bytes: number;
  artifacts: Record<string, string>;
  installedAt: number;
}

export type OcrRuntimeInstallProgress =
  | { phase: "downloading"; receivedBytes: number; totalBytes: number }
  | { phase: "storing"; receivedBytes: number; totalBytes: number }
  | { phase: "complete"; receivedBytes: number; totalBytes: number };

export interface OcrRuntimeInstallOptions {
  onProgress?: (progress: OcrRuntimeInstallProgress) => void;
}

export interface OcrRuntimeDeleteResult {
  pack: OcrRuntimePack;
  physicalPackDeleted: boolean;
}

export interface OcrRuntimeByteStore {
  get(key: string): Promise<Uint8Array | undefined>;
  size(key: string): Promise<number | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OcrRuntimeStorageDependencies {
  fetch: typeof fetch;
  store: OcrRuntimeByteStore;
  now: () => number;
  sha256: (bytes: Uint8Array) => Promise<string>;
}

interface PackInstallJob {
  promise: Promise<void>;
  listeners: Set<(progress: OcrRuntimeInstallProgress) => void>;
  latestProgress?: OcrRuntimeInstallProgress;
}

interface ArtifactVerification {
  valid: boolean;
  bytes?: Uint8Array;
}

type ArtifactVerificationCache = Map<string, Promise<ArtifactVerification>>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function ocrRuntimeArtifactKey(artifact: OcrRuntimeArtifact): string {
  return `artifact:${artifact.id}`;
}

function runtimeMetadataKey(code: OcrRuntimeLanguageCode): string {
  return `metadata:${code}`;
}

function cacheRequest(key: string): Request {
  return new Request(
    `https://noritrans.invalid/ocr-runtime/${encodeURIComponent(key)}`,
  );
}

function defaultByteStore(): OcrRuntimeByteStore {
  const open = (): Promise<Cache> => caches.open(OCR_RUNTIME_CACHE_NAME);
  return {
    async get(key) {
      const response = await (await open()).match(cacheRequest(key));
      if (!response) return undefined;
      return new Uint8Array(await response.arrayBuffer());
    },
    async size(key) {
      const response = await (await open()).match(cacheRequest(key));
      if (!response) return undefined;
      const value = response.headers.get("content-length");
      return value && /^\d+$/u.test(value) ? Number(value) : undefined;
    },
    async set(key, value) {
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      await (
        await open()
      ).put(
        cacheRequest(key),
        new Response(copy, {
          headers: { "content-length": String(copy.byteLength) },
        }),
      );
    },
    async delete(key) {
      await (await open()).delete(cacheRequest(key));
    },
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function defaultDependencies(): OcrRuntimeStorageDependencies {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    store: defaultByteStore(),
    now: Date.now,
    sha256,
  };
}

function concatenateChunks(
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function runtimeDownloadTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  cancel: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cancel();
      reject(new Error("OCR runtime download timed out."));
    }, timeoutMs);
    operation.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new Error("OCR runtime installation failed."),
        );
      },
    );
  });
}

function safeInstallErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return GENERIC_INSTALL_ERROR;
  const message = error.message.trim();
  return message.startsWith("OCR runtime")
    ? message.slice(0, MAX_SAFE_ERROR_MESSAGE_LENGTH)
    : GENERIC_INSTALL_ERROR;
}

function remainingRuntimeDownloadMs(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("OCR runtime download timed out.");
  return remaining;
}

function parseMetadata(
  bytes: Uint8Array | undefined,
  code: OcrRuntimeLanguageCode,
): OcrRuntimeMetadata | undefined {
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Partial<OcrRuntimeMetadata>;
    const language = getOcrRuntimeLanguage(code);
    if (
      candidate.code !== code ||
      candidate.version !== OCR_RUNTIME_PACKAGE_VERSION ||
      candidate.pack !== language.pack ||
      !Number.isSafeInteger(candidate.bytes) ||
      Number(candidate.bytes) <= 0 ||
      !candidate.artifacts ||
      typeof candidate.artifacts !== "object" ||
      !language.artifacts.every(
        (artifact) => candidate.artifacts?.[artifact.id] === artifact.sha256,
      ) ||
      !Number.isSafeInteger(candidate.installedAt) ||
      Number(candidate.installedAt) <= 0
    ) {
      return undefined;
    }
    return candidate as OcrRuntimeMetadata;
  } catch {
    return undefined;
  }
}

function serializeMetadata(metadata: OcrRuntimeMetadata): Uint8Array {
  return encoder.encode(JSON.stringify(metadata));
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function downloadArtifact(
  artifact: OcrRuntimeArtifact,
  dependencies: OcrRuntimeStorageDependencies,
  onChunk: (received: number) => void,
  deadlineAt: number,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const response = await runtimeDownloadTimeout(
    dependencies.fetch(artifact.url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    }),
    Math.min(
      OCR_RUNTIME_DOWNLOAD_CONNECT_TIMEOUT_MS,
      remainingRuntimeDownloadMs(deadlineAt),
    ),
    () => controller.abort(),
  );
  if (!response.ok) {
    throw new Error(
      `OCR runtime download failed with HTTP ${response.status}.`,
    );
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (!contentType || !artifact.contentTypes.includes(contentType)) {
    throw new Error(
      "OCR runtime download returned an unexpected Content-Type.",
    );
  }
  const lengthValue = response.headers.get("content-length");
  if (lengthValue !== null) {
    if (
      !/^\d+$/u.test(lengthValue) ||
      Number(lengthValue) <= 0 ||
      Number(lengthValue) > MAX_RUNTIME_ARTIFACT_BYTES
    ) {
      throw new Error("OCR runtime download returned an invalid size.");
    }
  }
  if (!response.body) {
    throw new Error("OCR runtime download did not provide a readable body.");
  }
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let received = 0;
  while (true) {
    const result = await runtimeDownloadTimeout(
      reader.read(),
      Math.min(
        OCR_RUNTIME_DOWNLOAD_STALL_TIMEOUT_MS,
        remainingRuntimeDownloadMs(deadlineAt),
      ),
      () => {
        controller.abort();
        void reader.cancel();
      },
    );
    if (result.done) break;
    received += result.value.byteLength;
    if (received > artifact.bytes || received > MAX_RUNTIME_ARTIFACT_BYTES) {
      await reader.cancel();
      throw new Error("OCR runtime download exceeds its pinned size.");
    }
    chunks.push(result.value);
    onChunk(received);
  }
  if (received !== artifact.bytes) {
    throw new Error(
      "OCR runtime download length did not match its pinned size.",
    );
  }
  const bytes = concatenateChunks(chunks, received);
  if ((await dependencies.sha256(bytes)) !== artifact.sha256) {
    throw new Error("OCR runtime download failed its integrity check.");
  }
  return bytes;
}

export interface LoadedOcrRuntimePack {
  pack: OcrRuntimePack;
  detection: ArrayBuffer;
  recognition: ArrayBuffer;
  dictionary: ArrayBuffer;
}

export class OcrRuntimeStorage {
  private readonly dependencies: OcrRuntimeStorageDependencies;
  private readonly installJobs = new Map<OcrRuntimePack, PackInstallJob>();
  private readonly artifactDownloadJobs = new Map<
    string,
    Promise<Uint8Array>
  >();
  private readonly installErrors = new Map<OcrRuntimePack, string>();

  constructor(
    dependencies: OcrRuntimeStorageDependencies = defaultDependencies(),
  ) {
    this.dependencies = dependencies;
  }

  async list(): Promise<OcrRuntimeInfo[]> {
    const artifactVerifications: ArtifactVerificationCache = new Map();
    return Promise.all(
      OCR_RUNTIME_PACK_CATALOG.map(
        async (runtimePackage): Promise<OcrRuntimeInfo> => {
          const activeJob = this.installJobs.get(runtimePackage.pack);
          if (activeJob) {
            const progress = activeJob.latestProgress;
            return {
              pack: runtimePackage.pack,
              labelKey: runtimePackage.labelKey,
              languages: runtimePackage.languages,
              state: "downloading",
              ...(progress ? { bytes: progress.receivedBytes } : {}),
              ...(progress && progress.totalBytes > 0
                ? { progress: progress.receivedBytes / progress.totalBytes }
                : {}),
            };
          }
          const metadata = await this.ensurePackMetadata(
            runtimePackage.pack,
            artifactVerifications,
          );
          const installError = this.installErrors.get(runtimePackage.pack);
          if (!metadata && installError) {
            return {
              pack: runtimePackage.pack,
              labelKey: runtimePackage.labelKey,
              languages: runtimePackage.languages,
              state: "error",
              message: installError,
            };
          }
          return {
            pack: runtimePackage.pack,
            labelKey: runtimePackage.labelKey,
            languages: runtimePackage.languages,
            state: metadata ? "installed" : "missing",
            ...(metadata ? { bytes: metadata.bytes } : {}),
          };
        },
      ),
    );
  }

  async installedLanguages(): Promise<OcrRuntimeLanguageCode[]> {
    return (await this.list()).flatMap((runtime) =>
      runtime.state === "installed" ? runtime.languages : [],
    );
  }

  async isInstalled(code: OcrRuntimeLanguageCode): Promise<boolean> {
    const language = getOcrRuntimeLanguage(code);
    return Boolean(await this.ensurePackMetadata(language.pack));
  }

  async install(
    code: OcrRuntimeLanguageCode,
    options: OcrRuntimeInstallOptions = {},
  ): Promise<OcrRuntimeMetadata> {
    const language = getOcrRuntimeLanguage(code);
    const existingMetadata = await this.installedMetadata(code);
    if (existingMetadata) return existingMetadata;
    const sharedMetadata = await this.ensurePackMetadata(language.pack);
    if (sharedMetadata) {
      return (
        (await this.installedMetadata(code)) ??
        (await this.persistMetadata(code, sharedMetadata.installedAt))
      );
    }
    // Another logical language mapped to this physical model pack may have
    // started while the asynchronous metadata check was running.
    const existing = this.installJobs.get(language.pack);
    if (existing) {
      if (options.onProgress) existing.listeners.add(options.onProgress);
      if (options.onProgress && existing.latestProgress) {
        options.onProgress(existing.latestProgress);
      }
      try {
        await existing.promise;
        return (await this.persistPackMetadata(language.pack)).get(code)!;
      } catch (error) {
        this.installErrors.set(language.pack, safeInstallErrorMessage(error));
        await this.deletePackMetadata(language.pack);
        throw error;
      }
    }

    const listeners = new Set<(progress: OcrRuntimeInstallProgress) => void>();
    if (options.onProgress) listeners.add(options.onProgress);
    this.installErrors.delete(language.pack);
    const emit = (progress: OcrRuntimeInstallProgress): void => {
      const job = this.installJobs.get(language.pack);
      if (job) job.latestProgress = progress;
      for (const listener of listeners) {
        try {
          listener(progress);
        } catch {
          // UI progress observers cannot invalidate a verified installation.
        }
      }
    };
    const promise = this.downloadPackArtifacts(language.pack, emit);
    const job: PackInstallJob = {
      promise,
      listeners,
    };
    this.installJobs.set(language.pack, job);
    try {
      await promise;
      return (await this.persistPackMetadata(language.pack)).get(code)!;
    } catch (error) {
      this.installErrors.set(language.pack, safeInstallErrorMessage(error));
      await this.deletePackMetadata(language.pack);
      throw error;
    } finally {
      if (this.installJobs.get(language.pack) === job) {
        this.installJobs.delete(language.pack);
      }
    }
  }

  async delete(code: OcrRuntimeLanguageCode): Promise<OcrRuntimeDeleteResult> {
    return this.deletePack(getOcrRuntimeLanguage(code).pack);
  }

  async installRuntimePack(
    pack: OcrRuntimePack,
    options: OcrRuntimeInstallOptions = {},
  ): Promise<void> {
    const firstLanguage = getOcrRuntimePackage(pack).languages[0];
    if (!firstLanguage) throw new RangeError(`Unsupported OCR pack: ${pack}`);
    await this.install(firstLanguage, options);
  }

  async deletePack(pack: OcrRuntimePack): Promise<OcrRuntimeDeleteResult> {
    getOcrRuntimePackage(pack);
    await this.installJobs.get(pack)?.promise.catch(() => undefined);
    this.installErrors.delete(pack);
    await this.deletePackMetadata(pack);
    await Promise.all(
      getOcrRuntimePack(pack)
        .filter((artifact) => artifact.kind !== "detection")
        .map((artifact) =>
          this.dependencies.store.delete(ocrRuntimeArtifactKey(artifact)),
        ),
    );
    const anyInstalled = await Promise.all(
      OCR_RUNTIME_PACK_CATALOG.map((candidate) =>
        this.ensurePackMetadata(candidate.pack),
      ),
    );
    if (!anyInstalled.some(Boolean)) {
      await this.dependencies.store.delete(
        ocrRuntimeArtifactKey(OCR_DETECTION_ARTIFACT),
      );
    }
    return { pack, physicalPackDeleted: true };
  }

  async load(code: OcrRuntimeLanguageCode): Promise<LoadedOcrRuntimePack> {
    const language = getOcrRuntimeLanguage(code);
    let artifactVerifications: ArtifactVerificationCache = new Map();
    let metadata = await this.installedMetadata(
      code,
      artifactVerifications,
      true,
    );
    if (!metadata && (await this.ensurePackMetadata(language.pack))) {
      artifactVerifications = new Map();
      metadata = await this.installedMetadata(
        code,
        artifactVerifications,
        true,
      );
    }
    if (!metadata) throw new Error(`ocr_runtime_missing:${code}`);
    const entries = await Promise.all(
      language.artifacts.map(async (artifact) => ({
        artifact,
        bytes: (
          await artifactVerifications.get(ocrRuntimeArtifactKey(artifact))
        )?.bytes,
      })),
    );
    const detection = entries.find(
      (entry) => entry.artifact.kind === "detection",
    );
    const recognition = entries.find(
      (entry) => entry.artifact.kind === "recognition",
    );
    const dictionary = entries.find(
      (entry) => entry.artifact.kind === "dictionary",
    );
    if (!detection?.bytes || !recognition?.bytes || !dictionary?.bytes) {
      throw new Error(`ocr_runtime_missing:${code}`);
    }
    return {
      pack: language.pack,
      detection: ownedArrayBuffer(detection.bytes),
      recognition: ownedArrayBuffer(recognition.bytes),
      dictionary: ownedArrayBuffer(dictionary.bytes),
    };
  }

  private async downloadPackArtifacts(
    pack: OcrRuntimePack,
    emit: (progress: OcrRuntimeInstallProgress) => void,
  ): Promise<void> {
    const deadlineAt = Date.now() + OCR_RUNTIME_DOWNLOAD_TOTAL_TIMEOUT_MS;
    const artifacts = getOcrRuntimePack(pack);
    const totalBytes = artifacts.reduce(
      (sum, artifact) => sum + artifact.bytes,
      0,
    );
    let completedBytes = 0;
    for (const artifact of artifacts) {
      const key = ocrRuntimeArtifactKey(artifact);
      const cached = await this.dependencies.store.get(key);
      if (
        cached?.byteLength === artifact.bytes &&
        (await this.dependencies.sha256(cached)) === artifact.sha256
      ) {
        completedBytes += artifact.bytes;
        emit({
          phase: "downloading",
          receivedBytes: completedBytes,
          totalBytes,
        });
        continue;
      }
      if (cached) await this.dependencies.store.delete(key);
      const existingDownload = this.artifactDownloadJobs.get(artifact.id);
      let bytes: Uint8Array;
      if (existingDownload) {
        bytes = await runtimeDownloadTimeout(
          existingDownload,
          remainingRuntimeDownloadMs(deadlineAt),
          () => undefined,
        );
      } else {
        const job = downloadArtifact(
          artifact,
          this.dependencies,
          (received) =>
            emit({
              phase: "downloading",
              receivedBytes: completedBytes + received,
              totalBytes,
            }),
          deadlineAt,
        ).finally(() => {
          if (this.artifactDownloadJobs.get(artifact.id) === job) {
            this.artifactDownloadJobs.delete(artifact.id);
          }
        });
        this.artifactDownloadJobs.set(artifact.id, job);
        bytes = await job;
      }
      emit({
        phase: "storing",
        receivedBytes: completedBytes + bytes.byteLength,
        totalBytes,
      });
      await this.dependencies.store.set(key, bytes);
      completedBytes += bytes.byteLength;
    }
    emit({ phase: "complete", receivedBytes: totalBytes, totalBytes });
  }

  private async persistMetadata(
    code: OcrRuntimeLanguageCode,
    installedAt = this.dependencies.now(),
  ): Promise<OcrRuntimeMetadata> {
    const language = getOcrRuntimeLanguage(code);
    const metadata: OcrRuntimeMetadata = {
      code,
      version: OCR_RUNTIME_PACKAGE_VERSION,
      pack: language.pack,
      bytes: language.artifacts.reduce(
        (sum, artifact) => sum + artifact.bytes,
        0,
      ),
      artifacts: Object.fromEntries(
        language.artifacts.map((artifact) => [artifact.id, artifact.sha256]),
      ),
      installedAt,
    };
    await this.dependencies.store.set(
      runtimeMetadataKey(code),
      serializeMetadata(metadata),
    );
    this.installErrors.delete(language.pack);
    return metadata;
  }

  private async persistPackMetadata(
    pack: OcrRuntimePack,
    installedAt = this.dependencies.now(),
  ): Promise<Map<OcrRuntimeLanguageCode, OcrRuntimeMetadata>> {
    const entries = await Promise.all(
      getOcrRuntimePackage(pack).languages.map(
        async (code) =>
          [code, await this.persistMetadata(code, installedAt)] as const,
      ),
    );
    return new Map(entries);
  }

  private async deletePackMetadata(pack: OcrRuntimePack): Promise<void> {
    await Promise.all(
      getOcrRuntimePackage(pack).languages.map((code) =>
        this.dependencies.store.delete(runtimeMetadataKey(code)),
      ),
    );
  }

  /** Upgrades old per-language markers to the package-level contract. */
  private async ensurePackMetadata(
    pack: OcrRuntimePack,
    artifactVerifications: ArtifactVerificationCache = new Map(),
  ): Promise<OcrRuntimeMetadata | undefined> {
    const runtimePackage = getOcrRuntimePackage(pack);
    const metadata = await Promise.all(
      runtimePackage.languages.map((code) =>
        this.installedMetadata(code, artifactVerifications),
      ),
    );
    const installed = metadata.find(
      (candidate): candidate is OcrRuntimeMetadata => Boolean(candidate),
    );
    if (!installed) return undefined;
    await Promise.all(
      runtimePackage.languages.map((code, index) =>
        metadata[index]
          ? Promise.resolve(metadata[index])
          : this.persistMetadata(code, installed.installedAt),
      ),
    );
    return installed;
  }

  private async installedMetadata(
    code: OcrRuntimeLanguageCode,
    artifactVerifications: ArtifactVerificationCache = new Map(),
    retainVerifiedBytes = false,
  ): Promise<OcrRuntimeMetadata | undefined> {
    const language = getOcrRuntimeLanguage(code);
    const metadata = parseMetadata(
      await this.dependencies.store.get(runtimeMetadataKey(code)),
      code,
    );
    if (!metadata) return undefined;
    const verified = await Promise.all(
      language.artifacts.map((artifact) => {
        const key = ocrRuntimeArtifactKey(artifact);
        const existing = artifactVerifications.get(key);
        if (existing) return existing;
        const verification = (async (): Promise<ArtifactVerification> => {
          const bytes = await this.dependencies.store.get(key);
          if (
            bytes?.byteLength !== artifact.bytes ||
            (await this.dependencies.sha256(bytes)) !== artifact.sha256
          ) {
            return { valid: false };
          }
          return retainVerifiedBytes ? { valid: true, bytes } : { valid: true };
        })();
        artifactVerifications.set(key, verification);
        return verification;
      }),
    );
    return verified.every(({ valid }) => valid) ? metadata : undefined;
  }
}

let defaultStorage: OcrRuntimeStorage | undefined;

function getDefaultStorage(): OcrRuntimeStorage {
  defaultStorage ??= new OcrRuntimeStorage();
  return defaultStorage;
}

export function list(): Promise<OcrRuntimeInfo[]> {
  return getDefaultStorage().list();
}

export function install(
  code: OcrRuntimeLanguageCode,
  options?: OcrRuntimeInstallOptions,
): Promise<OcrRuntimeMetadata> {
  return getDefaultStorage().install(code, options);
}

export function deleteRuntime(
  code: OcrRuntimeLanguageCode,
): Promise<OcrRuntimeDeleteResult> {
  return getDefaultStorage().delete(code);
}

export function installRuntimePack(
  pack: OcrRuntimePack,
  options?: OcrRuntimeInstallOptions,
): Promise<void> {
  return getDefaultStorage().installRuntimePack(pack, options);
}

export function deleteRuntimePack(
  pack: OcrRuntimePack,
): Promise<OcrRuntimeDeleteResult> {
  return getDefaultStorage().deletePack(pack);
}

export function isInstalled(code: OcrRuntimeLanguageCode): Promise<boolean> {
  return getDefaultStorage().isInstalled(code);
}

export function installedLanguages(): Promise<OcrRuntimeLanguageCode[]> {
  return getDefaultStorage().installedLanguages();
}

export function loadRuntime(
  code: OcrRuntimeLanguageCode,
): Promise<LoadedOcrRuntimePack> {
  return getDefaultStorage().load(code);
}
