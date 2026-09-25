import { loadSiteTranslationProfiles } from "@/src/site-profiles/storage";
import { describe, expect, it, vi } from "vitest";

const browserState = vi.hoisted(() => ({
  stored: structuredClone<Record<string, unknown>>({}),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn((key: string) =>
          Promise.resolve({ [key]: browserState.stored[key] }),
        ),
      },
    },
  },
}));

describe("site translation profile storage", () => {
  it("keeps legacy Norixor profiles but disables their AI surfaces", async () => {
    const commonOverride = {
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      mode: "ai",
      fastProvider: "chrome-local",
      modelOverride: "old-managed-model",
    };
    const override = { ...commonOverride, aiRoute: "norixor" };
    const legacyProfile = {
      id: "site-example-com",
      version: 1,
      name: "Example",
      match: { hostnameSuffixes: ["example.com"] },
      overrides: {
        page: { ...override, autoTranslate: true, displayMode: "bilingual" },
        selection: { ...override, enabled: true, targetLanguage: "ko" },
        subtitles: { ...override, enabled: true, hideNativeSubtitles: true },
      },
    };
    browserState.stored.siteTranslationProfiles = [legacyProfile];

    const profiles = await loadSiteTranslationProfiles();

    expect(profiles).toEqual([
      {
        ...legacyProfile,
        overrides: {
          page: {
            ...commonOverride,
            mode: "fast",
            modelOverride: "",
            autoTranslate: false,
            displayMode: "bilingual",
          },
          selection: {
            ...commonOverride,
            mode: "fast",
            modelOverride: "",
            enabled: false,
            targetLanguage: "ko",
          },
          subtitles: {
            ...commonOverride,
            mode: "fast",
            modelOverride: "",
            enabled: false,
            hideNativeSubtitles: true,
          },
        },
      },
    ]);
    expect(legacyProfile.overrides.page.aiRoute).toBe("norixor");
    expect(legacyProfile.overrides.page.autoTranslate).toBe(true);
  });
});
