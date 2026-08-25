import {
  isSiteTranslationProfile,
  parseSiteTranslationProfile,
} from "@/src/site-profiles/validation";
import { describe, expect, it } from "vitest";

const validProfile = {
  id: "site-example-com",
  version: 1,
  name: "Example",
  match: { hostnameSuffixes: ["example.com"] },
  overrides: {
    page: {
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      mode: "fast",
      fastProvider: "chrome-local",
      modelOverride: "",
    },
  },
};

describe("site translation profile validation", () => {
  it("accepts the independent per-site translation contract", () => {
    expect(parseSiteTranslationProfile(validProfile)).toEqual(validProfile);
  });

  it("accepts site-specific behavior and display settings", () => {
    expect(
      isSiteTranslationProfile({
        ...validProfile,
        overrides: {
          page: {
            ...validProfile.overrides.page,
            displayMode: "bilingual",
            aiResponseMode: "stream",
            autoTranslate: true,
            floatingButtonEnabled: false,
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects settings that do not belong to the selected surface", () => {
    expect(
      isSiteTranslationProfile({
        ...validProfile,
        overrides: {
          page: {
            ...validProfile.overrides.page,
            hideNativeSubtitles: true,
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects unsafe or ambiguous hostname suffixes", () => {
    expect(
      isSiteTranslationProfile({
        ...validProfile,
        match: { hostnameSuffixes: ["*.example.com"] },
      }),
    ).toBe(false);
  });
});
