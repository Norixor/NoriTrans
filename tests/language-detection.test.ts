import {
  detectDominantSourceLanguage,
  dominantScriptSourceLanguageHint,
  hasTranslatableLanguageContent,
  isPredominantlyTargetScript,
} from "@/src/translation/language-detection";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("target script detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes Latin target text in automatically detected CJK pages", () => {
    expect(isPredominantlyTargetScript("sà fēng", "en")).toBe(true);
    expect(isPredominantlyTargetScript("Already in English", "en")).toBe(true);
    expect(isPredominantlyTargetScript("中文内容", "en")).toBe(false);
  });

  it("distinguishes language-bearing text from standalone interface symbols", () => {
    expect(hasTranslatableLanguageContent("f")).toBe(true);
    expect(hasTranslatableLanguageContent("中文")).toBe(true);
    expect(hasTranslatableLanguageContent("⌥")).toBe(false);
    expect(hasTranslatableLanguageContent("⇧ 100% ·")).toBe(false);
  });

  it("does not let a zh-HK declaration override a Latin-dominant fallback", () => {
    expect(
      dominantScriptSourceLanguageHint(
        "2024年 Artificial intelligence is a set of technologies for learning and reasoning.",
        "zh-Hant",
      ),
    ).toBeUndefined();
  });

  it("keeps a reliable detected Chinese variant instead of replacing it from the page declaration", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: vi.fn(() =>
          Promise.resolve({
            isReliable: true,
            languages: [{ language: "zh-CN", percentage: 100 }],
          }),
        ),
      },
    });

    await expect(
      detectDominantSourceLanguage("简体中文内容", "zh-Hant"),
    ).resolves.toBe("zh-CN");
  });
});
