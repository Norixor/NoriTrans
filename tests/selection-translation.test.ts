import { SelectionTranslation } from "@/src/page/selection-translation";
import { DEFAULT_SETTINGS, toContentSettings } from "@/src/shared/settings";
import type { ChromeLocalProvider } from "@/src/translation/providers/chrome-local";
import type {
  TranslationRequest,
  TranslationResult,
} from "@/src/translation/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runtimeSendMessage } = vi.hoisted(() => ({
  runtimeSendMessage: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: { getMessage: (key: string) => key },
    runtime: { sendMessage: runtimeSendMessage },
  },
}));

vi.mock("@/src/shared/i18n", () => ({
  message: (key: string) => key,
}));

function selectNode(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function host(): HTMLElement {
  const value = document.querySelector<HTMLElement>(
    '[data-norixortrans-ui="selection-translation"]',
  );
  if (!value) throw new Error("Missing selection translation host");
  return value;
}

function root(): ShadowRoot {
  const value = host().shadowRoot;
  if (!value) throw new Error("Missing selection translation root");
  return value;
}

async function flushSelection(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 20));
}

let controls: SelectionTranslation[] = [];

beforeEach(() => {
  document.documentElement.replaceChildren(
    document.createElement("head"),
    document.createElement("body"),
  );
  document.getSelection()?.removeAllRanges();
  runtimeSendMessage.mockReset();
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => ({
      0: new DOMRect(120, 80, 140, 24),
      item: (index: number) =>
        index === 0 ? new DOMRect(120, 80, 140, 24) : null,
      length: 1,
      [Symbol.iterator]: function* () {
        yield this[0];
      },
    }),
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(120, 80, 140, 24),
  });
});

afterEach(() => {
  for (const control of controls) control.destroy();
  controls = [];
});

function createControl(
  translate: (
    request: TranslationRequest,
    signal: AbortSignal,
    settings: ReturnType<typeof toContentSettings>,
  ) => Promise<TranslationResult[]> = vi.fn(() =>
    Promise.resolve([{ id: "selection", translatedText: "你好" }]),
  ),
  settings = toContentSettings(DEFAULT_SETTINGS),
) {
  const copyText = vi.fn(() => Promise.resolve());
  const control = new SelectionTranslation(settings, {
    translate,
    copyText,
    message: (key) => key,
  });
  controls.push(control);
  return { control, translate, copyText };
}

describe("selection translation", () => {
  it("shows a compact accessible trigger without translating automatically", async () => {
    const translate = vi.fn<
      (
        request: TranslationRequest,
        signal: AbortSignal,
      ) => Promise<TranslationResult[]>
    >(() => Promise.resolve([{ id: "selection", translatedText: "你好" }]));
    createControl(translate);
    const paragraph = document.body.appendChild(document.createElement("p"));
    paragraph.textContent = "Hello selection";

    selectNode(paragraph.firstChild!);
    await flushSelection();

    expect(host().hidden).toBe(false);
    expect(host().dataset.state).toBe("ready");
    const trigger =
      root().querySelector<HTMLButtonElement>(".translate-trigger")!;
    expect(trigger.hidden).toBe(false);
    expect(trigger.getAttribute("aria-label")).toBe("selectionTranslate");
    expect(translate).not.toHaveBeenCalled();

    trigger.click();
    await vi.waitFor(() => expect(host().dataset.state).toBe("translated"));
    expect(translate).toHaveBeenCalledOnce();
    expect(translate.mock.calls[0]?.[0]).toMatchObject({
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      mode: "fast",
      responseMode: "stream",
      segments: [{ id: "selection", text: "Hello selection" }],
    });
    expect(root().querySelector(".original-text")?.textContent).toBe(
      "Hello selection",
    );
    expect(root().querySelector(".translated-text")?.textContent).toBe("你好");
    expect(root().querySelector<HTMLElement>(".loading")?.hidden).toBe(true);
    expect(
      getComputedStyle(root().querySelector<HTMLElement>(".loading")!).display,
    ).toBe("none");
    const copyButton = root().querySelector<HTMLButtonElement>(".copy-button")!;
    expect(copyButton.hidden).toBe(false);
    expect(copyButton.disabled).toBe(false);
  });

  it("removes provider translation labels from the displayed selection result", async () => {
    createControl(() =>
      Promise.resolve([
        { id: "selection", translatedText: "译: Clean selection result" },
      ]),
    );
    const paragraph = document.body.appendChild(document.createElement("p"));
    paragraph.textContent = "Selection label fixture";

    selectNode(paragraph.firstChild!);
    await flushSelection();
    root().querySelector<HTMLButtonElement>(".translate-trigger")?.click();
    await vi.waitFor(() => expect(host().dataset.state).toBe("translated"));

    expect(root().querySelector(".translated-text")?.textContent).toBe(
      "Clean selection result",
    );
  });

  it("uses its own translation mode independently from whole-page translation", async () => {
    const translate = vi.fn<
      (request: TranslationRequest) => Promise<TranslationResult[]>
    >(() =>
      Promise.resolve([{ id: "selection", translatedText: "AI result" }]),
    );
    const settings = toContentSettings(DEFAULT_SETTINGS);
    settings.page.mode = "fast";
    settings.page.selectionTranslationMode = "ai";
    createControl(translate, settings);
    const paragraph = document.body.appendChild(document.createElement("p"));
    paragraph.textContent = "Independent selection mode";

    selectNode(paragraph.firstChild!);
    await flushSelection();
    root().querySelector<HTMLButtonElement>(".translate-trigger")?.click();
    await vi.waitFor(() => expect(host().dataset.state).toBe("translated"));

    expect(translate.mock.calls[0]?.[0]).toMatchObject({
      mode: "ai",
      responseMode: "stream",
    });
  });

  it.each([
    ["empty punctuation", "p", "... !!!"],
    ["extension UI", "div", "Do not translate this"],
    ["editable text", "div", "Editable text"],
    ["oversized text", "p", "a".repeat(5_001)],
  ])("ignores %s", async (kind, tagName, text) => {
    createControl();
    const element = document.body.appendChild(document.createElement(tagName));
    element.textContent = text;
    if (kind === "extension UI") element.dataset.norixortransUi = "fixture";
    if (kind === "editable text")
      element.setAttribute("contenteditable", "true");

    selectNode(element.firstChild!);
    await flushSelection();

    expect(host().hidden).toBe(true);
  });

  it("cancels stale work and prevents a late response from replacing a new selection", async () => {
    let resolveFirst: ((results: TranslationResult[]) => void) | undefined;
    const translate = vi.fn(
      (_request: unknown, signal: AbortSignal) =>
        new Promise<TranslationResult[]>((resolve) => {
          resolveFirst = resolve;
          signal.addEventListener("abort", () => undefined);
        }),
    );
    createControl(translate);
    const first = document.body.appendChild(document.createElement("p"));
    first.textContent = "First selection";
    const second = document.body.appendChild(document.createElement("p"));
    second.textContent = "Second selection";

    selectNode(first.firstChild!);
    await flushSelection();
    root().querySelector<HTMLButtonElement>(".translate-trigger")!.click();
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    root().querySelector<HTMLElement>(".card")?.blur();
    selectNode(second.firstChild!);
    await flushSelection();
    resolveFirst?.([{ id: "selection", translatedText: "迟到结果" }]);
    await Promise.resolve();

    expect(host().dataset.state).toBe("ready");
    expect(root().querySelector(".translated-text")?.textContent).not.toBe(
      "迟到结果",
    );
  });

  it("offers retry after an isolated error and copies a successful result", async () => {
    const translate = vi
      .fn()
      .mockRejectedValueOnce(new Error("request_failed"))
      .mockResolvedValueOnce([
        { id: "selection", translatedText: "Copied result" },
      ]);
    const { copyText } = createControl(translate);
    const paragraph = document.body.appendChild(document.createElement("p"));
    paragraph.textContent = "Retry selection";
    selectNode(paragraph.firstChild!);
    await flushSelection();
    root().querySelector<HTMLButtonElement>(".translate-trigger")!.click();
    await vi.waitFor(() => expect(host().dataset.state).toBe("error"));
    expect(
      root().querySelector<HTMLButtonElement>(".copy-button")?.hidden,
    ).toBe(true);
    expect(root().querySelector(".error-text")?.textContent).toBe(
      "runtimeErrorRequestFailed",
    );

    root().querySelector<HTMLButtonElement>(".retry-button")!.click();
    await vi.waitFor(() => expect(host().dataset.state).toBe("translated"));
    root().querySelector<HTMLButtonElement>(".copy-button")!.click();
    await vi.waitFor(() =>
      expect(copyText).toHaveBeenCalledWith("Copied result"),
    );
    expect(root().querySelector(".copy-status")?.textContent).toBe(
      "selectionCopied",
    );
  });

  it("closes on Escape and disables immediately when settings change", async () => {
    const { control } = createControl();
    const paragraph = document.body.appendChild(document.createElement("p"));
    paragraph.textContent = "Close this selection";
    selectNode(paragraph.firstChild!);
    await flushSelection();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(host().hidden).toBe(true);

    selectNode(paragraph.firstChild!);
    await flushSelection();
    control.updateSettings({
      ...toContentSettings(DEFAULT_SETTINGS),
      page: {
        ...DEFAULT_SETTINGS.page,
        selectionTranslationEnabled: false,
      },
    });
    expect(host().hidden).toBe(true);
  });

  it("reuses a local Translator across selections and releases it on configuration changes", async () => {
    const providers: Array<{
      translateBatch: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }> = [];
    const createLocalProvider = vi.fn(() => {
      const provider = {
        translateBatch: vi.fn((request: TranslationRequest) =>
          Promise.resolve([
            {
              id: "selection",
              translatedText: `T:${request.segments[0]?.text ?? ""}`,
            },
          ]),
        ),
        dispose: vi.fn(() => Promise.resolve()),
      };
      providers.push(provider);
      return provider as unknown as ChromeLocalProvider;
    });
    const settings = toContentSettings(DEFAULT_SETTINGS);
    const control = new SelectionTranslation(settings, {
      createLocalProvider,
      copyText: () => Promise.resolve(),
      message: (key) => key,
    });
    controls.push(control);
    const first = document.body.appendChild(document.createElement("p"));
    first.textContent = "First local selection";
    const second = document.body.appendChild(document.createElement("p"));
    second.textContent = "Second local selection";

    selectNode(first.firstChild!);
    await flushSelection();
    root().querySelector<HTMLButtonElement>(".translate-trigger")!.click();
    await vi.waitFor(() => expect(host().dataset.state).toBe("translated"));
    root().querySelector<HTMLElement>(".card")?.blur();
    control.dismiss();
    selectNode(second.firstChild!);
    await flushSelection();
    root().querySelector<HTMLButtonElement>(".translate-trigger")!.click();
    await vi.waitFor(() =>
      expect(root().querySelector(".translated-text")?.textContent).toBe(
        "T:Second local selection",
      ),
    );

    expect(createLocalProvider).toHaveBeenCalledOnce();
    expect(providers[0]?.translateBatch).toHaveBeenCalledTimes(2);

    control.updateSettings({
      ...settings,
      page: {
        ...settings.page,
        selectionTranslationTargetLanguage: "ja",
      },
    });
    await vi.waitFor(() =>
      expect(providers[0]?.dispose).toHaveBeenCalledOnce(),
    );
    root().querySelector<HTMLElement>(".card")?.blur();

    selectNode(first.firstChild!);
    await flushSelection();
    root().querySelector<HTMLButtonElement>(".translate-trigger")!.click();
    await vi.waitFor(() => expect(host().dataset.state).toBe("translated"));
    expect(createLocalProvider).toHaveBeenCalledTimes(2);

    control.destroy();
    await vi.waitFor(() =>
      expect(providers[1]?.dispose).toHaveBeenCalledOnce(),
    );
  });
});
