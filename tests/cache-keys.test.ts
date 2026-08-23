import { describe, expect, it } from "vitest";
import { promptVersion, translationCacheKey } from "@/src/cache/keys";

describe("translation cache keys", () => {
  it("changes when provider, endpoint, model, prompt, language, mode, or text changes", async () => {
    const base = {
      providerId: "provider-a",
      model: "model-a",
      promptVersion: promptVersion("prompt-a"),
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      mode: "ai" as const,
      text: "Hello world",
      scope: "https://provider-a.example/v1",
    };
    const first = await translationCacheKey(base);
    const second = await translationCacheKey({ ...base, model: "model-b" });
    const otherEndpoint = await translationCacheKey({
      ...base,
      scope: "https://provider-b.example/v1",
    });

    expect(first).toHaveLength(64);
    expect(second).not.toBe(first);
    expect(otherEndpoint).not.toBe(first);
  });
});
