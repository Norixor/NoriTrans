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
