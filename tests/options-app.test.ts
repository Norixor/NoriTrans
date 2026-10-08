import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  OptionsApp,
  type ConfirmRequest,
  type OptionsAppDeps,
} from "@/entrypoints/options/app";
import {
  AUTOSAVE_DEBOUNCE_MS,
  SettingsStore,
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
import { defineNtComponents } from "@/src/ui/components";

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: { sendMessage: vi.fn() },
    permissions: { request: vi.fn(), contains: vi.fn() },
  },
}));

vi.mock("@/src/shared/i18n", () => ({
  currentUiLocale: () => "en",
  message: (key: string, subs?: string | string[]) =>
    subs && subs.length > 0 ? `${key}(${[subs].flat().join(",")})` : key,
}));

beforeAll(() => {
  defineNtComponents();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

function settings(): AppSettings {
  const value = structuredClone(DEFAULT_SETTINGS);
  value.provider.apiKey = "stored-key";
  return value;
}

interface Harness {
  app: OptionsApp;
  store: SettingsStore;
  patches: SettingsPatch[];
  messages: { type: string; [key: string]: unknown }[];
  deps: OptionsAppDeps;
  roots: Record<
    "services" | "page" | "video" | "privacy" | "sites" | "general" | "status",
    HTMLElement
  >;
  failPatches(code: string | undefined): void;
}

async function mount(
  overrides: Partial<OptionsAppDeps> = {},
  responses: Record<string, (message: Record<string, unknown>) => unknown> = {},
): Promise<Harness> {
  let stored = settings();
  let failure: string | undefined;
  const patches: SettingsPatch[] = [];
  const messages: { type: string; [key: string]: unknown }[] = [];
  const store = new SettingsStore(stored, {
    send: (patch) => {
      patches.push(patch);
      if (failure) return Promise.resolve({ ok: false, code: failure });
      stored = applySettingsPatch(stored, patch);
      return Promise.resolve({
        ok: true,
        code: "settings_patch_applied",
        settings: toContentSettings(stored),
      });
    },
  });
  const deps: OptionsAppDeps = {
    sendMessage: vi.fn((message: unknown) => {
      const typed = message as { type: string; settings?: AppSettings };
      messages.push(typed);
      if (typed.type === "SETTINGS_SET" && typed.settings) {
        stored = typed.settings;
      }
      const respond = responses[typed.type];
      if (respond) {
        try {
          return Promise.resolve(respond(typed));
        } catch (error) {
          return Promise.reject(
            error instanceof Error ? error : new Error("reply_failed"),
          );
        }
      }
      return Promise.resolve({ ok: true });
    }),
    loadSettings: vi.fn(() => Promise.resolve(structuredClone(stored))),
    requestOrigins: vi.fn(() => Promise.resolve(true)),
    requestOcrCapturePermission: vi.fn(() => Promise.resolve(true)),
    hasOrigins: vi.fn(() => Promise.resolve(false)),
    confirm: vi.fn(() => Promise.resolve(true)),
    navigate: vi.fn(),
    reload: vi.fn(),
    openTab: vi.fn(),
    extensionVersion: () => "9.9.9",
    extensionUrl: (path: string) => `chrome-extension://test${path}`,
    copyText: vi.fn(() => Promise.resolve()),
    download: vi.fn(),
    ...overrides,
  };
  const roots = {
    services: document.createElement("div"),
    page: document.createElement("div"),
    video: document.createElement("div"),
    privacy: document.createElement("div"),
    sites: document.createElement("div"),
    general: document.createElement("div"),
    status: document.createElement("div"),
  };
  document.body.append(...Object.values(roots));
  const app = new OptionsApp(roots, store, deps);
  app.render();
  await settle();
  return {
    app,
    store,
    patches,
    messages,
    deps,
    roots,
    failPatches: (code) => {
      failure = code;
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    const pending: Promise<unknown>[] = [];
    for (const element of document.querySelectorAll("*")) {
      const update = (element as { updateComplete?: Promise<unknown> })
        .updateComplete;
      if (update) pending.push(update);
    }
    await Promise.all(pending);
  }
}

function inner<T extends Element>(host: Element | null, selector: string): T {
  const found = host?.shadowRoot?.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

function segment(id: string, value: string): HTMLButtonElement {
  return inner(document.querySelector(`#${id}`), `.seg[data-value="${value}"]`);
}

describe("options app autosave", () => {
  it("maps each control to a field patch and sends it after the debounce", async () => {
    vi.useFakeTimers();
    const h = await mount();
    segment("page-mode", "ai").click();
    inner<HTMLButtonElement>(
      document.querySelector("#page-auto-translate"),
      "button",
    ).click();
    segment("subtitle-position", "top").click();
    expect(h.patches).toEqual([]);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await h.store.flush();
    expect(h.patches).toEqual([
      {
        page: { mode: "ai", autoTranslate: true },
        subtitles: { position: "top" },
      },
    ]);
    await settle();
    expect(
      h.roots.status
        .querySelector("#autosave-status")
        ?.getAttribute("data-state"),
    ).toBe("saved");
  });

  it("restores the stored value and reports a failed save", async () => {
    const h = await mount();
    h.failPatches("settings_patch_save_failed");
    segment("page-display-mode", "bilingual").click();
    await h.store.flush();
    await settle();
    expect(
      document.querySelector<HTMLElement & { value: string }>(
        "#page-display-mode",
      )?.value,
    ).toBe("translated");
    expect(
      h.roots.status
        .querySelector("#autosave-status")
        ?.getAttribute("data-state"),
    ).toBe("failed");
  });

  it("keeps OCR off when the capture permission is refused", async () => {
    const h = await mount({
      requestOcrCapturePermission: vi.fn(() => Promise.resolve(false)),
    });
    inner<HTMLButtonElement>(
      document.querySelector("#ocr-enabled"),
      "button",
    ).click();
    await settle();
    await h.store.flush();
    await settle();
    expect(h.patches).toEqual([]);
    expect(
      document.querySelector<HTMLElement & { checked: boolean }>("#ocr-enabled")
        ?.checked,
    ).toBe(false);
    expect(h.roots.video.textContent).toContain("ocrPermissionDenied");
  });

  it("enables OCR after the permission is granted", async () => {
    const h = await mount();
    inner<HTMLButtonElement>(
      document.querySelector("#ocr-enabled"),
      "button",
    ).click();
    await settle();
    await h.store.flush();
    expect(h.patches).toEqual([{ ocr: { enabled: true } }]);
  });
});

describe("options app provider credentials", () => {
  it("keeps credential edits local until save, then saves and tests", async () => {
    vi.useFakeTimers();
    const h = await mount();
    h.app["editAi"]({ apiKey: "typed-key", model: "typed-model" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 4);
    expect(h.patches).toEqual([]);
    expect(h.messages).toEqual([]);

    // Another page changes storage meanwhile: the dirty draft is kept.
    const external = settings();
    external.provider.model = "external-model";
    h.app.applyExternal(external);
    await settle();
    expect(
      (document.querySelector("#model") as HTMLElement & { value: string })
        .value,
    ).toBe("typed-model");

    await h.app.saveAi(true);
    expect(h.messages.map((message) => message.type)).toEqual([
      "SETTINGS_SET",
      "TEST_CONNECTION",
    ]);
    const written = (h.messages[0] as unknown as { settings: AppSettings })
      .settings;
    expect(written.provider).toMatchObject({
      apiKey: "typed-key",
      model: "typed-model",
    });
    await settle();
    expect(
      h.roots.services.querySelector("#test-message")?.textContent,
    ).toContain("connectionSucceeded");
  });

  it("does not save an invalid endpoint", async () => {
    const h = await mount();
    h.app["editAi"]({ baseUrl: "http://remote.example/v1" });
    await h.app.saveAi(false);
    await settle();
    expect(h.messages).toEqual([]);
    expect(
      h.roots.services.querySelector("#test-message")?.textContent,
    ).toContain("providerUrlInvalid");
  });

  it("asks for a cloud provider's host before autosaving the choice", async () => {
    const requestOrigins = vi.fn(() => Promise.resolve(false));
    const h = await mount({ requestOrigins });
    await h.app.selectFastProvider("deepl");
    expect(requestOrigins).toHaveBeenCalledWith([
      "https://api-free.deepl.com/*",
    ]);
    expect(h.patches).toEqual([]);
    requestOrigins.mockResolvedValue(true);
    await h.app.selectFastProvider("deepl");
    expect(h.patches).toEqual([{ provider: { fastProvider: "deepl" } }]);
  });
});

describe("options app data clearing", () => {
  it("clears cache and credentials only after separate confirmations", async () => {
    const confirm = vi.fn<(request: ConfirmRequest) => Promise<boolean>>(() =>
      Promise.resolve(false),
    );
    const h = await mount({ confirm });
    await h.app.clearCache();
    await h.app.clearCredentials();
    expect(h.messages).toEqual([]);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ body: "optClearCacheImpact" }),
      expect.objectContaining({
        body: "optClearCredentialsImpact",
        danger: true,
      }),
    ]);

    confirm.mockResolvedValue(true);
    await h.app.clearCache();
    expect(h.messages.map((message) => message.type)).toEqual(["CACHE_CLEAR"]);
    await h.app.clearCredentials();
    expect(h.messages.map((message) => message.type)).toEqual([
      "CACHE_CLEAR",
      "CREDENTIALS_CLEAR",
    ]);
    await settle();
    expect(
      h.roots.privacy.querySelector("#data-message")?.textContent,
    ).toContain("credentialsCleared");
  });
});

function updateStatus(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    state: "current",
    currentVersion: "9.9.9",
    autoCheckEnabled: true,
    ...overrides,
  };
}

function switchButton(id: string): HTMLButtonElement {
  return inner<HTMLButtonElement>(document.querySelector(`#${id}`), "button");
}

describe("options app general group", () => {
  it("autosaves the floating switch, pill announcements and skipped marks", async () => {
    const h = await mount();
    switchButton("floating-control-enabled").click();
    await h.store.flush();
    await settle();
    expect(h.patches.at(-1)).toEqual({
      page: { floatingButtonEnabled: false },
      subtitles: { floatingButtonEnabled: false },
    });
    // Pill announcements depend on the control being shown.
    expect(
      document.querySelector<HTMLElement & { disabled: boolean }>(
        "#floating-announcements",
      )?.disabled,
    ).toBe(true);
    switchButton("floating-control-enabled").click();
    await h.store.flush();
    await settle();
    switchButton("floating-announcements").click();
    switchButton("page-show-skipped-marks").click();
    await h.store.flush();
    expect(h.patches.at(-1)).toEqual({
      floating: { announcements: false },
      page: { showSkippedMarks: true },
    });
    expect(h.store.storedValue.floating.announcements).toBe(false);
    expect(h.store.storedValue.page.showSkippedMarks).toBe(true);
  });

  it("writes the interface language and reloads only after it is saved", async () => {
    const reload = vi.fn();
    const h = await mount({ reload });
    h.failPatches("settings_patch_save_failed");
    await h.app.setUiLanguage("en");
    expect(reload).not.toHaveBeenCalled();
    h.failPatches(undefined);
    await h.app.setUiLanguage("zh-CN");
    expect(h.patches.at(-1)).toEqual({ uiLanguage: "zh-CN" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows the update banner and sends ignore/view through the existing messages", async () => {
    let state = "available";
    const openTab = vi.fn();
    const h = await mount(
      { openTab },
      {
        UPDATE_STATUS_GET: () =>
          updateStatus({
            state,
            latestVersion: "10.0.0",
            releaseUrl: "https://github.com/example/releases/tag/v10.0.0",
          }),
        UPDATE_IGNORE: () => {
          state = "ignored";
          return updateStatus({ state, latestVersion: "10.0.0" });
        },
      },
    );
    await h.app.refreshUpdateStatus(false);
    await settle();
    const banner = h.roots.general.querySelector("#update-banner");
    expect(banner?.textContent).toContain("updateAvailableTitle(10.0.0)");
    h.roots.general.querySelector<HTMLElement>("#update-banner-view")?.click();
    expect(openTab).toHaveBeenCalledWith(
      "https://github.com/example/releases/tag/v10.0.0",
    );
    h.roots.general
      .querySelector<HTMLElement>("#update-banner-ignore")
      ?.click();
    await settle();
    await settle();
    expect(h.messages.at(-1)).toEqual({
      type: "UPDATE_IGNORE",
      version: "10.0.0",
    });
    expect(h.roots.general.querySelector("#update-banner")).toBeNull();
    expect(
      h.roots.general.querySelector("#update-status")?.textContent,
    ).toContain("updateIgnored(10.0.0)");
  });

  it("keeps the last status and reports a failed check", async () => {
    const h = await mount(
      {},
      {
        UPDATE_STATUS_GET: () => updateStatus(),
        UPDATE_CHECK: () => {
          throw new Error("offline");
        },
        UPDATE_AUTO_CHECK_SET: (message) =>
          updateStatus({ autoCheckEnabled: message.enabled }),
      },
    );
    await h.app.refreshUpdateStatus(false);
    await h.app.refreshUpdateStatus(true);
    await settle();
    const status = h.roots.general.querySelector("#update-status");
    expect(status?.getAttribute("data-tone")).toBe("error");
    expect(status?.textContent).toContain("updateCheckFailed");
    switchButton("update-auto-check").click();
    await settle();
    await settle();
    expect(h.messages.at(-1)).toEqual({
      type: "UPDATE_AUTO_CHECK_SET",
      enabled: false,
    });
    expect(
      document.querySelector<HTMLElement & { checked: boolean }>(
        "#update-auto-check",
      )?.checked,
    ).toBe(false);
  });

  it("restores session-hidden floating controls and reports the count", async () => {
    const h = await mount(
      {},
      { FLOATING_SESSION_RESTORE: () => ({ ok: true, restored: 2 }) },
    );
    await h.app.restoreSessionFloating();
    await settle();
    expect(
      h.roots.general.querySelector("#restore-session-floating-message")
        ?.textContent,
    ).toContain("floatingSessionRestored(2)");
    expect(
      h.roots.general.querySelector("#extension-version")?.textContent,
    ).toContain("9.9.9");
    expect(
      h.roots.general
        .querySelector("#third-party-notices a")
        ?.getAttribute("href"),
    ).toBe("chrome-extension://test/bergamot/THIRD_PARTY_NOTICES.txt");
  });
});

describe("options app sites group", () => {
  it("opens a site from the list, edits an override and goes back", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const h = await mount(
      { confirm },
      {
        SITE_PROFILES_GET: () => ({
          ok: true,
          builtIns: [],
          profiles: [],
          overrides: [],
          translationProfiles: [
            {
              id: "user-example-org",
              version: 1,
              name: "Example",
              match: { hostnameSuffixes: ["example.org"] },
              overrides: {},
            },
          ],
        }),
      },
    );
    await h.app.sites.load();
    await settle();
    const entry = h.roots.sites.querySelector<HTMLButtonElement>(
      "#site-entry-user-example-org",
    );
    expect(entry?.textContent).toContain("profileInheritsGlobal");
    entry?.click();
    await settle();
    expect(
      h.roots.sites.querySelector("#site-detail-title")?.textContent,
    ).toContain("Example");
    expect(document.activeElement?.id).toBe("site-detail-title");
    // Fields appear only once the surface is overridden.
    expect(h.roots.sites.querySelector("#site-page-method")).toBeNull();
    switchButton("site-page-override").click();
    await settle();
    expect(h.roots.sites.querySelector("#site-page-method")).not.toBeNull();
    expect(h.app.hasUnsavedChanges).toBe(true);
    h.roots.sites.querySelector<HTMLElement>("#site-profile-back")?.click();
    await settle();
    await settle();
    expect(confirm).toHaveBeenCalled();
    expect(h.roots.sites.querySelector("#site-list-custom")).not.toBeNull();
  });
});
