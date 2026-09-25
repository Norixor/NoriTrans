import {
  createSiteProfileDocument,
  parseSiteProfileDocument,
} from "@/src/site-profiles/document";
import type { SiteTranslationProfile } from "@/src/site-profiles/types";
import { MINIMAL_USER_SITE_PROFILE_TEMPLATE } from "@/src/subtitles/profiles/registry";
import { describe, expect, it } from "vitest";

const translation: SiteTranslationProfile = {
  id: MINIMAL_USER_SITE_PROFILE_TEMPLATE.id,
  version: 1,
  name: "Example.com",
  match: { hostnameSuffixes: ["example.com"] },
  overrides: {
    page: {
      sourceLanguage: "auto",
      targetLanguage: "en",
      mode: "fast",
      fastProvider: "chrome-local",
      modelOverride: "",
    },
  },
};

describe("complete site Profile document", () => {
  it("combines translation surfaces and subtitle capture in one document", () => {
    const document = createSiteProfileDocument(
      translation,
      MINIMAL_USER_SITE_PROFILE_TEMPLATE,
      true,
    );
    const parsed = parseSiteProfileDocument(document);

    expect(parsed.translation.overrides.page?.targetLanguage).toBe("en");
    expect(parsed.capture.selectors.captions).toEqual([".subtitle"]);
    expect(parsed.document.subtitleCapture.customized).toBe(true);
  });

  it("disables removed Norixor routes in an imported Profile document", () => {
    const current = createSiteProfileDocument(
      translation,
      MINIMAL_USER_SITE_PROFILE_TEMPLATE,
      true,
    );
    const shared = {
      sourceLanguage: "ja",
      targetLanguage: "en",
      mode: "ai",
      fastProvider: "chrome-local",
      modelOverride: "old-managed-model",
      aiRoute: "norixor",
    };
    const legacy = {
      ...current,
      overrides: {
        page: { ...shared, autoTranslate: true, displayMode: "bilingual" },
        selection: { ...shared, enabled: true, targetLanguage: "ko" },
        subtitles: { ...shared, enabled: true, hideNativeSubtitles: true },
      },
    };

    const parsed = parseSiteProfileDocument(legacy);
    const expectedOverrides = {
      page: {
        sourceLanguage: "ja",
        targetLanguage: "en",
        mode: "fast",
        fastProvider: "chrome-local",
        modelOverride: "",
        autoTranslate: false,
        displayMode: "bilingual",
      },
      selection: {
        sourceLanguage: "ja",
        targetLanguage: "ko",
        mode: "fast",
        fastProvider: "chrome-local",
        modelOverride: "",
        enabled: false,
      },
      subtitles: {
        sourceLanguage: "ja",
        targetLanguage: "en",
        mode: "fast",
        fastProvider: "chrome-local",
        modelOverride: "",
        enabled: false,
        hideNativeSubtitles: true,
      },
    };
    expect(parsed.translation.overrides).toEqual(expectedOverrides);
    expect(parsed.document.overrides).toEqual(expectedOverrides);
    expect(parsed.document.subtitleCapture).toEqual(current.subtitleCapture);
    expect(legacy.overrides.page.aiRoute).toBe("norixor");
  });

  it("rejects unknown fields in the developer file", () => {
    const document = createSiteProfileDocument(
      translation,
      MINIMAL_USER_SITE_PROFILE_TEMPLATE,
      false,
    );
    expect(() =>
      parseSiteProfileDocument({ ...document, executable: "remote.js" }),
    ).toThrow("invalid_site_profile_document");
  });
});
