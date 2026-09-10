import { NorixorTranslationProvider } from "@/src/translation/providers/norixor";
import {
  createProtectedText,
  validateProtectedTranslation,
} from "@/src/translation/protected-text";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorizedNorixorFetch } = vi.hoisted(() => ({
  authorizedNorixorFetch: vi.fn<typeof fetch>(),
}));

vi.mock("@/src/norixor/session", () => ({
  authorizedNorixorFetch,
  NorixorSessionError: class NorixorSessionError extends Error {},
}));

describe("Norixor translation provider", () => {
  beforeEach(() => {
    authorizedNorixorFetch.mockReset();
  });

  it("uses bounded wire IDs and sends only the selected Norixor model", async () => {
    authorizedNorixorFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            results: [{ id: "s:0", translated_text: "你好" }],
            trace_id: "inv_test",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const progress = vi.fn();
    const results = await new NorixorTranslationProvider(
      "gpt-5.6-luna",
    ).translateBatch(
      {
        sourceLanguage: "zh-Hant",
        targetLanguage: "zh-CN",
        mode: "ai",
        aiRoute: "norixor",
        modelOverride: "must-not-leak",
        prompt: "must-not-leak",
        segments: [
          {
            id: "page id that is not safe on the APP wire",
            text: "Hello",
            contextBefore: ["Earlier context"],
          },
        ],
      },
      new AbortController().signal,
      progress,
    );

    expect(results).toEqual([
      {
        id: "page id that is not safe on the APP wire",
        translatedText: "你好",
      },
    ]);
    expect(progress).toHaveBeenCalledWith(results[0]);
    const init = authorizedNorixorFetch.mock.calls[0]?.[1];
    if (typeof init?.body !== "string") {
      throw new Error("expected JSON request body");
    }
    const body = JSON.parse(init.body) as {
      segments: Array<{
        id: string;
        text_id: string;
        context_before_ids?: string[];
      }>;
      text_catalog: Record<string, string>;
      model?: string;
      prompt?: string;
    };
    expect(body.segments).toEqual([
      {
        id: "s:0",
        text_id: "t:0",
        context_before_ids: ["t:1"],
      },
    ]);
    expect(body.text_catalog).toEqual({
      "t:0": "Hello",
      "t:1": "Earlier context",
    });
    expect(body).toMatchObject({
      source_language: "zh-tw",
      target_language: "zh-cn",
      model: "gpt-5.6-luna",
    });
    expect(body).not.toHaveProperty("prompt");
    expect(body).not.toHaveProperty("modelOverride");
    expect(authorizedNorixorFetch).toHaveBeenCalledWith(
      "/native/translations",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
  });

  it("deduplicates compact context values and bounds each direction", async () => {
    authorizedNorixorFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            results: [
              { id: "s:0", translated_text: "一" },
              { id: "s:1", translated_text: "二" },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    await new NorixorTranslationProvider("deepseek-v4-flash").translateBatch(
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        aiRoute: "norixor",
        segments: [
          {
            id: "one",
            text: "One",
            contextBefore: ["One", "Shared", "Earlier"],
            contextAfter: ["Two", "Shared"],
          },
          {
            id: "two",
            text: "Two",
            contextBefore: ["Shared", "One"],
          },
        ],
      },
      new AbortController().signal,
    );

    const init = authorizedNorixorFetch.mock.calls[0]?.[1];
    if (typeof init?.body !== "string") {
      throw new Error("expected JSON request body");
    }
    expect(JSON.parse(init.body)).toMatchObject({
      text_catalog: {
        "t:0": "One",
        "t:1": "Two",
        "t:2": "Shared",
        "t:3": "Earlier",
      },
      segments: [
        {
          id: "s:0",
          text_id: "t:0",
          context_before_ids: ["t:2", "t:3"],
          context_after_ids: ["t:1", "t:2"],
        },
        {
          id: "s:1",
          text_id: "t:1",
          context_before_ids: ["t:2", "t:0"],
        },
      ],
    });
  });

  it("translates protected parts without exposing marker syntax to the model", async () => {
    const source = createProtectedText(["Read ", "the documentation", "."]);
    authorizedNorixorFetch.mockImplementation((...args) => {
      const init = args[1];
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON request body");
      }
      const body = JSON.parse(init.body) as {
        text_catalog: Record<string, string>;
        segments: Array<{ id: string; text_id: string }>;
      };
      expect(Object.values(body.text_catalog).join(" ")).not.toContain("NT1:");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              results: body.segments.map((segment) => ({
                id: segment.id,
                translated_text: `译:${body.text_catalog[segment.text_id]}`,
              })),
            },
          }),
          { status: 200 },
        ),
      );
    });

    const progress = vi.fn();
    const results = await new NorixorTranslationProvider(
      "deepseek-v4-flash",
    ).translateBatch(
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        aiRoute: "norixor",
        segments: [
          {
            id: "protected",
            text: source,
            format: "protected-text-v1",
          },
        ],
      },
      new AbortController().signal,
      progress,
    );

    expect(
      validateProtectedTranslation(source, results[0]!.translatedText),
    ).toEqual(["译:Read ", "译:the documentation", "."]);
    expect(progress).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(results[0]);
  });

  it("keeps protected-part wire batches within the APP limit", async () => {
    const source = createProtectedText(
      Array.from({ length: 55 }, (_, index) => `word-${index}`),
    );
    authorizedNorixorFetch.mockImplementation((...args) => {
      const init = args[1];
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON request body");
      }
      const body = JSON.parse(init.body) as {
        text_catalog: Record<string, string>;
        segments: Array<{ id: string; text_id: string }>;
      };
      expect(body.segments.length).toBeLessThanOrEqual(50);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              results: body.segments.map((segment) => ({
                id: segment.id,
                translated_text: body.text_catalog[segment.text_id],
              })),
            },
          }),
          { status: 200 },
        ),
      );
    });

    const [result] = await new NorixorTranslationProvider(
      "deepseek-v4-flash",
    ).translateBatch(
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        aiRoute: "norixor",
        segments: [
          {
            id: "many-parts",
            text: source,
            format: "protected-text-v1",
          },
        ],
      },
      new AbortController().signal,
    );

    expect(authorizedNorixorFetch).toHaveBeenCalledTimes(2);
    expect(
      validateProtectedTranslation(source, result!.translatedText),
    ).toHaveLength(55);
  });

  it("rejects missing, duplicate, and unknown result IDs", async () => {
    const request = {
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      mode: "ai" as const,
      aiRoute: "norixor" as const,
      segments: [
        { id: "one", text: "One" },
        { id: "two", text: "Two" },
      ],
    };
    for (const results of [
      [{ id: "s:0", translated_text: "一" }],
      [
        { id: "s:0", translated_text: "一" },
        { id: "s:0", translated_text: "重复" },
      ],
      [
        { id: "s:0", translated_text: "一" },
        { id: "unknown", translated_text: "二" },
      ],
    ]) {
      authorizedNorixorFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { results } }), { status: 200 }),
      );
      await expect(
        new NorixorTranslationProvider("deepseek-v4-flash").translateBatch(
          request,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("reports bounded stable details for rejected translation batches", async () => {
    authorizedNorixorFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "noritrans_translation_invalid_request",
            message: "A segment contains duplicate context references",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      new NorixorTranslationProvider("deepseek-v4-flash").translateBatch(
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          aiRoute: "norixor",
          segments: [{ id: "one", text: "One" }],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "request_failed",
      retryable: false,
      details:
        "HTTP 400; code=noritrans_translation_invalid_request; message=A segment contains duplicate context references",
    });
  });

  it.each([
    ["noritrans_translation_invalid_response", "invalid_response", false],
    ["gateway_unavailable", "request_failed", true],
  ])(
    "classifies a 503 with stable code %s",
    async (code, expectedCode, retryable) => {
      authorizedNorixorFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code, message: "Result rejected" } }),
          {
            status: 503,
          },
        ),
      );
      const progress = vi.fn();
      await expect(
        new NorixorTranslationProvider("deepseek-v4-flash").translateBatch(
          {
            sourceLanguage: "en",
            targetLanguage: "zh-CN",
            mode: "ai",
            aiRoute: "norixor",
            segments: [{ id: "one", text: "One" }],
          },
          new AbortController().signal,
          progress,
        ),
      ).rejects.toMatchObject({
        code: expectedCode,
        retryable,
        details: `HTTP 503; code=${code}; message=Result rejected`,
      });
      expect(authorizedNorixorFetch).toHaveBeenCalledOnce();
      expect(progress).not.toHaveBeenCalled();
    },
  );
});
