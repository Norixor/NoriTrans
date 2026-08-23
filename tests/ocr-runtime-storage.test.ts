import {
  getOcrRuntimeLanguage,
  OCR_RUNTIME_CATALOG,
  ocrRuntimeCodeForTranslationLanguage,
  type OcrRuntimeArtifact,
} from "@/src/ocr/runtime-catalog";
import {
  OcrRuntimeStorage,
  ocrRuntimeArtifactKey,
  type OcrRuntimeByteStore,
  type OcrRuntimeInstallProgress,
  type OcrRuntimeStorageDependencies,
} from "@/src/ocr/runtime-storage";
import { selectInstalledOcrRuntime } from "@/src/ocr/languages";
import { describe, expect, it, vi } from "vitest";

class FakeByteStore implements OcrRuntimeByteStore {
  readonly values = new Map<string, Uint8Array>();
  failSet = false;

  get(key: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  size(key: string): Promise<number | undefined> {
    return Promise.resolve(this.values.get(key)?.byteLength);
  }

  set(key: string, value: Uint8Array): Promise<void> {
    if (this.failSet) return Promise.reject(new Error("runtime write failed"));
    this.values.set(key, value.slice());
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

const ALL_ARTIFACTS = new Map(
  OCR_RUNTIME_CATALOG.flatMap((language) => language.artifacts).map(
    (artifact) => [artifact.url, artifact],
  ),
);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function artifactResponse(
  artifact: OcrRuntimeArtifact,
  overrides: { contentType?: string; bytes?: number; status?: number } = {},
): Response {
  const bytes = overrides.bytes ?? artifact.bytes;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  return new Response(body, {
    status: overrides.status ?? 200,
    headers: {
      "content-length": String(bytes),
      "content-type":
        overrides.contentType ??
        artifact.contentTypes.at(0) ??
        "application/octet-stream",
    },
  });
}

function slowArtifactResponse(
  artifact: OcrRuntimeArtifact,
  chunkDelayMs: number,
  chunkCount: number,
): Response {
  let emitted = 0;
  let remaining = artifact.bytes;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
      const chunksLeft = chunkCount - emitted;
      const size =
        chunksLeft <= 1 ? remaining : Math.floor(remaining / chunksLeft);
      controller.enqueue(new Uint8Array(size));
      emitted += 1;
      remaining -= size;
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-length": String(artifact.bytes),
      "content-type": artifact.contentTypes.at(0) ?? "application/octet-stream",
    },
  });
}

function dependencies(
  overrides: Partial<OcrRuntimeStorageDependencies> = {},
): OcrRuntimeStorageDependencies & { store: FakeByteStore } {
  const store = new FakeByteStore();
  return {
    fetch: vi.fn((input: RequestInfo | URL) => {
      const artifact = ALL_ARTIFACTS.get(requestUrl(input));
      return Promise.resolve(
        artifact
          ? artifactResponse(artifact)
          : new Response("missing", { status: 404 }),
      );
    }),
    store,
    now: () => 1_777_777_777_777,
    sha256: vi.fn((bytes: Uint8Array) => {
      const artifact = [...ALL_ARTIFACTS.values()].find(
        (candidate) => candidate.bytes === bytes.byteLength,
      );
      return Promise.resolve(artifact?.sha256 ?? "invalid");
    }),
    ...overrides,
  } as OcrRuntimeStorageDependencies & { store: FakeByteStore };
}

describe("OCR runtime catalog", () => {
  it("maps eight logical languages to three pinned PP-OCRv5 packs", () => {
    expect(OCR_RUNTIME_CATALOG.map((entry) => entry.code)).toEqual([
      "eng",
      "chi_sim",
      "chi_tra",
      "jpn",
      "kor",
      "spa",
      "fra",
      "deu",
    ]);
    expect(getOcrRuntimeLanguage("chi_tra")).toMatchObject({
      labelKey: "ocrRuntimeLanguageChineseTraditional",
      pack: "zh",
      version: "ppocr-v5-mobile-2025-08-logical-v2",
      source: {
        url: "https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models",
      },
      license: { spdx: "Apache-2.0" },
    });
    expect(getOcrRuntimeLanguage("chi_tra").artifacts).toHaveLength(3);
    expect(getOcrRuntimeLanguage("jpn").artifacts).toEqual(
      getOcrRuntimeLanguage("chi_sim").artifacts,
    );
    expect(ocrRuntimeCodeForTranslationLanguage("zh_Hant")).toBe("chi_tra");
    expect(ocrRuntimeCodeForTranslationLanguage("de")).toBe("deu");
    expect(ocrRuntimeCodeForTranslationLanguage("auto")).toBeUndefined();
  });

  it("selects an explicitly installed runtime for automatic OCR without downloading", () => {
    expect(selectInstalledOcrRuntime("auto", ["eng"])).toBe("eng");
    expect(selectInstalledOcrRuntime("auto", ["chi_sim"])).toBe("chi_sim");
    expect(selectInstalledOcrRuntime("auto", ["kor"])).toBe("kor");
    expect(selectInstalledOcrRuntime("auto", ["spa"])).toBe("spa");
    expect(selectInstalledOcrRuntime("auto", ["kor", "eng"])).toBe("eng");
    expect(selectInstalledOcrRuntime("ko", ["eng", "kor"])).toBe("kor");
    expect(selectInstalledOcrRuntime("ko", ["eng"])).toBeUndefined();
    expect(selectInstalledOcrRuntime("auto", [])).toBeUndefined();
  });
});

describe("OcrRuntimeStorage", () => {
  it("installs only the explicitly requested logical language", async () => {
    const progress: OcrRuntimeInstallProgress[] = [];
    const deps = dependencies();
    const storage = new OcrRuntimeStorage(deps);

    const metadata = await storage.install("spa", {
      onProgress: (event) => progress.push(event),
    });

    expect(metadata).toMatchObject({
      code: "spa",
      pack: "latin",
      version: "ppocr-v5-mobile-2025-08-logical-v2",
      installedAt: 1_777_777_777_777,
    });
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(progress.at(-1)).toMatchObject({
      phase: "complete",
      receivedBytes: metadata.bytes,
      totalBytes: metadata.bytes,
    });
    expect(await storage.installedLanguages()).toEqual(["spa"]);
    expect(await storage.isInstalled("fra")).toBe(false);
    expect(await storage.list()).toContainEqual({
      language: "spa",
      labelKey: "ocrRuntimeLanguageSpanish",
      state: "installed",
      bytes: metadata.bytes,
    });
  });

  it("deduplicates concurrent installation requests for one shared pack", async () => {
    const deps = dependencies();
    const storage = new OcrRuntimeStorage(deps);
    const firstProgress: OcrRuntimeInstallProgress[] = [];
    const secondProgress: OcrRuntimeInstallProgress[] = [];

    await Promise.all([
      storage.install("chi_sim", {
        onProgress: (event) => firstProgress.push(event),
      }),
      storage.install("jpn", {
        onProgress: (event) => secondProgress.push(event),
      }),
    ]);

    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(firstProgress.at(-1)?.phase).toBe("complete");
    expect(secondProgress.at(-1)?.phase).toBe("complete");
    expect(await storage.installedLanguages()).toEqual(["chi_sim", "jpn"]);
  });

  it("deduplicates the shared detection artifact across concurrent packs", async () => {
    const deps = dependencies();
    const storage = new OcrRuntimeStorage(deps);

    await Promise.all([storage.install("chi_sim"), storage.install("spa")]);

    expect(deps.fetch).toHaveBeenCalledTimes(5);
    expect(await storage.installedLanguages()).toEqual(["chi_sim", "spa"]);
  });

  it("does not redownload an already installed sibling language", async () => {
    const deps = dependencies();
    const storage = new OcrRuntimeStorage(deps);
    await storage.install("spa");
    await storage.install("deu");
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(await storage.installedLanguages()).toEqual(["spa", "deu"]);
  });

  it("reuses cached artifacts while replacing ambiguous legacy markers", async () => {
    const deps = dependencies();
    const language = getOcrRuntimeLanguage("eng");
    for (const artifact of language.artifacts) {
      deps.store.values.set(
        ocrRuntimeArtifactKey(artifact),
        new Uint8Array(artifact.bytes),
      );
    }
    deps.store.values.set(
      "metadata:eng",
      new TextEncoder().encode(
        JSON.stringify({
          code: "eng",
          version: "ppocr-v5-mobile-2025-08",
          pack: "zh",
          bytes: language.artifacts.reduce(
            (sum, artifact) => sum + artifact.bytes,
            0,
          ),
          artifacts: Object.fromEntries(
            language.artifacts.map((artifact) => [
              artifact.id,
              artifact.sha256,
            ]),
          ),
          installedAt: 1_777_777_777_777,
        }),
      ),
    );
    const storage = new OcrRuntimeStorage(deps);

    expect(await storage.isInstalled("eng")).toBe(false);
    await storage.install("eng");

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(await storage.installedLanguages()).toEqual(["eng"]);
  });

  it("loads extension-local model buffers without any network request", async () => {
    const deps = dependencies();
    const storage = new OcrRuntimeStorage(deps);
    await storage.install("kor");
    vi.mocked(deps.fetch).mockClear();

    const runtime = await storage.load("kor");

    expect(runtime.pack).toBe("korean");
    expect(runtime.detection.byteLength).toBe(
      getOcrRuntimeLanguage("kor").artifacts[0]?.bytes,
    );
    expect(runtime.recognition.byteLength).toBeGreaterThan(10_000_000);
    expect(runtime.dictionary.byteLength).toBeGreaterThan(1_000);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("reads and hashes each runtime artifact only once while loading", async () => {
    const deps = dependencies();
    const storage = new OcrRuntimeStorage(deps);
    await storage.install("eng");
    const get = vi.spyOn(deps.store, "get");
    vi.mocked(deps.sha256).mockClear();

    await storage.load("eng");

    expect(get).toHaveBeenCalledTimes(4);
    expect(get.mock.calls.map(([key]) => key)).toEqual([
      "metadata:eng",
      ...getOcrRuntimeLanguage("eng").artifacts.map(ocrRuntimeArtifactKey),
    ]);
    expect(deps.sha256).toHaveBeenCalledTimes(3);
  });

  it("rejects corrupted runtime bytes while loading", async () => {
    const deps = dependencies({
      sha256: vi.fn((bytes: Uint8Array) => {
        if (bytes[0] === 255) return Promise.resolve("0".repeat(64));
        const artifact = [...ALL_ARTIFACTS.values()].find(
          (candidate) => candidate.bytes === bytes.byteLength,
        );
        return Promise.resolve(artifact?.sha256 ?? "invalid");
      }),
    });
    const storage = new OcrRuntimeStorage(deps);
    await storage.install("eng");
    const artifact = getOcrRuntimeLanguage("eng").artifacts[1];
    if (!artifact) throw new Error("missing OCR runtime artifact");
    const stored = deps.store.values.get(ocrRuntimeArtifactKey(artifact));
    if (!stored) throw new Error("missing installed OCR runtime bytes");
    stored[0] = 255;

    await expect(storage.load("eng")).rejects.toThrow(
      "ocr_runtime_missing:eng",
    );
  });

  it("does not report a same-size corrupted runtime as installed", async () => {
    const deps = dependencies({
      sha256: vi.fn((bytes: Uint8Array) => {
        if (bytes[0] === 255) return Promise.resolve("0".repeat(64));
        const artifact = [...ALL_ARTIFACTS.values()].find(
          (candidate) => candidate.bytes === bytes.byteLength,
        );
        return Promise.resolve(artifact?.sha256 ?? "invalid");
      }),
    });
    const storage = new OcrRuntimeStorage(deps);
    await storage.install("eng");
    const artifact = getOcrRuntimeLanguage("eng").artifacts[1];
    if (!artifact) throw new Error("missing OCR runtime artifact");
    const stored = deps.store.values.get(ocrRuntimeArtifactKey(artifact));
    if (!stored) throw new Error("missing installed OCR runtime bytes");
    stored[0] = 255;

    expect(await storage.isInstalled("eng")).toBe(false);
    expect(await storage.list()).toContainEqual({
      language: "eng",
      labelKey: "ocrRuntimeLanguageEnglish",
      state: "missing",
    });
  });

  it.each([
    ["HTTP status", { status: 404 }, /HTTP 404/u],
    ["content type", { contentType: "text/html" }, /Content-Type/u],
    ["content length", { bytes: 1 }, /unexpected size|pinned size/u],
  ])(
    "rejects an invalid %s response without marking the pack installed",
    async (_name, responseOverrides, expected) => {
      const language = getOcrRuntimeLanguage("kor");
      const deps = dependencies({
        fetch: vi.fn((input: RequestInfo | URL) => {
          const artifact = ALL_ARTIFACTS.get(requestUrl(input));
          return Promise.resolve(
            artifact
              ? artifactResponse(artifact, responseOverrides)
              : new Response("missing", { status: 404 }),
          );
        }),
      });
      const storage = new OcrRuntimeStorage(deps);

      await expect(storage.install(language.code)).rejects.toThrow(expected);
      expect(await storage.isInstalled(language.code)).toBe(false);
    },
  );

  it("rejects a hash mismatch and exposes only a bounded safe error", async () => {
    const deps = dependencies({
      sha256: vi.fn(() => Promise.resolve("0".repeat(64))),
    });
    const storage = new OcrRuntimeStorage(deps);

    await expect(storage.install("chi_sim")).rejects.toThrow(/integrity/u);
    expect(await storage.list()).toContainEqual({
      language: "chi_sim",
      labelKey: "ocrRuntimeLanguageChineseSimplified",
      state: "error",
      message: "OCR runtime download failed its integrity check.",
    });
  });

  it("does not leak an untrusted failure body into the runtime manager", async () => {
    const deps = dependencies({
      fetch: vi.fn(() =>
        Promise.reject(new Error(`secret ${"user text ".repeat(30)}`)),
      ),
    });
    const storage = new OcrRuntimeStorage(deps);

    await expect(storage.install("chi_tra")).rejects.toThrow("secret");
    expect(await storage.list()).toContainEqual({
      language: "chi_tra",
      labelKey: "ocrRuntimeLanguageChineseTraditional",
      state: "error",
      message: "OCR runtime installation failed.",
    });
  });

  it("times out a stalled runtime download and permits a later retry", async () => {
    vi.useFakeTimers();
    try {
      let firstRequest = true;
      const deps = dependencies({
        fetch: vi.fn((input: RequestInfo | URL) => {
          if (firstRequest) {
            firstRequest = false;
            return new Promise<Response>(() => undefined);
          }
          const artifact = ALL_ARTIFACTS.get(requestUrl(input));
          return Promise.resolve(
            artifact
              ? artifactResponse(artifact)
              : new Response("missing", { status: 404 }),
          );
        }),
      });
      const storage = new OcrRuntimeStorage(deps);
      const firstInstall = storage.install("eng");
      const firstFailure = expect(firstInstall).rejects.toThrow(
        "OCR runtime download timed out.",
      );

      await vi.advanceTimersByTimeAsync(30_001);
      await firstFailure;
      expect(await storage.list()).toContainEqual({
        language: "eng",
        labelKey: "ocrRuntimeLanguageEnglish",
        state: "error",
        message: "OCR runtime download timed out.",
      });

      await storage.install("eng");
      expect(await storage.isInstalled("eng")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies one total deadline across every artifact in a pack", async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies({
        fetch: vi.fn((input: RequestInfo | URL) => {
          const artifact = ALL_ARTIFACTS.get(requestUrl(input));
          return Promise.resolve(
            artifact
              ? slowArtifactResponse(artifact, 25_000, 6)
              : new Response("missing", { status: 404 }),
          );
        }),
      });
      const storage = new OcrRuntimeStorage(deps);
      const install = storage.install("eng");
      const failure = expect(install).rejects.toThrow(
        "OCR runtime download timed out.",
      );

      await vi.advanceTimersByTimeAsync(180_001);
      await failure;
      expect(deps.fetch).toHaveBeenCalledTimes(2);
      expect(await storage.isInstalled("eng")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deleting one logical language preserves unrelated installed packs", async () => {
    const deps = dependencies();
    const storage = new OcrRuntimeStorage(deps);
    await storage.install("spa");
    await storage.install("chi_sim");

    const result = await storage.delete("spa");

    expect(await storage.isInstalled("spa")).toBe(false);
    expect(await storage.isInstalled("fra")).toBe(false);
    expect(await storage.isInstalled("chi_sim")).toBe(true);
    expect(result).toEqual({ pack: "latin", physicalPackDeleted: true });
    expect(
      deps.store.values.has(
        ocrRuntimeArtifactKey(getOcrRuntimeLanguage("spa").artifacts[1]!),
      ),
    ).toBe(false);
  });

  it("keeps shared artifacts while another explicitly installed language uses them", async () => {
    const deps = dependencies();
    const storage = new OcrRuntimeStorage(deps);
    await storage.install("spa");
    await storage.install("fra");

    const result = await storage.delete("spa");

    expect(await storage.isInstalled("spa")).toBe(false);
    expect(await storage.isInstalled("fra")).toBe(true);
    expect(result).toEqual({ pack: "latin", physicalPackDeleted: false });
    expect(
      deps.store.values.has(
        ocrRuntimeArtifactKey(getOcrRuntimeLanguage("fra").artifacts[1]!),
      ),
    ).toBe(true);
  });

  it("clears an installation error when deleting the pack", async () => {
    const deps = dependencies({
      fetch: vi.fn(() => Promise.reject(new Error("untrusted response body"))),
    });
    const storage = new OcrRuntimeStorage(deps);
    await expect(storage.install("jpn")).rejects.toThrow();

    await storage.delete("jpn");

    expect(await storage.list()).toContainEqual({
      language: "jpn",
      labelKey: "ocrRuntimeLanguageJapanese",
      state: "missing",
    });
  });
});
