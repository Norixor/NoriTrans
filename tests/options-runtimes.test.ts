import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import {
  LOCAL_TRANSLATION_RUNTIME_ORIGINS,
  OCR_RUNTIME_ORIGINS,
  RuntimePanels,
  type RuntimeConfirmRequest,
  type RuntimePanelsDeps,
} from "@/entrypoints/options/sections/runtimes";
import type { SectionContext } from "@/entrypoints/options/sections/common";
import type {
  LocalTranslationRuntimeInfo,
  OcrRuntimeInfo,
} from "@/src/messaging/protocol";
import type { LocalOcrEngine } from "@/src/ocr/engine";
import { DEFAULT_SETTINGS } from "@/src/shared/settings";
import { defineNtComponents } from "@/src/ui/components";

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: { sendMessage: vi.fn(), getURL: (path: string) => path },
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
});

type Message = { type: string; [key: string]: unknown };

const ocr = (
  pack: OcrRuntimeInfo["pack"],
  state: OcrRuntimeInfo["state"],
  extra: Partial<OcrRuntimeInfo> = {},
): OcrRuntimeInfo => ({
  pack,
  labelKey: `pack-${pack}`,
  languages: pack === "korean" ? ["kor"] : ["eng"],
  state,
  ...extra,
});

const local = (
  packId: string,
  sourceLanguage: string,
  targetLanguage: string,
  state: LocalTranslationRuntimeInfo["state"],
  extra: Partial<LocalTranslationRuntimeInfo> = {},
): LocalTranslationRuntimeInfo =>
  ({
    packId,
    sourceLanguage,
    targetLanguage,
    state,
    ...extra,
  }) as LocalTranslationRuntimeInfo;

class FakeTimers {
  private next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { callback, ms });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  runAll(): void {
    const entries = [...this.pending];
    this.pending.clear();
    for (const [, entry] of entries) entry.callback();
  }
}

interface Harness {
  panels: RuntimePanels;
  messages: Message[];
  origins: string[][];
  confirms: RuntimeConfirmRequest[];
  timers: FakeTimers;
  ocrRoot: HTMLElement;
  localRoot: HTMLElement;
  ocrUpdates: (readonly OcrRuntimeInfo[])[];
  state: {
    ocr: OcrRuntimeInfo[];
    local: LocalTranslationRuntimeInfo[];
    grant: boolean;
    confirm: boolean;
  };
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function context(sourceLanguage = "en"): SectionContext {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ocr.sourceLanguage = sourceLanguage;
  return {
    settings,
    capabilities: {
      chromePairs: [],
      chromeLoaded: true,
      localRuntimes: [],
      localLoaded: true,
    },
    update: () => undefined,
    beginEditing: () => undefined,
    endEditing: () => undefined,
  };
}

async function mount(
  initial: { ocr?: OcrRuntimeInfo[]; local?: LocalTranslationRuntimeInfo[] },
  overrides: Partial<RuntimePanelsDeps> = {},
  responses: Record<string, (message: Message) => unknown> = {},
  sourceLanguage = "en",
): Promise<Harness> {
  const messages: Message[] = [];
  const origins: string[][] = [];
  const confirms: RuntimeConfirmRequest[] = [];
  const ocrUpdates: (readonly OcrRuntimeInfo[])[] = [];
  const timers = new FakeTimers();
  const state = {
    ocr: initial.ocr ?? [],
    local: initial.local ?? [],
    grant: true,
    confirm: true,
  };
  const ocrRoot = document.createElement("div");
  const localRoot = document.createElement("div");
  document.body.append(ocrRoot, localRoot);
  const ctx = context(sourceLanguage);
  // eslint-disable-next-line prefer-const
  let panels: RuntimePanels;
  const paint = (): void => {
    render(panels.ocrTemplate(ctx), ocrRoot);
    render(panels.localTranslationTemplate(ctx), localRoot);
  };
  panels = new RuntimePanels({
    sendMessage: (value) => {
      const message = value as Message;
      messages.push(message);
      const custom = responses[message.type];
      if (custom) return Promise.resolve(custom(message));
      if (message.type === "OCR_RUNTIME_LIST") {
        return Promise.resolve({ ok: true, runtimes: state.ocr });
      }
      if (message.type === "LOCAL_TRANSLATION_RUNTIME_LIST") {
        return Promise.resolve({ ok: true, runtimes: state.local });
      }
      return Promise.resolve({ ok: true });
    },
    requestOrigins: (value) => {
      origins.push(value);
      return Promise.resolve(state.grant);
    },
    confirm: (request) => {
      confirms.push(request);
      return Promise.resolve(state.confirm);
    },
    requestRender: () => paint(),
    onOcrRuntimes: (runtimes) => ocrUpdates.push(runtimes),
    onLocalTranslationRuntimes: () => undefined,
    timers,
    ...overrides,
  });
  paint();
  await panels.start();
  await flush();
  return {
    panels,
    messages,
    origins,
    confirms,
    timers,
    ocrRoot,
    localRoot,
    ocrUpdates,
    state,
  };
}

const button = (root: HTMLElement, selector: string): HTMLElement => {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
};

describe("RuntimePanels — image recognition packs", () => {
  it("renders every pack state with its action", async () => {
    const harness = await mount({
      ocr: [
        ocr("zh", "installed"),
        ocr("latin", "downloading", { progress: 0.42 }),
        ocr("korean", "error", { message: "OCR runtime download timed out." }),
      ],
    });
    const items = [...harness.ocrRoot.querySelectorAll("#ocr-runtime-list li")];
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual([
      "installed",
      "downloading",
      "error",
    ]);
    expect(items[0]?.querySelector(".rt-state")?.textContent).toBe(
      "ocrRuntimeStateInstalled",
    );
    expect(
      items[0]?.querySelector("nt-button")?.getAttribute("data-runtime-action"),
    ).toBe("delete");
    expect(items[1]?.querySelector(".rt-state")?.textContent).toBe(
      "ocrRuntimeStateDownloading(42)",
    );
    expect(items[1]?.querySelector("nt-progress-ring")).not.toBeNull();
    expect(items[1]?.querySelector("nt-button")?.hasAttribute("busy")).toBe(
      true,
    );
    expect(items[2]?.querySelector(".rt-detail")?.textContent).toBe(
      "ocrRuntimeDownloadTimedOut",
    );
    expect(harness.ocrUpdates.at(-1)).toHaveLength(3);
    // A pack is still downloading, so progress polling is armed.
    expect(harness.timers.pending.size).toBe(1);
  });

  it("asks for download access before downloading and stops when denied", async () => {
    const harness = await mount({ ocr: [ocr("zh", "missing")] });
    harness.state.grant = false;
    button(harness.ocrRoot, 'nt-button[data-runtime-pack="zh"]').click();
    await flush();
    expect(harness.origins).toEqual([[...OCR_RUNTIME_ORIGINS]]);
    expect(
      harness.messages.some(
        (message) => message.type === "OCR_RUNTIME_DOWNLOAD",
      ),
    ).toBe(false);
    const feedback = button(harness.ocrRoot, "#ocr-runtime-message");
    expect(feedback.textContent?.trim()).toBe("optRtOcrPermissionDenied");
    expect(feedback.dataset.tone).toBe("error");
  });

  it("downloads one pack after access is granted and polls progress", async () => {
    let resolveDownload: (value: unknown) => void = () => undefined;
    const download = new Promise((resolve) => {
      resolveDownload = resolve;
    });
    const harness = await mount(
      { ocr: [ocr("zh", "missing")] },
      {},
      { OCR_RUNTIME_DOWNLOAD: () => download },
    );
    button(harness.ocrRoot, 'nt-button[data-runtime-pack="zh"]').click();
    await flush();
    expect(harness.messages.at(-1)).toEqual({
      type: "OCR_RUNTIME_DOWNLOAD",
      pack: "zh",
    });
    expect(
      harness.ocrRoot
        .querySelector("#ocr-runtime-list li")
        ?.getAttribute("data-state"),
    ).toBe("downloading");
    expect(harness.timers.pending.size).toBe(1);
    harness.state.ocr = [ocr("zh", "downloading", { progress: 0.5 })];
    harness.timers.runAll();
    await flush();
    expect(harness.ocrRoot.querySelector(".rt-state")?.textContent).toBe(
      "ocrRuntimeStateDownloading(50)",
    );
    harness.state.ocr = [ocr("zh", "installed")];
    resolveDownload({ ok: true });
    await flush();
    expect(
      harness.ocrRoot
        .querySelector("#ocr-runtime-list li")
        ?.getAttribute("data-state"),
    ).toBe("installed");
    expect(harness.timers.pending.size).toBe(0);
  });

  it("downloads all missing packs with one permission request", async () => {
    const harness = await mount({
      ocr: [ocr("zh", "missing"), ocr("latin", "installed")],
    });
    button(harness.ocrRoot, "#ocr-runtime-download-all").click();
    await flush();
    expect(harness.origins).toHaveLength(1);
    expect(harness.messages.at(-2)).toEqual({
      type: "OCR_RUNTIME_DOWNLOAD_ALL",
    });
  });

  it("deletes only after confirmation", async () => {
    const harness = await mount({ ocr: [ocr("zh", "installed")] });
    harness.state.confirm = false;
    button(harness.ocrRoot, 'nt-button[data-runtime-action="delete"]').click();
    await flush();
    expect(harness.confirms).toHaveLength(1);
    expect(harness.confirms[0]).toMatchObject({
      title: "optRtOcrDeleteTitle",
      body: "optRtOcrDeleteBody(pack-zh)",
      danger: true,
    });
    expect(
      harness.messages.some((message) => message.type === "OCR_RUNTIME_DELETE"),
    ).toBe(false);

    harness.state.confirm = true;
    harness.state.ocr = [ocr("zh", "missing")];
    button(harness.ocrRoot, 'nt-button[data-runtime-action="delete"]').click();
    await flush();
    expect(harness.messages).toContainEqual({
      type: "OCR_RUNTIME_DELETE",
      pack: "zh",
    });
    expect(
      button(harness.ocrRoot, "#ocr-runtime-message").textContent?.trim(),
    ).toBe("ocrRuntimeDeleted");
  });

  it("shows a load failure without an empty-state claim", async () => {
    const harness = await mount(
      {},
      {},
      { OCR_RUNTIME_LIST: () => ({ ok: false }) },
    );
    expect(harness.ocrRoot.querySelector("#ocr-runtime-empty")).toBeNull();
    expect(
      button(harness.ocrRoot, "#ocr-runtime-message").textContent?.trim(),
    ).toBe("ocrRuntimesLoadFailed");
  });

  it("stops polling on dispose", async () => {
    const harness = await mount({
      ocr: [ocr("zh", "downloading", { progress: 0.1 })],
      local: [
        local("en-de", "en", "de", "downloading"),
        local("de-en", "de", "en", "installed"),
      ],
    });
    expect(harness.timers.pending.size).toBe(2);
    harness.panels.dispose();
    expect(harness.timers.pending.size).toBe(0);
  });
});

describe("RuntimePanels — self-test", () => {
  const engine = (
    recognize: LocalOcrEngine["recognize"],
  ): LocalOcrEngine & { destroyed: boolean } => {
    const value = {
      destroyed: false,
      availability: () => Promise.resolve("available" as const),
      prepare: (
        _signal: AbortSignal,
        onProgress?: (progress: { progress: number; status: string }) => void,
      ) => {
        onProgress?.({ progress: 0.5, status: "loading" });
        return Promise.resolve();
      },
      recognize,
      destroy: () => {
        value.destroyed = true;
        return Promise.resolve();
      },
    };
    return value;
  };

  it("reports the recognized sample on success", async () => {
    const fake = engine(() => Promise.resolve({ text: "HELLO  OCR\n123" }));
    const harness = await mount(
      {},
      {
        createOcrEngine: () => fake,
        createSelfTestSample: () => document.createElement("canvas"),
      },
    );
    button(harness.ocrRoot, "#ocr-self-test").click();
    await flush();
    const output = button(harness.ocrRoot, "#ocr-test-message");
    expect(output.textContent).toBe("optRtSelfTestSucceeded(HELLO OCR 123)");
    expect(output.dataset.tone).toBe("success");
    expect(fake.destroyed).toBe(true);
  });

  it("maps a missing pack and keeps other failures as collapsed details", async () => {
    const missing = engine(() =>
      Promise.reject(new Error("ocr_runtime_missing:latin")),
    );
    const harness = await mount(
      {},
      {
        createOcrEngine: () => missing,
        createSelfTestSample: () => document.createElement("canvas"),
      },
    );
    button(harness.ocrRoot, "#ocr-self-test").click();
    await flush();
    expect(button(harness.ocrRoot, "#ocr-test-message").textContent).toBe(
      "optRtSelfTestPackMissing",
    );

    const broken = engine(() =>
      Promise.reject(new Error("boom at chrome-extension://abc/offscreen.js")),
    );
    const second = await mount(
      {},
      {
        createOcrEngine: () => broken,
        createSelfTestSample: () => document.createElement("canvas"),
      },
    );
    button(second.ocrRoot, "#ocr-self-test").click();
    await flush();
    const output = button(second.ocrRoot, "#ocr-test-message");
    expect(output.textContent).toBe("optRtSelfTestFailed");
    expect(output.dataset.tone).toBe("error");
    expect(
      second.ocrRoot.querySelector("#ocr-test-detail pre")?.textContent,
    ).toBe("boom at extension:/offscreen.js");
  });

  it("rejects an unsupported source language without starting the engine", async () => {
    const create = vi.fn();
    const harness = await mount({}, { createOcrEngine: create }, {}, "xx");
    button(harness.ocrRoot, "#ocr-self-test").click();
    await flush();
    expect(create).not.toHaveBeenCalled();
    expect(button(harness.ocrRoot, "#ocr-test-message").textContent).toBe(
      "optRtSelfTestSourceUnsupported",
    );
  });
});

describe("RuntimePanels — offline translation packs", () => {
  const pairs = (): LocalTranslationRuntimeInfo[] => [
    local("en-de", "en", "de", "installed", { bytes: 1024, version: "1" }),
    local("de-en", "de", "en", "installed", { bytes: 1024, version: "1" }),
    local("en-fr", "en", "fr", "missing", { downloadBytes: 2048 }),
    local("fr-en", "fr", "en", "missing", { downloadBytes: 2048 }),
  ];

  it("groups both directions into one row per language", async () => {
    const harness = await mount({ local: pairs() });
    const items = [
      ...harness.localRoot.querySelectorAll(
        "#local-translation-runtime-list li",
      ),
    ];
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual([
      "installed",
      "missing",
    ]);
    expect(items[0]?.querySelector(".rt-state")?.textContent).toBe(
      "localTranslationRuntimeInstalled",
    );
  });

  it("denied access sends no download", async () => {
    const harness = await mount({ local: pairs() });
    harness.state.grant = false;
    button(
      harness.localRoot,
      'li[data-runtime-language="fr"] nt-button',
    ).click();
    await flush();
    expect(harness.origins).toEqual([[...LOCAL_TRANSLATION_RUNTIME_ORIGINS]]);
    expect(
      harness.messages.some(
        (message) => message.type === "LOCAL_TRANSLATION_RUNTIME_DOWNLOAD",
      ),
    ).toBe(false);
    expect(
      button(
        harness.localRoot,
        "#local-translation-runtime-message",
      ).textContent?.trim(),
    ).toBe("optRtLocalPermissionDenied");
  });

  it("downloads each missing direction and maps failures", async () => {
    const harness = await mount(
      { local: pairs() },
      {},
      {
        LOCAL_TRANSLATION_RUNTIME_DOWNLOAD: (message) =>
          message.packId === "fr-en"
            ? { ok: false, error: "bergamot_integrity_failed" }
            : { ok: true },
      },
    );
    button(
      harness.localRoot,
      'li[data-runtime-language="fr"] nt-button',
    ).click();
    await flush();
    expect(
      harness.messages
        .filter(
          (message) => message.type === "LOCAL_TRANSLATION_RUNTIME_DOWNLOAD",
        )
        .map((message) => message.packId),
    ).toEqual(["en-fr", "fr-en"]);
    expect(
      button(
        harness.localRoot,
        "#local-translation-runtime-message",
      ).textContent?.trim(),
    ).toBe("optRtLocalIntegrityFailed");
  });

  it("deletes both directions only after confirmation", async () => {
    const harness = await mount({ local: pairs() });
    harness.state.confirm = false;
    button(
      harness.localRoot,
      'li[data-runtime-language="de"] nt-button',
    ).click();
    await flush();
    expect(harness.confirms[0]?.danger).toBe(true);
    expect(
      harness.messages.some(
        (message) => message.type === "LOCAL_TRANSLATION_RUNTIME_DELETE",
      ),
    ).toBe(false);

    harness.state.confirm = true;
    button(
      harness.localRoot,
      'li[data-runtime-language="de"] nt-button',
    ).click();
    await flush();
    expect(
      harness.messages
        .filter(
          (message) => message.type === "LOCAL_TRANSLATION_RUNTIME_DELETE",
        )
        .map((message) => message.packId),
    ).toEqual(["en-de", "de-en"]);
    expect(
      button(
        harness.localRoot,
        "#local-translation-runtime-message",
      ).textContent?.trim(),
    ).toBe("localTranslationRuntimeDeleted");
  });
});
