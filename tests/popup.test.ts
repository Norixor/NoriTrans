import { afterEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";

const popupState = vi.hoisted<{
  pageStatus: unknown;
  subtitleStatus: unknown;
  capabilities: {
    chromePairs: string[];
    installedBergamotPackIds: string[];
  };
}>(() => ({
  pageStatus: null,
  subtitleStatus: null,
  capabilities: {
    chromePairs: ["en\u001fzh-CN"],
    installedBergamotPackIds: [],
  },
}));

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: {
      getMessage: (key: string) => key,
      getUILanguage: () => "en",
    },
    runtime: {
      sendMessage: vi.fn(() => Promise.resolve({ ok: true })),
      openOptionsPage: vi.fn(() => Promise.resolve()),
    },
    tabs: {
      query: vi.fn(() => Promise.resolve([{ id: 7 }])),
      sendMessage: vi.fn((_tabId: number, request: { type: string }) =>
        Promise.resolve(
          request.type === "PAGE_STATUS"
            ? popupState.pageStatus
            : request.type === "SUBTITLE_STATUS"
              ? popupState.subtitleStatus
              : request.type === "TRANSLATION_CAPABILITIES_GET"
                ? {
                    ok: true,
                    capabilities: popupState.capabilities,
                  }
                : { ok: true },
        ),
      ),
    },
    storage: {
      local: {
        get: vi.fn(() => Promise.resolve({})),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  },
}));

vi.mock("@/src/shared/i18n", () => ({
  currentUiLocale: () => "en",
  initializeUiLanguage: () => Promise.resolve("auto"),
  localizeDocument: vi.fn(),
  message: (key: string, substitutions?: string | string[]) => {
    const values = Array.isArray(substitutions)
      ? substitutions
      : substitutions === undefined
        ? []
        : [substitutions];
    return values.length > 0 ? `${key} ${values.join("/")}` : key;
  },
}));

function installPopupMarkup(): void {
  document.body.innerHTML = `
    <aside id="update-banner" hidden>
      <strong id="update-title"></strong>
      <button id="view-update" type="button"></button>
      <button id="ignore-update" type="button"></button>
    </aside>
    <section id="status-section" aria-busy="true">
      <strong id="page-status"></strong>
      <span id="page-progress"></span>
      <details id="page-diagnostic"><pre></pre></details>
      <strong id="subtitle-status"></strong>
      <span id="subtitle-progress"></span>
      <details id="subtitle-diagnostic"><pre></pre></details>
    </section>
    <form id="translation-form">
      <select id="translation-method" name="translation-method"></select>
      <select id="source-language" name="source-language"></select>
      <select id="target-language" name="target-language"></select>
      <label id="response-mode-field">
        <select id="response-mode" name="response-mode">
          <option value="stream">stream</option>
          <option value="batch">batch</option>
        </select>
      </label>
      <input type="radio" name="display-mode" value="translated" />
      <input type="radio" name="display-mode" value="bilingual" />
      <button id="translate-page" type="submit"></button>
      <button id="restore-page" type="button"></button>
    </form>
    <p id="action-message"></p>
    <button id="open-options" type="button"></button>
  `;
}

describe("popup status UI", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    popupState.capabilities = {
      chromePairs: ["en\u001fzh-CN"],
      installedBergamotPackIds: [],
    };
    document.body.replaceChildren();
  });

  it("disables page actions when unavailable and labels full and stream subtitles", async () => {
    vi.useFakeTimers();
    installPopupMarkup();
    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string) => key,
        getUILanguage: () => "en",
      },
    });
    vi.stubGlobal("browser", browser);
    popupState.pageStatus = {
      state: "unavailable",
      total: 0,
      completed: 0,
      failed: 0,
    };
    popupState.subtitleStatus = {
      state: "ready",
      completeness: "full",
      total: 2,
      completed: 2,
      failed: 0,
    };

    await import("@/entrypoints/popup/main");
    await vi.waitFor(() =>
      expect(
        document.querySelector("#status-section")?.getAttribute("aria-busy"),
      ).toBe("false"),
    );

    const translate =
      document.querySelector<HTMLButtonElement>("#translate-page");
    const restore = document.querySelector<HTMLButtonElement>("#restore-page");
    const subtitle = document.querySelector<HTMLElement>("#subtitle-status");
    expect(translate?.disabled).toBe(true);
    expect(restore?.disabled).toBe(true);
    expect(subtitle?.textContent).toBe(
      "subtitleStatusReady · subtitleTrackFull",
    );

    popupState.pageStatus = {
      state: "idle",
      total: 0,
      completed: 0,
      failed: 0,
    };
    popupState.subtitleStatus = {
      state: "ready",
      completeness: "stream",
      total: 3,
      completed: 3,
      failed: 0,
    };
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(translate?.disabled).toBe(false));
    expect(restore?.disabled).toBe(false);
    expect(subtitle?.textContent).toBe(
      "subtitleStatusReady · subtitleTrackStream",
    );

    popupState.capabilities = {
      chromePairs: [],
      installedBergamotPackIds: [],
    };
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(translate?.disabled).toBe(true));
    const source =
      document.querySelector<HTMLSelectElement>("#source-language");
    expect(source?.value).toBe("auto");
    expect(source?.selectedOptions[0]?.textContent).toBe("languageAuto");
    expect(source?.selectedOptions[0]?.disabled).toBe(false);
  });
});
