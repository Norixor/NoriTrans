import {
  hasTranslatableLanguageContent,
  isPredominantlyTargetScript,
} from "@/src/translation/language-detection";
import { describe, expect, it } from "vitest";

describe("target script detection", () => {
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
});
