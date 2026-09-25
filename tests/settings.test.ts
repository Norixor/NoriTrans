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

  it("disables legacy Norixor routes without forwarding them to configured AI", () => {
    const legacy = {
      norixor: { model: "gpt-5.6-luna" },
      page: {
        aiRoute: "norixor",
        selectionTranslationAiRoute: "norixor",
        mode: "ai",
        autoTranslate: true,
        modelOverride: "old-page-model",
        sourceLanguage: "ja",
        selectionTranslationMode: "ai",
        selectionTranslationEnabled: true,
        selectionTranslationModelOverride: "old-selection-model",
        selectionTranslationTargetLanguage: "ko",
      },
      subtitles: {
        aiRoute: "norixor",
        mode: "ai",
        enabled: true,
        modelOverride: "old-subtitle-model",
        targetLanguage: "fr",
      },
    };
    const settings = mergeSettings(legacy);
    expect("norixor" in settings).toBe(false);
    expect("aiRoute" in settings.page).toBe(false);
    expect("selectionTranslationAiRoute" in settings.page).toBe(false);
    expect("aiRoute" in settings.subtitles).toBe(false);
    expect(settings.page).toMatchObject({
      mode: "fast",
      autoTranslate: false,
      sourceLanguage: "ja",
      selectionTranslationMode: "fast",
      selectionTranslationEnabled: false,
      selectionTranslationModelOverride: "",
      selectionTranslationTargetLanguage: "ko",
    });
    expect(settings.page.modelOverride).toBeUndefined();
    expect(settings.subtitles).toMatchObject({
      mode: "fast",
      enabled: false,
      targetLanguage: "fr",
    });
    expect(settings.subtitles.modelOverride).toBeUndefined();
    const inheritedSelection = mergeSettings({
      page: {
        mode: "ai",
        selectionTranslationAiRoute: "norixor",
      },
    });
    expect(inheritedSelection.page.selectionTranslationMode).toBe("fast");
    expect(inheritedSelection.page.selectionTranslationEnabled).toBe(false);
  });

  it("migrates the unused Norixor default without replacing a configured endpoint", () => {
    const legacyProvider = {
      baseUrl: "https://api.norixor.org/v1",
      model: "gpt-5.6-luna",
    };
    expect(
      mergeSettings({ provider: { ...legacyProvider, apiKey: "" } }).provider,
    ).toMatchObject({
      baseUrl: DEFAULT_SETTINGS.provider.baseUrl,
      model: DEFAULT_SETTINGS.provider.model,
    });
    expect(
      mergeSettings({
        provider: { ...legacyProvider, apiKey: "configured-key" },
      }).provider,
    ).toMatchObject({
      ...legacyProvider,
      apiKey: "configured-key",
    });
  });

  it("migrates the removed AI fast-provider choice into the single AI translation mode", () => {
    expect(
      mergeSettings({
        provider: { fastProvider: "openai-compatible" },
        page: { mode: "fast", selectionTranslationMode: "fast" },
        subtitles: { mode: "fast" },
        imageTranslation: { mode: "fast" },
      }),
    ).toMatchObject({
      provider: {
        fastProvider: "chrome-local",
        aiProvider: "openai-compatible",
      },
      page: { mode: "ai", selectionTranslationMode: "ai" },
      subtitles: { mode: "ai" },
      imageTranslation: { mode: "ai" },
    });
  });

  it("preserves the selected Anthropic Messages AI protocol", () => {
    expect(
      mergeSettings({ provider: { aiProvider: "anthropic-messages" } }).provider
        .aiProvider,
    ).toBe("anthropic-messages");
  });
});
