import { describe, expect, it, vi } from "vitest";
import { isBackgroundCommand } from "@/src/messaging/protocol";
import { DEFAULT_SETTINGS, type AppSettings } from "@/src/shared/settings";
import {
  applySettingsPatch,
  handleSettingsPatch,
  isSettingsPatchResponse,
  mergeSettingsPatches,
  parseSettingsPatch,
  settingsPatchPaths,
  type SettingsPatchDeps,
} from "@/src/shared/settings-patch";

const EXTENSION = {
  id: "extension-id",
  baseUrl: "chrome-extension://extension-id/",
};
const OPTIONS_SENDER = {
  id: EXTENSION.id,
  url: "chrome-extension://extension-id/options.html#page",
};
const OFFSCREEN_URL = "chrome-extension://extension-id/ocr-offscreen.html";

function storedSettings(): AppSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.apiKey = "secret-ai-key";
  settings.provider.googleApiKey = "secret-google-key";
  return settings;
}

function deps(initial = storedSettings()) {
  let current = initial;
  const writes: AppSettings[] = [];
  const mutateSettings = vi.fn(
    async (update: (value: AppSettings) => AppSettings) => {
      await Promise.resolve();
      current = update(current);
      writes.push(current);
      return current;
    },
  );
  const value: SettingsPatchDeps = {
    extension: EXTENSION,
    rejectedPageUrls: [OFFSCREEN_URL],
    mutateSettings,
  };
  return { deps: value, mutateSettings, writes, current: () => current };
}

describe("parseSettingsPatch", () => {
  it("accepts known fields and keeps them unchanged", () => {
    const patch = {
      uiLanguage: "en",
      provider: { fastProvider: "deepl" },
      page: {
        mode: "ai",
        autoTranslateSitePatterns: ["*.example.com"],
        selectionTranslationModelOverride: "",
        showSkippedMarks: true,
      },
      subtitles: { customPosition: { x: 0.2, y: 0.9 }, fontScale: 1.4 },
      ocr: { provider: "bergamot-local" },
      imageTranslation: { displayMode: "bilingual" },
      floating: { announcements: false },
    };
    expect(parseSettingsPatch(patch)).toEqual({ ok: true, patch });
  });

  it.each([
    [undefined, "patch"],
    [[], "patch"],
    [{}, "patch"],
    [{ unknown: {} }, "unknown"],
    [{ page: {} }, "page"],
    [{ page: { nope: true } }, "page.nope"],
    [{ page: { mode: "slow" } }, "page.mode"],
    [{ page: { autoTranslate: "yes" } }, "page.autoTranslate"],
    [{ page: { sourceLanguage: "" } }, "page.sourceLanguage"],
    [
      { page: { autoTranslateSitePatterns: ["Example.COM"] } },
      "page.autoTranslateSitePatterns",
    ],
    [{ page: { fastProviderOverride: "deepl" } }, "page.fastProviderOverride"],
    [{ subtitles: { fontScale: 4 } }, "subtitles.fontScale"],
    [{ subtitles: { fontScale: Number.NaN } }, "subtitles.fontScale"],
    [
      { subtitles: { customPosition: { x: 0.5, y: 0.5, z: 1 } } },
      "subtitles.customPosition",
    ],
    [{ uiLanguage: "fr" }, "uiLanguage"],
    [{ page: { showSkippedMarks: 1 } }, "page.showSkippedMarks"],
    [{ floating: {} }, "floating"],
    [{ floating: { announcements: "on" } }, "floating.announcements"],
    [{ floating: { position: { x: 1, y: 1 } } }, "floating.position"],
  ])("rejects %j at %s", (value, path) => {
    expect(parseSettingsPatch(value)).toEqual({ ok: false, path });
  });

  it.each([
    "apiKey",
    "googleApiKey",
    "microsoftApiKey",
    "deeplApiKey",
    "baseUrl",
    "model",
    "systemPrompt",
  ])("never accepts provider.%s", (key) => {
    expect(parseSettingsPatch({ provider: { [key]: "x" } })).toEqual({
      ok: false,
      path: `provider.${key}`,
    });
  });
});

describe("applySettingsPatch", () => {
  it("changes only patched fields and keeps credentials", () => {
    const current = storedSettings();
    const next = applySettingsPatch(current, {
      page: { mode: "ai" },
      subtitles: { position: "top" },
    });
    expect(next.page.mode).toBe("ai");
    expect(next.subtitles.position).toBe("top");
    expect(next.provider).toEqual(current.provider);
    expect(next.page.targetLanguage).toBe(current.page.targetLanguage);
  });

  it("merges and lists patches field by field", () => {
    const merged = mergeSettingsPatches(
      { page: { mode: "ai", autoTranslate: true } },
      { page: { mode: "fast" }, uiLanguage: "en" },
    );
    expect(merged).toEqual({
      page: { mode: "fast", autoTranslate: true },
      uiLanguage: "en",
    });
    expect(settingsPatchPaths(merged).sort()).toEqual([
      "page.autoTranslate",
      "page.mode",
      "uiLanguage",
    ]);
  });
});

describe("handleSettingsPatch", () => {
  it("applies a valid patch through mutateSettings and returns safe settings", async () => {
    const { deps: d, mutateSettings, current } = deps();
    const response = await handleSettingsPatch(
      { type: "SETTINGS_PATCH", patch: { page: { displayMode: "bilingual" } } },
      OPTIONS_SENDER,
      d,
    );
    expect(response).toMatchObject({
      ok: true,
      code: "settings_patch_applied",
    });
    expect(isSettingsPatchResponse(response)).toBe(true);
    expect(mutateSettings).toHaveBeenCalledTimes(1);
    expect(current().page.displayMode).toBe("bilingual");
    expect(current().provider.apiKey).toBe("secret-ai-key");
    expect(JSON.stringify(response)).not.toContain("secret");
  });

  it("rejects content scripts, the offscreen document and other extensions", async () => {
    const { deps: d, mutateSettings } = deps();
    const message = {
      type: "SETTINGS_PATCH",
      patch: { page: { autoTranslate: true } },
    };
    for (const sender of [
      {
        id: EXTENSION.id,
        url: "https://news.example/",
        frameId: 0,
        tab: { id: 1, url: "https://news.example/" },
      },
      { id: EXTENSION.id, url: OFFSCREEN_URL },
      { id: "other", url: "chrome-extension://other/options.html" },
      { id: EXTENSION.id },
    ]) {
      await expect(handleSettingsPatch(message, sender, d)).resolves.toEqual({
        ok: false,
        code: "settings_patch_sender_rejected",
      });
    }
    expect(mutateSettings).not.toHaveBeenCalled();
  });

  it("rejects invalid payloads before touching storage", async () => {
    const { deps: d, mutateSettings } = deps();
    await expect(
      handleSettingsPatch(
        { type: "SETTINGS_PATCH", patch: { provider: { apiKey: "leak" } } },
        OPTIONS_SENDER,
        d,
      ),
    ).resolves.toEqual({
      ok: false,
      code: "settings_patch_invalid",
      path: "provider.apiKey",
    });
    await expect(
      handleSettingsPatch(
        { type: "SETTINGS_PATCH", patch: { page: { mode: "ai" } }, extra: 1 },
        OPTIONS_SENDER,
        d,
      ),
    ).resolves.toEqual({
      ok: false,
      code: "settings_patch_invalid",
      path: "extra",
    });
    expect(mutateSettings).not.toHaveBeenCalled();
  });

  it("reports a storage failure with its own code", async () => {
    const { deps: d } = deps();
    d.mutateSettings = () => Promise.reject(new Error("quota"));
    await expect(
      handleSettingsPatch(
        { type: "SETTINGS_PATCH", patch: { page: { mode: "ai" } } },
        OPTIONS_SENDER,
        d,
      ),
    ).resolves.toEqual({ ok: false, code: "settings_patch_save_failed" });
  });

  it("applies concurrent patches to different fields without losing either", async () => {
    const { deps: d, current } = deps();
    await Promise.all([
      handleSettingsPatch(
        { type: "SETTINGS_PATCH", patch: { page: { mode: "ai" } } },
        OPTIONS_SENDER,
        d,
      ),
      handleSettingsPatch(
        { type: "SETTINGS_PATCH", patch: { subtitles: { enabled: false } } },
        OPTIONS_SENDER,
        d,
      ),
    ]);
    expect(current().page.mode).toBe("ai");
    expect(current().subtitles.enabled).toBe(false);
  });

  it("is not part of the generic command set", () => {
    expect(
      isBackgroundCommand({
        type: "SETTINGS_PATCH",
        patch: { page: { mode: "ai" } },
      }),
    ).toBe(false);
  });
});
