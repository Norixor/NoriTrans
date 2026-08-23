import { languageTagsMatch } from "@/src/shared/languages";
import { describe, expect, it } from "vitest";

describe("languageTagsMatch", () => {
  it("matches equivalent Chinese region and script tags", () => {
    expect(languageTagsMatch("zh-CN", "zh-Hans")).toBe(true);
    expect(languageTagsMatch("zh-Hant", "zh-TW")).toBe(true);
    expect(languageTagsMatch("zh-Hant", "zh-HK")).toBe(true);
  });

  it("does not merge simplified and traditional Chinese tracks", () => {
    expect(languageTagsMatch("zh-CN", "zh-Hant")).toBe(false);
    expect(languageTagsMatch("zh-TW", "zh-Hans")).toBe(false);
  });

  it("accepts generic and same-primary non-Chinese caption tags", () => {
    expect(languageTagsMatch("en", "en-US")).toBe(true);
    expect(languageTagsMatch("en-US", "en-GB")).toBe(true);
    expect(languageTagsMatch("en", "fr")).toBe(false);
  });
});
