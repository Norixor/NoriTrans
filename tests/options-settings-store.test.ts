import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOSAVE_DEBOUNCE_MS,
  SettingsStore,
  type SettingsStoreEvent,
} from "@/entrypoints/options/settings-store";
import {
  DEFAULT_SETTINGS,
  toContentSettings,
  type AppSettings,
} from "@/src/shared/settings";
import {
  applySettingsPatch,
  type SettingsPatch,
} from "@/src/shared/settings-patch";

function settings(): AppSettings {
  const value = structuredClone(DEFAULT_SETTINGS);
  value.provider.apiKey = "stored-key";
  return value;
}

/** Fake background: applies patches to its own copy like the real handler. */
function backend(initial = settings()) {
  let stored = initial;
  const sent: SettingsPatch[] = [];
  let failNext: string | undefined;
  const send = vi.fn(async (patch: SettingsPatch) => {
    sent.push(structuredClone(patch));
    await Promise.resolve();
    if (failNext) {
      const code = failNext;
      failNext = undefined;
      return { ok: false, code };
    }
    stored = applySettingsPatch(stored, patch);
    return {
      ok: true,
      code: "settings_patch_applied",
      settings: toContentSettings(stored),
    };
  });
  return {
    send,
    sent,
    stored: () => stored,
    failNext: (code: string) => {
      failNext = code;
    },
  };
}

describe("SettingsStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows edits at once and coalesces them into one debounced patch", async () => {
    const server = backend();
    const store = new SettingsStore(settings(), { send: server.send });
    store.update({ page: { mode: "ai" } });
    store.update({ page: { displayMode: "bilingual" } });
    store.update({ page: { mode: "fast" } });
    expect(store.value.page.mode).toBe("fast");
    expect(store.value.page.displayMode).toBe("bilingual");
    expect(store.hasUnsavedChanges).toBe(true);
    expect(server.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(server.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await store.flush();
    expect(server.sent).toEqual([
      { page: { mode: "fast", displayMode: "bilingual" } },
    ]);
    expect(store.hasUnsavedChanges).toBe(false);
    expect(store.storedValue.page.displayMode).toBe("bilingual");
    // Credentials never travel in a patch and keep their stored value.
    expect(store.storedValue.provider.apiKey).toBe("stored-key");
  });

  it("rolls back a failed patch and reports the fields", async () => {
    const server = backend();
    const store = new SettingsStore(settings(), { send: server.send });
    const events: SettingsStoreEvent[] = [];
    store.subscribe((event) => events.push(event));
    server.failNext("settings_patch_save_failed");
    const outcome = await store.commit({ subtitles: { position: "top" } });
    expect(outcome).toEqual({
      ok: false,
      code: "settings_patch_save_failed",
      paths: ["subtitles.position"],
    });
    expect(store.value.subtitles.position).toBe("bottom");
    expect(events).toContainEqual({
      kind: "failed",
      code: "settings_patch_save_failed",
      paths: ["subtitles.position"],
    });
  });

  it("treats a missing or malformed reply as unreachable", async () => {
    const store = new SettingsStore(settings(), {
      send: () => Promise.resolve(undefined),
    });
    await expect(
      store.commit({ page: { autoTranslate: true } }),
    ).resolves.toMatchObject({ ok: false, code: "settings_patch_unreachable" });
    expect(store.value.page.autoTranslate).toBe(false);
    const throwing = new SettingsStore(settings(), {
      send: () => Promise.reject(new Error("no receiver")),
    });
    await expect(
      throwing.commit({ page: { autoTranslate: true } }),
    ).resolves.toMatchObject({ ok: false, code: "settings_patch_unreachable" });
  });

  it("writes patches one at a time in edit order", async () => {
    let release: (() => void) | undefined;
    const sent: SettingsPatch[] = [];
    const store = new SettingsStore(settings(), {
      send: async (patch) => {
        sent.push(patch);
        if (!release) await new Promise<void>((resolve) => (release = resolve));
        return {
          ok: true,
          code: "settings_patch_applied",
          settings: toContentSettings(applySettingsPatch(settings(), patch)),
        };
      },
    });
    const first = store.commit({ page: { mode: "ai" } });
    await Promise.resolve();
    store.update({ page: { mode: "fast" } }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ page: { mode: "ai" } }]);
    release?.();
    await first;
    await store.flush();
    expect(sent).toEqual([
      { page: { mode: "ai" } },
      { page: { mode: "fast" } },
    ]);
    expect(store.value.page.mode).toBe("fast");
  });

  it("adopts external changes but keeps unsent and in-progress edits", async () => {
    const server = backend();
    const store = new SettingsStore(settings(), { send: server.send });
    store.update({ page: { targetLanguage: "ja" } });
    store.beginEditing("page.selectionTranslationModelOverride");
    store.update(
      { page: { selectionTranslationModelOverride: "typed" } },
      10_000,
    );
    await store.flush();

    const external = settings();
    external.page.targetLanguage = "fr";
    external.page.selectionTranslationModelOverride = "external";
    external.subtitles.enabled = false;
    store.applyExternal(external);
    // A field without local edits follows the other page.
    expect(store.value.subtitles.enabled).toBe(false);
    // The field being typed into keeps what the user sees.
    expect(store.value.page.selectionTranslationModelOverride).toBe("typed");
    store.endEditing("page.selectionTranslationModelOverride");
    expect(store.value.page.selectionTranslationModelOverride).toBe("external");

    // An edit still inside the debounce window wins over the external value.
    store.update({ page: { displayMode: "bilingual" } }, 10_000);
    const again = settings();
    again.page.displayMode = "translated";
    store.applyExternal(again);
    expect(store.value.page.displayMode).toBe("bilingual");
  });
});
