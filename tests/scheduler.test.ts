import { describe, expect, it, vi } from "vitest";
import {
  normalizeTranslationText,
  scheduleTranslation,
} from "@/src/translation/scheduler";
import type { TranslationProvider } from "@/src/translation/types";
import { NoriTransError } from "@/src/shared/errors";
import { createProtectedText } from "@/src/translation/protected-text";

describe("scheduleTranslation", () => {
  it("preserves protected format through normalization, provider progress, and output", async () => {
    const source = createProtectedText(["Hello ", "world"]);
    const translated = source
      .replace("Hello ", "你好")
      .replace("world", "世界");
    const requests: unknown[] = [];
    const provider: TranslationProvider = {
      id: "protected-format",
      mode: "ai",
      capabilities: {
        maxBatchCharacters: 1_000,
        maxBatchSegments: 10,
        supportsContext: true,
        runtime: "background",
      },
      translateBatch: async (providerRequest, _signal, onProgress) => {
        requests.push(structuredClone(providerRequest));
        await onProgress?.({ id: "protected", translatedText: translated });
        return [{ id: "protected", translatedText: translated }];
      },
    };
    const progress = vi.fn();

    await expect(
      scheduleTranslation(
        provider,
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [
            { id: "protected", text: source, format: "protected-text-v1" },
          ],
        },
        new AbortController().signal,
        progress,
      ),
    ).resolves.toEqual([{ id: "protected", translatedText: translated }]);
    expect(requests).toMatchObject([
      { segments: [{ id: "protected", format: "protected-text-v1" }] },
    ]);
    expect(progress).toHaveBeenCalledOnce();
  });

  it("rejects invalid protected stream results before publishing progress", async () => {
    const source = createProtectedText(["Hello", "world"]);
    const provider: TranslationProvider = {
      id: "invalid-protected-progress",
      mode: "ai",
      capabilities: {
        maxBatchCharacters: 1_000,
        maxBatchSegments: 10,
        supportsContext: true,
        runtime: "background",
      },
      translateBatch: async (_request, _signal, onProgress) => {
        await onProgress?.({
          id: "protected",
          translatedText: source.replace(/:1:close\uE001/u, ":9:close\uE001"),
        });
        return [];
      },
    };
    const progress = vi.fn();

    await expect(
      scheduleTranslation(
        provider,
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [
            { id: "protected", text: source, format: "protected-text-v1" },
          ],
        },
        new AbortController().signal,
        progress,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(progress).not.toHaveBeenCalled();
  });

  it("normalizes and sends repeated text once while expanding every original ID", async () => {
    const requests: unknown[] = [];
    const progress: string[] = [];
    const provider: TranslationProvider = {
      id: "normalized-deduplication",
      mode: "ai",
      capabilities: {
        maxBatchCharacters: 100,
        maxBatchSegments: 10,
        supportsContext: true,
        runtime: "background",
      },
      translateBatch: async (request, _signal, onProgress) => {
        requests.push(structuredClone(request));
        await onProgress?.({ id: "first", translatedText: "咖啡菜单" });
        return [{ id: "first", translatedText: "咖啡菜单" }];
      },
    };

    const results = await scheduleTranslation(
      provider,
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        segments: [
          { id: "first", text: "Café  menu" },
          { id: "second", text: "Cafe\u0301\nmenu" },
          { id: "third", text: " Café menu " },
        ],
      },
      new AbortController().signal,
      (result) => {
        progress.push(result.id);
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      segments: [{ id: "first", text: "Café menu" }],
    });
    expect(results).toEqual([
      { id: "first", translatedText: "咖啡菜单" },
      { id: "second", translatedText: "咖啡菜单" },
      { id: "third", translatedText: "咖啡菜单" },
    ]);
    expect(progress).toEqual(["first", "second", "third"]);
  });

  it("does not merge text that only differs by letter case", () => {
    expect(normalizeTranslationText("  Hello\n world  ")).toBe("Hello world");
    expect(normalizeTranslationText("Hello")).not.toBe(
      normalizeTranslationText("hello"),
    );
  });

  it("publishes each validated progress result as soon as it arrives", async () => {
    const events: string[] = [];
    const provider: TranslationProvider = {
      id: "progress",
      mode: "ai",
      capabilities: {
        maxBatchCharacters: 100,
        maxBatchSegments: 10,
        supportsContext: true,
        runtime: "background",
      },
      translateBatch: async (request, _signal, onProgress) => {
        await onProgress?.({ id: "2", translatedText: "two" });
        expect(events).toEqual(["2"]);
        await onProgress?.({ id: "1", translatedText: "one" });
        expect(events).toEqual(["2", "1"]);
        return request.segments.map((segment) => ({
          id: segment.id,
          translatedText: segment.id === "1" ? "one" : "two",
        }));
      },
    };

    const results = await scheduleTranslation(
      provider,
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        segments: [
          { id: "1", text: "one" },
          { id: "2", text: "two" },
        ],
      },
      new AbortController().signal,
      (result) => {
        events.push(result.id);
      },
    );

    expect(results.map((result) => result.id)).toEqual(["1", "2"]);
    expect(events).toEqual(["2", "1"]);
  });

  it("batches requests and keeps every ID", async () => {
    const provider: TranslationProvider = {
      id: "test",
      mode: "ai",
      capabilities: {
        maxBatchCharacters: 100,
        maxBatchSegments: 2,
        supportsContext: true,
        runtime: "background",
      },
      translateBatch: (request) =>
        Promise.resolve(
          request.segments.map((segment) => ({
            id: segment.id,
            translatedText: `T:${segment.text}`,
          })),
        ),
    };

    const results = await scheduleTranslation(
      provider,
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        segments: [
          { id: "1", text: "one" },
          { id: "2", text: "two" },
          { id: "3", text: "three" },
        ],
      },
      new AbortController().signal,
    );

    expect(results.map((result) => result.id)).toEqual(["1", "2", "3"]);
  });

  it("counts neighboring context against the provider character limit", async () => {
    const calls: string[][] = [];
    const provider: TranslationProvider = {
      id: "context-limit",
      mode: "ai",
      capabilities: {
        maxBatchCharacters: 12,
        maxBatchSegments: 10,
        supportsContext: true,
        runtime: "background",
      },
      translateBatch: (request) => {
        calls.push(request.segments.map((segment) => segment.id));
        return Promise.resolve(
          request.segments.map((segment) => ({
            id: segment.id,
            translatedText: `T:${segment.text}`,
          })),
        );
      },
    };

    await scheduleTranslation(
      provider,
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        segments: [
          { id: "1", text: "one", contextAfter: ["123456"] },
          { id: "2", text: "two", contextBefore: ["123456"] },
        ],
      },
      new AbortController().signal,
    );

    expect(calls).toEqual([["1"], ["2"]]);
  });

  it("rejects a single segment that exceeds the provider character limit", async () => {
    const translateBatch = vi.fn(() =>
      Promise.resolve([{ id: "large", translatedText: "translated" }]),
    );
    const provider: TranslationProvider = {
      id: "small-provider",
      mode: "ai",
      capabilities: {
        maxBatchCharacters: 5,
        maxBatchSegments: 10,
        supportsContext: true,
        runtime: "background",
      },
      translateBatch,
    };

    await expect(
      scheduleTranslation(
        provider,
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [{ id: "large", text: "123456" }],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "request_failed", retryable: false });
    expect(translateBatch).not.toHaveBeenCalled();
  });

  it("rejects missing IDs", async () => {
    const provider: TranslationProvider = {
      id: "broken",
      mode: "ai",
      capabilities: {
        maxBatchCharacters: 100,
        maxBatchSegments: 10,
        supportsContext: true,
        runtime: "background",
      },
      translateBatch: () => Promise.resolve([]),
    };

    const error: unknown = await scheduleTranslation(
      provider,
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        segments: [{ id: "1", text: "one" }],
      },
      new AbortController().signal,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NoriTransError);
    if (!(error instanceof NoriTransError)) return;
    expect(error.code).toBe("invalid_response");
    expect(error.details).toContain("Missing result IDs: 1");
  });

  it("rejects duplicate request IDs and blank translations", async () => {
    const duplicateProvider: TranslationProvider = {
      id: "duplicate",
      mode: "ai",
      capabilities: {
        maxBatchCharacters: 100,
        maxBatchSegments: 10,
        supportsContext: true,
        runtime: "background",
      },
      translateBatch: () =>
        Promise.resolve([{ id: "same", translatedText: "one" }]),
    };
    await expect(
      scheduleTranslation(
        duplicateProvider,
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [
            { id: "same", text: "one" },
            { id: "same", text: "two" },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });

    const blankProvider = {
      ...duplicateProvider,
      translateBatch: () =>
        Promise.resolve([{ id: "only", translatedText: "   " }]),
    };
    await expect(
      scheduleTranslation(
        blankProvider,
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [{ id: "only", text: "one" }],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
