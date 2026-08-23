import {
  DEFAULT_SETTINGS,
  mergeSettings,
  toContentSettings,
} from "@/src/shared/settings";
import { describe, expect, it } from "vitest";

describe("settings compatibility", () => {
  it("enables selection translation by default", () => {
    expect(DEFAULT_SETTINGS.page.selectionTranslationEnabled).toBe(true);
    expect(
      toContentSettings(DEFAULT_SETTINGS).page.selectionTranslationEnabled,
    ).toBe(true);
    expect(DEFAULT_SETTINGS.page.selectionTranslationMode).toBe("fast");
  });

  it("adds the default to legacy saved page settings", () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as unknown as {
      page: Record<string, unknown>;
    };
    delete legacy.page.selectionTranslationEnabled;
    delete legacy.page.selectionTranslationMode;

    expect(mergeSettings(legacy).page.selectionTranslationEnabled).toBe(true);
    expect(mergeSettings(legacy).page.selectionTranslationMode).toBe("fast");
  });

  it("preserves legacy selection behavior while allowing an independent mode", () => {
    expect(
      mergeSettings({ page: { mode: "ai" } }).page.selectionTranslationMode,
    ).toBe("ai");
    expect(
      mergeSettings({
        page: { mode: "ai", selectionTranslationMode: "fast" },
      }).page.selectionTranslationMode,
    ).toBe("fast");
  });

  it("defaults legacy AI responses to streaming and preserves batch choices", () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as unknown as {
      page: Record<string, unknown>;
      subtitles: Record<string, unknown>;
    };
    delete legacy.page.aiResponseMode;
    delete legacy.subtitles.aiResponseMode;

    expect(mergeSettings(legacy)).toMatchObject({
      page: { aiResponseMode: "stream" },
      subtitles: { aiResponseMode: "stream" },
    });
    expect(
      mergeSettings({
        page: { aiResponseMode: "batch" },
        subtitles: { aiResponseMode: "batch" },
      }),
    ).toMatchObject({
      page: { aiResponseMode: "batch" },
      subtitles: { aiResponseMode: "batch" },
    });
  });

  it("preserves an explicit disabled selection setting", () => {
    expect(
      mergeSettings({
        page: { selectionTranslationEnabled: false },
      }).page.selectionTranslationEnabled,
    ).toBe(false);
  });
});
