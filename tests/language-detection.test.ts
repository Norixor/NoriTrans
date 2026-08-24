import { isPredominantlyTargetScript } from "@/src/translation/language-detection";
import { describe, expect, it } from "vitest";

describe("target script detection", () => {
  it("recognizes Latin target text in automatically detected CJK pages", () => {
    expect(isPredominantlyTargetScript("sà fēng", "en")).toBe(true);
    expect(isPredominantlyTargetScript("Already in English", "en")).toBe(true);
    expect(isPredominantlyTargetScript("中文内容", "en")).toBe(false);
  });
});
