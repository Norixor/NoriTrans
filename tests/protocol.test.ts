import {
  isBackgroundCommand,
  isContentCommand,
  isContentSettings,
  isSubtitleContentSettingCommand,
  isSubtitleContentSettingMessage,
  isSubtitleContentSettingResponse,
  isTranslationProgressMessage,
} from "@/src/messaging/protocol";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  toContentSettings,
} from "@/src/shared/settings";
import { describe, expect, it } from "vitest";

describe("runtime message validation", () => {
  it("accepts complete settings and rejects malformed settings writes", () => {
    expect(
      isBackgroundCommand({ type: "SETTINGS_SET", settings: DEFAULT_SETTINGS }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "SETTINGS_SET",
        settings: {
          ...DEFAULT_SETTINGS,
          page: { ...DEFAULT_SETTINGS.page, aiResponseMode: "mixed" },
        },
      }),
    ).toBe(false);
    const missingResponseMode = structuredClone(
      DEFAULT_SETTINGS,
    ) as unknown as {
      page: Record<string, unknown>;
    };
    delete missingResponseMode.page.aiResponseMode;
    expect(
      isBackgroundCommand({
        type: "SETTINGS_SET",
        settings: missingResponseMode,
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({ type: "SETTINGS_SET", settings: { provider: {} } }),
    ).toBe(false);
    expect(
      mergeSettings({
        provider: { baseUrl: "http://remote.example/v1" },
      }).provider.baseUrl,
    ).toBe(DEFAULT_SETTINGS.provider.baseUrl);
    expect(
      isContentCommand({
        type: "SETTINGS_UPDATED",
        settings: toContentSettings(DEFAULT_SETTINGS),
      }),
    ).toBe(true);
    expect(
      isContentCommand({
        type: "SETTINGS_UPDATED",
        settings: DEFAULT_SETTINGS,
      }),
    ).toBe(false);
    expect(isContentSettings(toContentSettings(DEFAULT_SETTINGS))).toBe(true);
    expect("apiKey" in toContentSettings(DEFAULT_SETTINGS).provider).toBe(
      false,
    );
    expect(
      mergeSettings({
        page: { autoTranslate: true, floatingButtonEnabled: false },
        subtitles: {
          floatingButtonEnabled: false,
          position: "custom",
          customPosition: { x: 0.24, y: 0.61 },
        },
      }),
    ).toMatchObject({
      page: { autoTranslate: true, floatingButtonEnabled: false },
      subtitles: {
        hideNativeSubtitles: false,
        floatingButtonEnabled: false,
        position: "custom",
        customPosition: { x: 0.24, y: 0.61 },
      },
    });
    expect(
      isBackgroundCommand({
        type: "SETTINGS_SET",
        settings: {
          ...DEFAULT_SETTINGS,
          subtitles: {
            ...DEFAULT_SETTINGS.subtitles,
            position: "left",
          },
        },
      }),
    ).toBe(false);
    expect(isBackgroundCommand({ type: "CONTENT_SETTINGS_GET" })).toBe(true);
    for (const type of [
      "NORIXOR_AUTH_LOGIN",
      "NORIXOR_AUTH_CHALLENGE",
      "NORIXOR_AUTH_LOGOUT",
      "NORIXOR_MODELS_GET",
      "NORIXOR_USAGE_GET",
      "NORIXOR_MODEL_SET",
    ]) {
      expect(isBackgroundCommand({ type })).toBe(false);
    }
    expect(
      isBackgroundCommand({
        type: "OCR_SETTINGS_SET",
        enabled: true,
        sourceLanguage: "auto",
        targetLanguage: "en",
        provider: "chrome-local",
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "OCR_SETTINGS_SET",
        enabled: "yes",
        sourceLanguage: "auto",
        targetLanguage: "en",
        provider: "chrome-local",
      }),
    ).toBe(false);
    // Frame capture uses the dedicated OCR target protocol, not the public
    // background-command channel.
    expect(isBackgroundCommand({ type: "OCR_CAPTURE_FRAME" })).toBe(false);
    expect(isBackgroundCommand({ type: "OCR_PERMISSION_REQUEST" })).toBe(true);
    expect(isBackgroundCommand({ type: "OCR_PERMISSION_COMPLETE" })).toBe(true);
    expect(isBackgroundCommand({ type: "OCR_RUNTIME_LIST" })).toBe(true);
    expect(
      isBackgroundCommand({
        type: "OCR_RUNTIME_DOWNLOAD",
        pack: "zh",
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "OCR_RUNTIME_DOWNLOAD",
        pack: "rus",
      }),
    ).toBe(false);
    expect(isBackgroundCommand({ type: "OCR_RUNTIME_DOWNLOAD_ALL" })).toBe(
      true,
    );
    expect(
      isBackgroundCommand({ type: "OCR_RUNTIME_DELETE", pack: "zh" }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "SETTINGS_SET",
        settings: {
          ...DEFAULT_SETTINGS,
          provider: {
            ...DEFAULT_SETTINGS.provider,
            baseUrl: "http://remote.example/v1",
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects malformed translation and preference commands", () => {
    expect(
      isTranslationProgressMessage({
        type: "TRANSLATION_PROGRESS",
        requestId: "request",
        result: { id: "segment-1", translatedText: "你好" },
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "TRANSLATE",
        requestId: "request-stream",
        request: {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          responseMode: "stream",
          segments: [{ id: "stream", text: "Stream" }],
        },
      }),
    ).toBe(true);
    for (const [priority, valid] of [
      ["urgent", true],
      ["normal", true],
      ["immediate", false],
    ] as const) {
      expect(
        isBackgroundCommand({
          type: "TRANSLATE",
          requestId: `request-priority-${priority}`,
          priority,
          request: {
            sourceLanguage: "en",
            targetLanguage: "zh-CN",
            mode: "fast",
            segments: [{ id: "cue", text: "Cue" }],
          },
        }),
      ).toBe(valid);
    }
    expect(
      isBackgroundCommand({
        type: "TRANSLATE",
        requestId: "request-invalid-mode",
        request: {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          responseMode: "mixed",
          segments: [{ id: "invalid", text: "Invalid" }],
        },
      }),
    ).toBe(false);
    expect(
      isContentCommand({
        type: "TRANSLATION_PROGRESS",
        requestId: "request",
        result: { id: "segment-1", translatedText: "你好" },
      }),
    ).toBe(true);
    expect(
      isTranslationProgressMessage({
        type: "TRANSLATION_PROGRESS",
        requestId: "request",
        result: { id: "segment-1", translatedText: "   " },
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "TRANSLATE",
        requestId: "request",
        request: {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [
            { id: "duplicate", text: "one" },
            { id: "duplicate", text: "two" },
          ],
        },
      }),
    ).toBe(false);
    const cacheKey = "a".repeat(64);
    const persistedTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "cue-1",
          startMs: 0,
          endMs: 1_000,
          originalText: "Hello",
        },
      ],
    };
    expect(
      isBackgroundCommand({ type: "TRANSLATION_CACHE_GET", key: cacheKey }),
    ).toBe(true);
    expect(isBackgroundCommand({ type: "CACHE_EPOCH_GET" })).toBe(true);
    expect(
      isBackgroundCommand({
        type: "TRANSLATION_CACHE_SET",
        key: cacheKey,
        translatedText: "你好",
        epoch: 2,
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({ type: "SUBTITLE_TRACK_GET", key: cacheKey }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "SUBTITLE_TRACK_DELETE",
        key: cacheKey,
        epoch: 2,
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "SUBTITLE_TRACK_SET",
        key: cacheKey,
        track: persistedTrack,
        epoch: 2,
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({ type: "TRANSLATION_CACHE_GET", key: "not-hash" }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "SUBTITLE_TRACK_DELETE",
        key: "not-hash",
        epoch: 2,
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "TRANSLATION_CACHE_SET",
        key: cacheKey,
        translatedText: "",
        epoch: 2,
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "SUBTITLE_TRACK_SET",
        key: cacheKey,
        track: { ...persistedTrack, completeness: "stream" },
        epoch: 2,
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "TRANSLATION_CACHE_SET",
        key: cacheKey,
        translatedText: "你好",
        epoch: -1,
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "TRANSLATE",
        requestId: "request",
        request: {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [
            {
              id: "contextual",
              text: "Run",
              contextBefore: ["A command"],
              contextAfter: ["Now"],
            },
          ],
        },
      }),
    ).toBe(true);
    const profile = {
      id: "user-example-com",
      version: 1,
      name: "example.com",
      parser: "dom",
      priority: 1,
      match: { hostnameSuffixes: ["example.com"] },
      selectors: {
        video: "video",
        captions: [".caption-layer"],
        nativeCaptions: [".caption-layer"],
      },
      capture: {
        formats: [],
        allowedHostnameSuffixes: [],
        urlPatterns: [],
      },
    };
    expect(isBackgroundCommand({ type: "SITE_PROFILE_SAVE", profile })).toBe(
      true,
    );
    expect(
      isBackgroundCommand({
        type: "SITE_PROFILE_SAVE",
        profile: {
          ...profile,
          selectors: { ...profile.selectors, captions: ["*:has(*)"] },
        },
      }),
    ).toBe(false);
    expect(isBackgroundCommand({ type: "SITE_PROFILES_GET" })).toBe(true);
    expect(
      isBackgroundCommand({
        type: "SITE_PROFILE_DELETE",
        id: "user-example-com",
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "TRANSLATE",
        requestId: "request",
        request: {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [
            {
              id: "invalid-context",
              text: "Run",
              contextBefore: [42],
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "SUBTITLE_POSITION_SET",
        x: 1.2,
        y: 0.5,
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "SUBTITLE_POSITION_SET",
        x: 0.2,
        y: 0.75,
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "PAGE_AUTO_TRANSLATE_SET",
        enabled: true,
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "PAGE_QUICK_SETTINGS_SET",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        displayMode: "bilingual",
        selectionTranslationEnabled: true,
        selectionTranslationMode: "fast",
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "PAGE_QUICK_SETTINGS_SET",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        displayMode: "bilingual",
        selectionTranslationEnabled: true,
        selectionTranslationMode: "mixed",
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "PAGE_QUICK_SETTINGS_SET",
        sourceLanguage: "",
        targetLanguage: "zh-CN",
        mode: "ai",
        displayMode: "bilingual",
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "FLOATING_BUTTON_SET",
        surface: "video",
        enabled: false,
      }),
    ).toBe(true);
    expect(isBackgroundCommand({ type: "FLOATING_POSITION_GET" })).toBe(true);
    expect(
      isBackgroundCommand({ type: "FLOATING_POSITION_SET", x: 0.25, y: 0.8 }),
    ).toBe(true);
    expect(
      isBackgroundCommand({ type: "FLOATING_POSITION_SET", x: -0.1, y: 0.8 }),
    ).toBe(false);
    expect(
      isBackgroundCommand({ type: "FLOATING_POSITION_SET", x: 0.5, y: 1.1 }),
    ).toBe(false);
    expect(isBackgroundCommand({ type: "FLOATING_SESSION_RESTORE" })).toBe(
      true,
    );
    expect(
      isBackgroundCommand({
        type: "FLOATING_SESSION_RESTORE",
        enabled: true,
      }),
    ).toBe(false);
    expect(isContentCommand({ type: "FLOATING_SESSION_SHOW" })).toBe(true);
    expect(isContentCommand({ type: "FLOATING_SESSION_SHOW", tabId: 1 })).toBe(
      false,
    );
    const pageStatus = {
      state: "translated" as const,
      total: 2,
      completed: 2,
      failed: 0,
      details: "Missing result IDs: page-1.",
    };
    const subtitleStatus = {
      state: "ready" as const,
      source: "texttrack" as const,
      completeness: "full" as const,
      total: 1,
      completed: 1,
      failed: 0,
    };
    expect(
      isBackgroundCommand({
        type: "CONTENT_COMMAND_BROADCAST",
        command: "PAGE_TRANSLATE",
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "CONTENT_COMMAND_BROADCAST",
        command: "PAGE_AUTO_TRANSLATE_CURRENT",
      }),
    ).toBe(true);
    for (const command of ["PAGE_RETRY_FAILED", "PAGE_CANCEL"] as const) {
      expect(
        isBackgroundCommand({ type: "CONTENT_COMMAND_BROADCAST", command }),
      ).toBe(true);
      expect(isContentCommand({ type: command })).toBe(true);
    }
    for (const state of ["cancelled", "unavailable"] as const) {
      expect(
        isBackgroundCommand({
          type: "FRAME_STATUS_UPDATE",
          frameInstanceId: "frame-instance-1",
          pageStatus: { ...pageStatus, state },
          subtitleStatus,
        }),
      ).toBe(true);
    }
    expect(
      isBackgroundCommand({
        type: "FRAME_STATUS_UPDATE",
        frameInstanceId: "frame-instance-1",
        pageStatus: { ...pageStatus, state: "paused" },
        subtitleStatus,
      }),
    ).toBe(false);
    expect(isContentCommand({ type: "PAGE_AUTO_TRANSLATE_CURRENT" })).toBe(
      true,
    );
    expect(
      isBackgroundCommand({
        type: "PAGE_MANUAL_TRANSLATION_SET",
        enabled: true,
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "PAGE_MANUAL_TRANSLATION_SET",
        enabled: "true",
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "FRAME_STATUS_UPDATE",
        frameInstanceId: "frame-instance-1",
        pageStatus: { ...pageStatus, details: "x".repeat(4_001) },
        subtitleStatus,
      }),
    ).toBe(false);
    expect(isContentCommand({ type: "CONTENT_RUNTIME_INFO" })).toBe(true);
    expect(
      isContentCommand({ type: "CONTENT_RUNTIME_INFO", version: "stale" }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "CONTENT_COMMAND_BROADCAST",
        command: "SUBTITLE_CANCEL",
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "CONTENT_COMMAND_BROADCAST",
        command: "SUBTITLE_START",
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "FRAME_STATUS_UPDATE",
        frameInstanceId: "frame-instance-1",
        pageStatus,
        subtitleStatus,
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "FRAME_STATUS_UPDATE",
        frameInstanceId: "frame-instance-1",
        pageStatus: { ...pageStatus, total: -1 },
        subtitleStatus,
      }),
    ).toBe(false);
    expect(
      isContentCommand({
        type: "FRAME_STATUS_UPDATED",
        frameId: 3,
        frameInstanceId: "frame-instance-1",
        pageStatus,
        subtitleStatus,
      }),
    ).toBe(true);
    expect(
      isContentCommand({
        type: "FRAME_STATUS_UPDATED",
        frameId: 0,
        frameInstanceId: "frame-instance-1",
        pageStatus,
        subtitleStatus,
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "FRAME_STATUS_UPDATE",
        pageStatus,
        subtitleStatus,
      }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "FRAME_STATUS_CLEAR",
        frameInstanceId: "frame-instance-1",
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "FRAME_STATUS_CLEAR",
        frameInstanceId: "",
      }),
    ).toBe(false);
    expect(
      isContentCommand({
        type: "FRAME_STATUS_CLEARED",
        frameId: 3,
        frameInstanceId: "frame-instance-1",
      }),
    ).toBe(true);
    expect(
      isContentCommand({
        type: "FRAME_STATUS_CLEARED",
        frameId: 3,
        frameInstanceId: "frame-instance-1",
        pageStatus,
      }),
    ).toBe(false);
    expect(isBackgroundCommand({ type: "CREDENTIALS_CLEAR" })).toBe(true);
    expect(
      isBackgroundCommand({ type: "CREDENTIALS_CLEAR", apiKey: "secret" }),
    ).toBe(false);
    expect(
      isBackgroundCommand({
        type: "SUBTITLE_QUICK_SETTINGS_SET",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        displayMode: "translated",
        hideNativeSubtitles: true,
      }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "SUBTITLE_QUICK_SETTINGS_SET",
        sourceLanguage: "",
        targetLanguage: "zh-CN",
        mode: "ai",
        displayMode: "translated",
        hideNativeSubtitles: true,
      }),
    ).toBe(false);
  });
});

describe("subtitle content setting messages", () => {
  it("accepts exactly the declared payloads", () => {
    expect(
      isSubtitleContentSettingCommand({
        type: "SUBTITLE_ENABLED_SET",
        enabled: false,
      }),
    ).toBe(true);
    for (const preset of ["top", "center", "bottom"]) {
      expect(
        isSubtitleContentSettingCommand({
          type: "SUBTITLE_POSITION_PRESET_SET",
          preset,
        }),
      ).toBe(true);
    }
  });

  it("rejects malformed payloads and smuggled fields", () => {
    for (const value of [
      { type: "SUBTITLE_ENABLED_SET", enabled: "true" },
      { type: "SUBTITLE_ENABLED_SET", enabled: 1 },
      { type: "SUBTITLE_ENABLED_SET" },
      { type: "SUBTITLE_POSITION_PRESET_SET", preset: "custom" },
      { type: "SUBTITLE_POSITION_PRESET_SET", preset: "left" },
      { type: "SUBTITLE_POSITION_PRESET_SET", preset: { x: 0.5 } },
      {
        type: "SUBTITLE_ENABLED_SET",
        enabled: true,
        provider: { apiKey: "leak" },
      },
      {
        type: "SUBTITLE_POSITION_PRESET_SET",
        preset: "top",
        settings: DEFAULT_SETTINGS,
      },
    ]) {
      expect(isSubtitleContentSettingCommand(value)).toBe(false);
    }
  });

  it("keeps these commands out of the generic background command path", () => {
    const command = { type: "SUBTITLE_ENABLED_SET", enabled: true };
    expect(isSubtitleContentSettingMessage(command)).toBe(true);
    expect(
      isSubtitleContentSettingMessage({
        type: "SUBTITLE_POSITION_PRESET_SET",
        preset: "nope",
      }),
    ).toBe(true);
    expect(isSubtitleContentSettingMessage({ type: "SETTINGS_SET" })).toBe(
      false,
    );
    expect(isBackgroundCommand(command)).toBe(false);
  });

  it("validates responses by result code", () => {
    expect(
      isSubtitleContentSettingResponse({
        ok: true,
        code: "subtitle_setting_saved",
        settings: toContentSettings(DEFAULT_SETTINGS),
      }),
    ).toBe(true);
    expect(
      isSubtitleContentSettingResponse({
        ok: false,
        code: "subtitle_setting_sender_rejected",
      }),
    ).toBe(true);
    expect(
      isSubtitleContentSettingResponse({
        ok: true,
        code: "subtitle_setting_saved",
      }),
    ).toBe(false);
    expect(
      isSubtitleContentSettingResponse({ ok: false, code: "unknown" }),
    ).toBe(false);
  });
});
