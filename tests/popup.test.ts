import { afterEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";

const popupState = vi.hoisted<{
  pageStatus: unknown;
  subtitleStatus: unknown;
}>(() => ({ pageStatus: null, subtitleStatus: null }));

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
            : popupState.subtitleStatus,
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

function installPopupMarkup(): void {
  document.body.innerHTML = `
    <section id="status-section" aria-busy="true">
      <strong id="page-status"></strong>
      <span id="page-progress"></span>
      <details id="page-diagnostic"><pre></pre></details>
      <strong id="subtitle-status"></strong>
      <span id="subtitle-progress"></span>
      <details id="subtitle-diagnostic"><pre></pre></details>
    </section>
    <form id="translation-form">
      <select id="source-language" name="source-language"></select>
      <select id="target-language" name="target-language"></select>
      <select id="response-mode" name="response-mode">
        <option value="stream">stream</option>
        <option value="batch">batch</option>
      </select>
      <input type="radio" name="mode" value="fast" />
      <input type="radio" name="mode" value="ai" />
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
  });
});
