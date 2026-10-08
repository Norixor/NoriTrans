import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
import type { PageStatus, SubtitleStatus } from "@/src/messaging/protocol";
import { DEFAULT_SETTINGS, type AppSettings } from "@/src/shared/settings";
import { defineNtComponents } from "@/src/ui/components";
import { resolveReason } from "@/src/ui/status";
import { isRestrictedUrl } from "@/entrypoints/popup/tab";
import { PopupApp } from "@/entrypoints/popup/app";

interface PopupState {
  url: string | undefined;
  ensureOk: boolean;
  pageStatus: unknown;
  subtitleStatus: unknown;
  settings: AppSettings;
  update: unknown;
  commandError: boolean;
  /** Overrides the `SETTINGS_PATCH` reply (e.g. a rejection). */
  patchResponse?: unknown;
}

const state = vi.hoisted<{ current: PopupState | undefined }>(() => ({
  current: undefined,
}));

function popup(): PopupState {
  if (!state.current) throw new Error("popup state not initialized");
  return state.current;
}

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: {
      getMessage: (key: string) => key,
      getUILanguage: () => "en",
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test${path}`,
      openOptionsPage: vi.fn(() => Promise.resolve()),
      sendMessage: vi.fn(
        (request: {
          type: string;
          enabled?: boolean;
          patch?: Record<string, Record<string, unknown>>;
        }) => {
          const current = popup();
          switch (request.type) {
            case "SETTINGS_PATCH": {
              if (current.patchResponse !== undefined) {
                return Promise.resolve(current.patchResponse);
              }
              // Field-level merge, as the background applies a valid patch.
              const next = structuredClone(
                current.settings,
              ) as unknown as Record<string, Record<string, unknown>>;
              for (const [section, fields] of Object.entries(
                request.patch ?? {},
              )) {
                next[section] = { ...next[section], ...fields };
              }
              current.settings = next as unknown as AppSettings;
              return Promise.resolve({
                ok: true,
                code: "settings_patch_applied",
                settings: next,
              });
            }
            case "ENSURE_PAGE_CONTENT":
              return Promise.resolve({ ok: current.ensureOk });
            case "UPDATE_STATUS_GET":
              return Promise.resolve(current.update);
            case "UPDATE_IGNORE":
              return Promise.resolve({
                ...(current.update as object),
                state: "ignored",
              });
            default:
              return Promise.resolve({ ok: true });
          }
        },
      ),
    },
    tabs: {
      create: vi.fn(() => Promise.resolve({})),
      query: vi.fn(() => Promise.resolve([{ id: 7, url: popup().url }])),
      sendMessage: vi.fn((_tabId: number, request: { type: string }) => {
        const current = popup();
        if (request.type === "PAGE_STATUS") {
          return Promise.resolve(current.pageStatus);
        }
        if (request.type === "SUBTITLE_STATUS") {
          return Promise.resolve(current.subtitleStatus);
        }
        return current.commandError
          ? Promise.reject(new Error("no receiver"))
          : Promise.resolve({ ok: true });
      }),
    },
    storage: {
      local: {
        get: vi.fn(() => Promise.resolve({ settings: popup().settings })),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

vi.mock("@/src/shared/i18n", () => ({
  currentUiLocale: () => "en",
  message: (key: string, subs?: string | string[]) =>
    subs && subs.length > 0 ? `${key}(${[subs].flat().join(",")})` : key,
}));

const IDLE_PAGE: PageStatus = {
  state: "idle",
  total: 0,
  completed: 0,
  failed: 0,
};
const WAITING_SUBTITLES: SubtitleStatus = {
  state: "waiting",
  total: 0,
  completed: 0,
  failed: 0,
};

function settingsWith(
  patch: (settings: AppSettings) => AppSettings = (value) => value,
): AppSettings {
  return patch(structuredClone(DEFAULT_SETTINGS));
}

let app: PopupApp | undefined;

async function mountPopup(overrides: Partial<PopupState> = {}): Promise<{
  root: HTMLElement;
  app: PopupApp;
}> {
  state.current = {
    url: "https://news.example.com/article",
    ensureOk: true,
    pageStatus: IDLE_PAGE,
    subtitleStatus: WAITING_SUBTITLES,
    settings: settingsWith(),
    update: {
      ok: true,
      state: "current",
      currentVersion: "1.0.0",
      autoCheckEnabled: true,
    },
    commandError: false,
    ...overrides,
  };
  document.body.innerHTML = `<main id="popup"></main>`;
  const root = document.querySelector<HTMLElement>("#popup")!;
  app = new PopupApp(root, popup().settings, { pendingGraceMs: 10_000 });
  await app.start(0);
  return { root, app };
}

function card(root: HTMLElement, task: "page" | "subtitle"): HTMLElement {
  const element = root.querySelector<HTMLElement>(
    `nt-status-card[data-card="${task}"]`,
  );
  if (!element) throw new Error(`missing ${task} card`);
  return element;
}

function action(
  root: HTMLElement,
  task: "page" | "subtitle",
  id: string,
): HTMLElement & { disabled: boolean; busy: boolean } {
  const button = card(root, task).querySelector<
    HTMLElement & { disabled: boolean; busy: boolean }
  >(`nt-button[data-action="${id}"]`);
  if (!button) throw new Error(`missing ${task} action ${id}`);
  return button;
}

function sentToTab(type: string): boolean {
  return vi
    .mocked(browser.tabs.sendMessage)
    .mock.calls.some(
      ([, request]) => (request as { type: string }).type === type,
    );
}

function runtimeMessages(type: string): Record<string, unknown>[] {
  return vi
    .mocked(browser.runtime.sendMessage)
    .mock.calls.map(
      ([request]) => request as unknown as Record<string, unknown>,
    )
    .filter((request) => request.type === type);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  // `loadSettings` reads the WXT global, not the module import.
  vi.stubGlobal("browser", browser);
  defineNtComponents();
});

afterEach(() => {
  app?.dispose();
  app = undefined;
  state.current = undefined;
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("restricted pages", () => {
  it.each([
    ["chrome://extensions/", true],
    ["https://chromewebstore.google.com/detail/x", true],
    ["https://chrome.google.com/webstore/detail/x", true],
    ["about:blank", true],
    ["https://example.com/", false],
    ["http://localhost:8080/", false],
  ])("classifies %s", (url, restricted) => {
    expect(isRestrictedUrl(url)).toBe(restricted);
  });

  it("shows one 'cannot translate' card without touching the tab", async () => {
    const { root } = await mountPopup({ url: "chrome://settings/" });

    const page = card(root, "page");
    expect(page.dataset.kind).toBe("unavailable");
    expect(page.getAttribute("description")).toContain(
      resolveReason("restricted_page").text.key,
    );
    expect(root.querySelector('[data-card="subtitle"]')).toBeNull();
    expect(root.querySelector("nt-switch")).toBeNull();
    expect(page.querySelector("nt-button")).toBeNull();
    expect(runtimeMessages("ENSURE_PAGE_CONTENT")).toHaveLength(0);
  });

  it("treats a page whose content script cannot be injected as restricted", async () => {
    const { root } = await mountPopup({ ensureOk: false });

    expect(card(root, "page").getAttribute("description")).toContain(
      resolveReason("restricted_page").text.key,
    );
    expect(sentToTab("PAGE_STATUS")).toBe(false);
  });
});

describe("page card", () => {
  it("starts translation and keeps the slot in a disabled transition", async () => {
    const { root, app } = await mountPopup();

    const translate = action(root, "page", "translate");
    expect(translate.getAttribute("data-primary")).toBe("true");
    translate.click();
    await flush();

    expect(runtimeMessages("ENSURE_PAGE_CONTENT").length).toBeGreaterThan(1);
    expect(sentToTab("PAGE_TRANSLATE")).toBe(true);
    // The backend has not confirmed yet: same slot, transitional label.
    const pending = action(root, "page", "translate");
    expect(pending.textContent).toContain("statusActionStarting");
    expect(pending.disabled).toBe(true);
    expect(pending.busy).toBe(true);

    popup().pageStatus = {
      state: "translating",
      total: 120,
      completed: 36,
      failed: 0,
    } satisfies PageStatus;
    await app.refresh();

    const stop = action(root, "page", "stop");
    expect(stop.disabled).toBe(false);
    expect(card(root, "page").getAttribute("heading")).toContain("36,120");
    stop.click();
    await flush();
    expect(sentToTab("PAGE_CANCEL")).toBe(true);
    expect(action(root, "page", "stop").textContent).toContain(
      "statusActionStopping",
    );
  });

  it("offers retry of failed blocks and restore after a partial result", async () => {
    const { root } = await mountPopup({
      pageStatus: {
        state: "partial",
        total: 10,
        completed: 7,
        failed: 3,
        reasonCode: "rate_limited",
        details: "http 429 · ids 3",
      } satisfies PageStatus,
    });

    const page = card(root, "page");
    expect(page.dataset.kind).toBe("partial");
    expect(page.getAttribute("description")).toContain(
      resolveReason("rate_limited").text.key,
    );
    expect(page.querySelector("details pre")?.textContent).toContain(
      "http 429",
    );
    const retry = action(root, "page", "retry");
    expect(retry.textContent).toContain("3");
    retry.click();
    await flush();
    expect(sentToTab("PAGE_RETRY_FAILED")).toBe(true);
    expect(action(root, "page", "retry").textContent).toContain(
      "statusActionRetrying",
    );
  });

  it("reports a failed command and frees the action again", async () => {
    const { root } = await mountPopup({ commandError: true });

    action(root, "page", "translate").click();
    await flush();

    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "pageActionFailed",
    );
    const translate = action(root, "page", "translate");
    expect(translate.disabled).toBe(false);
    expect(translate.busy).toBe(false);
  });

  it("routes a configuration error to the provider settings", async () => {
    const { root } = await mountPopup({
      pageStatus: {
        state: "error",
        total: 4,
        completed: 0,
        failed: 4,
        reasonCode: "invalid_configuration",
      } satisfies PageStatus,
    });

    action(root, "page", "openProviderSettings").click();
    await flush();
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://test/options.html#providers",
    });
  });
});

describe("subtitle card", () => {
  it("shows 'off' with a way to turn it on instead of detection results", async () => {
    const { root } = await mountPopup({
      settings: settingsWith((value) => ({
        ...value,
        subtitles: { ...value.subtitles, enabled: false },
      })),
      subtitleStatus: {
        state: "unavailable",
        total: 0,
        completed: 0,
        failed: 0,
        reasonCode: "subtitle_no_track",
      } satisfies SubtitleStatus,
    });

    const subtitle = card(root, "subtitle");
    expect(subtitle.dataset.kind).toBe("disabled");
    const description = subtitle.getAttribute("description") ?? "";
    expect(description).toContain("popupSubtitleDisabledHint");
    expect(description).not.toContain(
      resolveReason("subtitle_no_track").text.key,
    );

    action(root, "subtitle", "enable").click();
    await flush();
    expect(runtimeMessages("SETTINGS_SET")).toEqual([]);
    const [saved] = runtimeMessages("SETTINGS_PATCH");
    expect(saved?.patch).toEqual({ subtitles: { enabled: true } });
    // The setting is on now, so detection results may show again.
    expect(card(root, "subtitle").dataset.kind).toBe("unavailable");
  });

  it("rescans for subtitles when discovery ended without a track", async () => {
    const { root } = await mountPopup({
      subtitleStatus: {
        state: "unavailable",
        total: 0,
        completed: 0,
        failed: 0,
        reasonCode: "subtitle_no_track",
      } satisfies SubtitleStatus,
    });
    expect(
      card(root, "subtitle").querySelector('[data-action="enable"]'),
    ).toBeNull();
    action(root, "subtitle", "rescan").click();
    await flush();
    expect(sentToTab("SUBTITLE_START")).toBe(true);
  });

  it("stops a running pre-translation with the track chip shown", async () => {
    const { root } = await mountPopup({
      subtitleStatus: {
        state: "translating",
        source: "youtube-timedtext",
        completeness: "full",
        total: 412,
        completed: 128,
        failed: 0,
      } satisfies SubtitleStatus,
    });

    expect(
      card(root, "subtitle").querySelector('nt-chip[data-track="full"]'),
    ).not.toBeNull();
    action(root, "subtitle", "stop").click();
    await flush();
    expect(sentToTab("SUBTITLE_CANCEL")).toBe(true);
  });
});

describe("site switches", () => {
  it("turns auto-translate on for this site and starts the page", async () => {
    const { root } = await mountPopup();
    const toggle = root.querySelector<HTMLElement & { checked: boolean }>(
      'nt-switch[data-switch="auto-translate"]',
    )!;
    expect(toggle.getAttribute("description")).toBe("*.example.com");
    expect(toggle.checked).toBe(false);

    toggle.dispatchEvent(
      new CustomEvent("change", { detail: { checked: true } }),
    );
    await flush();

    expect(runtimeMessages("SETTINGS_SET")).toEqual([]);
    const [saved] = runtimeMessages("SETTINGS_PATCH");
    // Only the two rule lists are sent; other page fields are untouched.
    expect(saved?.patch).toEqual({
      page: {
        autoTranslateSitePatterns: ["*.example.com"],
        autoTranslateExcludedSitePatterns: [],
      },
    });
    expect(sentToTab("PAGE_AUTO_TRANSLATE_CURRENT")).toBe(true);
  });

  it("reports a rejected patch and keeps the switch off", async () => {
    const { root } = await mountPopup({
      patchResponse: { ok: false, code: "settings_patch_save_failed" },
    });
    const toggle = root.querySelector<HTMLElement & { checked: boolean }>(
      'nt-switch[data-switch="auto-translate"]',
    )!;
    toggle.dispatchEvent(
      new CustomEvent("change", { detail: { checked: true } }),
    );
    await flush();
    expect(root.textContent).toContain("settingsSaveFailed");
    expect(
      root.querySelector<HTMLElement & { checked: boolean }>(
        'nt-switch[data-switch="auto-translate"]',
      )!.checked,
    ).toBe(false);
    expect(sentToTab("PAGE_AUTO_TRANSLATE_CURRENT")).toBe(false);
  });

  it("turns auto-translate off for a site that has it on", async () => {
    const { root } = await mountPopup({
      settings: settingsWith((value) => ({
        ...value,
        page: { ...value.page, autoTranslateSitePatterns: ["*.example.com"] },
      })),
    });
    const toggle = root.querySelector<HTMLElement & { checked: boolean }>(
      'nt-switch[data-switch="auto-translate"]',
    )!;
    expect(toggle.checked).toBe(true);

    toggle.dispatchEvent(
      new CustomEvent("change", { detail: { checked: false } }),
    );
    await flush();

    const [saved] = runtimeMessages("SETTINGS_PATCH");
    expect(
      (saved?.patch as { page: AppSettings["page"] }).page
        .autoTranslateSitePatterns,
    ).not.toContain("*.example.com");
    expect(sentToTab("PAGE_AUTO_TRANSLATE_CURRENT")).toBe(false);
  });

  it("shows or hides the floating control everywhere", async () => {
    const { root } = await mountPopup();
    root
      .querySelector('nt-switch[data-switch="floating"]')!
      .dispatchEvent(new CustomEvent("change", { detail: { checked: false } }));
    await flush();

    expect(runtimeMessages("FLOATING_BUTTON_SET")).toEqual([
      { type: "FLOATING_BUTTON_SET", surface: "all", enabled: false },
    ]);
  });
});

describe("update notice", () => {
  const available = {
    ok: true,
    state: "available",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    releaseUrl: "https://github.com/example/releases/tag/v1.1.0",
    autoCheckEnabled: true,
  };

  it("is absent when no update is available", async () => {
    const { root } = await mountPopup();
    expect(root.querySelector(".update")).toBeNull();
  });

  it("sits below the status cards and can be ignored", async () => {
    const { root } = await mountPopup({ update: available });
    const notice = root.querySelector<HTMLElement>(".update")!;
    expect(notice.textContent).toContain("updateAvailableTitle(1.1.0)");
    expect(
      card(root, "subtitle").compareDocumentPosition(notice) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    notice
      .querySelector<HTMLButtonElement>('[data-update-action="view"]')!
      .click();
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: available.releaseUrl,
    });

    notice
      .querySelector<HTMLButtonElement>('[data-update-action="ignore"]')!
      .click();
    await flush();
    expect(runtimeMessages("UPDATE_IGNORE")).toEqual([
      { type: "UPDATE_IGNORE", version: "1.1.0" },
    ]);
    expect(root.querySelector(".update")).toBeNull();
  });
});
