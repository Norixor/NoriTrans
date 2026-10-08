import type { ContentMessageSender } from "@/src/shared/content-sender";
import {
  DEFAULT_SETTINGS,
  toContentSettings,
  type AppSettings,
} from "@/src/shared/settings";
import {
  handleSubtitleContentSetting,
  type SubtitleContentSettingDeps,
} from "@/src/shared/subtitle-content-settings";
import { describe, expect, it, vi } from "vitest";

const EXTENSION = {
  id: "extension-id",
  baseUrl: "chrome-extension://extension-id/",
};

const CONTENT_SENDER: ContentMessageSender = {
  id: EXTENSION.id,
  url: "https://video.example/watch?v=1",
  frameId: 0,
  tab: { id: 7, url: "https://video.example/watch?v=1" },
};

function setup(saveError?: Error) {
  let stored: AppSettings = structuredClone(DEFAULT_SETTINGS);
  const mutateSettings = vi.fn(
    (update: (current: AppSettings) => AppSettings) => {
      if (saveError) return Promise.reject(saveError);
      stored = update(stored);
      return Promise.resolve(stored);
    },
  );
  const deps: SubtitleContentSettingDeps = {
    extension: EXTENSION,
    mutateSettings,
    contentSettings: (updated) => Promise.resolve(toContentSettings(updated)),
  };
  return { deps, mutateSettings, stored: () => stored };
}

describe("subtitle content setting handler", () => {
  it("writes only subtitles.enabled and returns the new content settings", async () => {
    const { deps, stored } = setup();
    const response = await handleSubtitleContentSetting(
      { type: "SUBTITLE_ENABLED_SET", enabled: false },
      CONTENT_SENDER,
      deps,
    );
    expect(response).toMatchObject({
      ok: true,
      code: "subtitle_setting_saved",
    });
    expect(response.ok && response.settings.subtitles.enabled).toBe(false);
    expect(stored()).toEqual({
      ...DEFAULT_SETTINGS,
      subtitles: { ...DEFAULT_SETTINGS.subtitles, enabled: false },
    });
  });

  it("writes a position preset and keeps the custom position", async () => {
    const { deps, stored } = setup();
    const response = await handleSubtitleContentSetting(
      { type: "SUBTITLE_POSITION_PRESET_SET", preset: "top" },
      CONTENT_SENDER,
      deps,
    );
    expect(response.code).toBe("subtitle_setting_saved");
    expect(stored().subtitles.position).toBe("top");
    expect(stored().subtitles.customPosition).toEqual(
      DEFAULT_SETTINGS.subtitles.customPosition,
    );
    expect(stored().provider).toEqual(DEFAULT_SETTINGS.provider);
  });

  it.each([
    [{ type: "SUBTITLE_POSITION_PRESET_SET", preset: "custom" }],
    [{ type: "SUBTITLE_POSITION_PRESET_SET", preset: "left" }],
    [{ type: "SUBTITLE_ENABLED_SET", enabled: "false" }],
    [
      {
        type: "SUBTITLE_ENABLED_SET",
        enabled: true,
        provider: { apiKey: "x" },
      },
    ],
  ])("rejects an invalid payload %j without saving", async (message) => {
    const { deps, mutateSettings } = setup();
    await expect(
      handleSubtitleContentSetting(message, CONTENT_SENDER, deps),
    ).resolves.toEqual({ ok: false, code: "subtitle_setting_invalid_payload" });
    expect(mutateSettings).not.toHaveBeenCalled();
  });

  it.each<[string, ContentMessageSender]>([
    [
      "an extension page",
      {
        id: EXTENSION.id,
        url: `${EXTENSION.baseUrl}options.html`,
        frameId: 0,
        tab: { id: 7, url: `${EXTENSION.baseUrl}options.html` },
      },
    ],
    [
      "the popup (no tab)",
      { id: EXTENSION.id, url: `${EXTENSION.baseUrl}popup.html` },
    ],
    ["a subframe", { ...CONTENT_SENDER, frameId: 3 }],
    [
      "a frame whose origin differs from the tab",
      { ...CONTENT_SENDER, url: "https://ads.example/frame" },
    ],
    ["another extension", { ...CONTENT_SENDER, id: "other-extension" }],
    [
      "a non-web document",
      {
        ...CONTENT_SENDER,
        url: "file:///tmp/a.html",
        tab: { id: 7, url: "file:///tmp/a.html" },
      },
    ],
  ])("rejects %s as sender before reading the payload", async (_, sender) => {
    const { deps, mutateSettings } = setup();
    await expect(
      handleSubtitleContentSetting(
        { type: "SUBTITLE_ENABLED_SET", enabled: true },
        sender,
        deps,
      ),
    ).resolves.toEqual({ ok: false, code: "subtitle_setting_sender_rejected" });
    await expect(
      handleSubtitleContentSetting(
        { type: "SUBTITLE_ENABLED_SET", enabled: "bad" },
        sender,
        deps,
      ),
    ).resolves.toEqual({ ok: false, code: "subtitle_setting_sender_rejected" });
    expect(mutateSettings).not.toHaveBeenCalled();
  });

  it("reports a storage failure as a code without error text", async () => {
    const { deps } = setup(new Error("QUOTA_BYTES exceeded: secret detail"));
    await expect(
      handleSubtitleContentSetting(
        { type: "SUBTITLE_ENABLED_SET", enabled: true },
        CONTENT_SENDER,
        deps,
      ),
    ).resolves.toEqual({ ok: false, code: "subtitle_setting_save_failed" });
  });
});
