import { applySiteProfileSettings } from "@/src/shared/site-profile-settings";
import { DEFAULT_SETTINGS, toContentSettings } from "@/src/shared/settings";
import type { SiteTranslationProfile } from "@/src/site-profiles/types";
import { describe, expect, it } from "vitest";

function profile(
  id: string,
  hostname: string,
  overrides: SiteTranslationProfile["overrides"],
): SiteTranslationProfile {
  return {
    id,
    version: 1,
    name: id,
    match: { hostnameSuffixes: [hostname] },
    overrides,
  };
}

describe("site translation profile settings", () => {
  it("inherits global surfaces that are not overridden", () => {
    const globalSettings = toContentSettings(DEFAULT_SETTINGS);
    const effective = applySiteProfileSettings(
      globalSettings,
      [
        profile("user-example", "example.com", {
          page: {
            sourceLanguage: "ja",
            targetLanguage: "en",
            mode: "ai",
            fastProvider: "deepl",
            modelOverride: "site-page-model",
          },
        }),
      ],
      { hostname: "www.example.com", pathname: "/article" },
    );

    expect(effective.page).toMatchObject({
      sourceLanguage: "ja",
      targetLanguage: "en",
      mode: "ai",
      modelOverride: "site-page-model",
      fastProviderOverride: "deepl",
    });
    expect(effective.page.selectionTranslationMode).toBe(
      globalSettings.page.selectionTranslationMode,
    );
    expect(effective.subtitles).toEqual(globalSettings.subtitles);
    expect(effective.activeSiteProfile).toEqual({
      id: "user-example",
      name: "user-example",
    });
  });

  it("uses one most-specific profile without mixing surfaces", () => {
    const globalSettings = toContentSettings(DEFAULT_SETTINGS);
    const lower = profile("user-lower", "example.com", {
      selection: {
        sourceLanguage: "en",
        targetLanguage: "ko",
        mode: "fast",
        fastProvider: "google-translate",
        modelOverride: "",
      },
    });
    const higher = profile("user-higher", "www.example.com", {
      subtitles: {
        sourceLanguage: "ko",
        targetLanguage: "zh-CN",
        mode: "ai",
        fastProvider: "chrome-local",
        modelOverride: "subtitle-model",
      },
    });

    const effective = applySiteProfileSettings(
      globalSettings,
      [higher, lower],
      { hostname: "www.example.com", pathname: "/" },
    );
    expect(effective.page.selectionTranslationTargetLanguage).toBe(
      globalSettings.page.selectionTranslationTargetLanguage,
    );
    expect(effective.subtitles).toMatchObject({
      mode: "ai",
      modelOverride: "subtitle-model",
    });
  });

  it("ignores non-matching profiles", () => {
    const globalSettings = toContentSettings(DEFAULT_SETTINGS);
    expect(
      applySiteProfileSettings(
        globalSettings,
        [profile("user-other", "example.com", {})],
        { hostname: "other.test", pathname: "/" },
      ),
    ).toEqual(globalSettings);
  });

  it("applies site activation, floating controls, response, and display settings", () => {
    const globalSettings = toContentSettings(DEFAULT_SETTINGS);
    const effective = applySiteProfileSettings(
      globalSettings,
      [
        profile("user-complete", "example.com", {
          page: {
            sourceLanguage: "auto",
            targetLanguage: "en",
            mode: "ai",
            fastProvider: "chrome-local",
            modelOverride: "page-model",
            aiResponseMode: "batch",
            displayMode: "bilingual",
            autoTranslate: true,
            floatingButtonEnabled: false,
          },
          selection: {
            sourceLanguage: "auto",
            targetLanguage: "en",
            mode: "fast",
            fastProvider: "deepl",
            modelOverride: "",
            enabled: false,
            aiResponseMode: "stream",
            displayMode: "translated",
          },
          subtitles: {
            sourceLanguage: "en",
            targetLanguage: "zh-CN",
            mode: "ai",
            fastProvider: "chrome-local",
            modelOverride: "subtitle-model",
            enabled: false,
            floatingButtonEnabled: false,
            aiResponseMode: "batch",
            displayMode: "translated",
            hideNativeSubtitles: true,
            position: "custom",
            customPosition: { x: 0.4, y: 0.7 },
            fontScale: 1.4,
            backgroundOpacity: 0.7,
          },
        }),
      ],
      { hostname: "example.com", pathname: "/" },
    );

    expect(effective.page).toMatchObject({
      autoTranslate: true,
      floatingButtonEnabled: false,
      displayMode: "bilingual",
      aiResponseMode: "batch",
      selectionTranslationEnabled: false,
      selectionTranslationDisplayMode: "translated",
    });
    expect(effective.subtitles).toMatchObject({
      enabled: false,
      floatingButtonEnabled: false,
      hideNativeSubtitles: true,
      position: "custom",
      customPosition: { x: 0.4, y: 0.7 },
      fontScale: 1.4,
      backgroundOpacity: 0.7,
    });
  });
});
