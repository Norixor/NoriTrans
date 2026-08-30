import { SubtitleProfileWizard } from "@/src/subtitles/profile-wizard";
import en from "@/public/_locales/en/messages.json";
import zhCn from "@/public/_locales/zh_CN/messages.json";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMessageMock = vi.hoisted(() => vi.fn());

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: {
      getMessage: getMessageMock,
    },
  },
}));

vi.mock("@/src/shared/i18n", () => ({
  message: (key: string, substitutions?: string | string[]) =>
    String(getMessageMock(key, substitutions)),
}));

interface LocaleMessage {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

function localizedMessage(
  locale: Record<string, LocaleMessage>,
  key: string,
  substitutions?: string | string[],
): string {
  const entry = locale[key];
  if (!entry) return "";
  const values = Array.isArray(substitutions)
    ? substitutions
    : substitutions === undefined
      ? []
      : [substitutions];
  let result = entry.message;
  for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
    const index = Number(placeholder.content.slice(1)) - 1;
    result = result.replaceAll(`$${name.toUpperCase()}$`, values[index] ?? "");
  }
  return result;
}

function visibleRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function createVisibleCandidate(): HTMLDivElement {
  const candidate = document.createElement("div");
  candidate.className = "caption-layer";
  candidate.setAttribute("aria-live", "polite");
  candidate.textContent = "Opening subtitle";
  candidate.getBoundingClientRect = () => visibleRect(120, 380, 400, 48);
  document.body.append(candidate);
  return candidate;
}

function wizardRoot(): ShadowRoot {
  const root = document.querySelector<HTMLElement>(
    '[data-noritrans-ui="subtitle-profile-wizard"]',
  )?.shadowRoot;
  if (!root) throw new Error("missing subtitle profile wizard");
  return root;
}

describe("subtitle profile wizard", () => {
  beforeEach(() => {
    vi.useRealTimers();
    getMessageMock.mockReset();
    getMessageMock.mockImplementation(
      (key: string, substitutions?: string | string[]) => {
        const values = Array.isArray(substitutions)
          ? substitutions
          : substitutions === undefined
            ? []
            : [substitutions];
        return values.length > 0 ? `${key}:${values.join("/")}` : key;
      },
    );
    document.documentElement.replaceChildren(
      document.createElement("head"),
      document.createElement("body"),
    );
  });

  it.each([
    ["English", en, "Step 1/2", "Step 2/2"],
    ["Simplified Chinese", zhCn, "步骤 1/2", "步骤 2/2"],
  ])(
    "renders exact %s step labels while sampling and after selection",
    async (_localeName, locale, firstStep, secondStep) => {
      vi.useFakeTimers();
      getMessageMock.mockImplementation(
        (key: string, substitutions?: string | string[]) =>
          localizedMessage(locale, key, substitutions),
      );
      createVisibleCandidate();
      const wizard = new SubtitleProfileWizard({
        onSave: vi.fn(),
        sampleDurationMs: 10,
      });

      wizard.start();
      const root = wizardRoot();
      expect(root.querySelector(".step")?.textContent).toBe(firstStep);

      await vi.advanceTimersByTimeAsync(10);
      expect(root.querySelector(".step")?.textContent).toBe(secondStep);
      expect(root.querySelector(".step")?.textContent).not.toMatch(
        /\$(?:CURRENT|TOTAL)\$/u,
      );

      root.querySelector<HTMLButtonElement>(".actions button")?.click();
      expect(root.querySelector(".step")?.textContent).toBe(firstStep);
      wizard.destroy();
    },
  );

  it("starts an accessible adaptive sampling panel", () => {
    const wizard = new SubtitleProfileWizard({
      onSave: vi.fn(),
      sampleDurationMs: 20,
    });
    wizard.start();
    const root = wizardRoot();
    const style = root.querySelector("style")?.textContent ?? "";

    expect(root.querySelector(".panel")?.getAttribute("role")).toBe("dialog");
    expect(root.querySelector(".status")?.getAttribute("aria-live")).toBe(
      "polite",
    );
    expect(root.querySelector(".status")?.textContent).toContain(
      "profileWizardSampling",
    );
    expect(root.querySelector("progress")?.getAttribute("aria-label")).toBe(
      "profileWizardSampling",
    );
    expect(style).toContain("min-height: 44px");
    expect(style).toContain("prefers-color-scheme: dark");
    expect(style).toContain("--primary-button: #23211e");
    expect(style).toContain("--primary-gradient: var(--primary-button)");
    expect(style).toContain("width: min(372px, calc(100vw - 24px))");
    expect(style).toContain("prefers-reduced-motion: no-preference");
    wizard.destroy();
  });

  it("restores focus to the control that opened the wizard", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open wizard";
    document.body.append(trigger);
    trigger.focus();
    const wizard = new SubtitleProfileWizard({ onSave: vi.fn() });

    wizard.start();
    expect(wizardRoot().activeElement?.classList.contains("close")).toBe(true);
    wizard.destroy();

    expect(document.activeElement).toBe(trigger);
  });

  it("restores a collapsed shadow control to its visible launcher", () => {
    const control = document.createElement("noritrans-floating-control");
    const root = control.attachShadow({ mode: "open" });
    const panel = document.createElement("div");
    const trigger = document.createElement("button");
    const launcher = document.createElement("button");
    launcher.className = "launcher";
    panel.append(trigger);
    root.append(panel, launcher);
    document.body.append(control);
    trigger.focus();
    panel.hidden = true;
    const wizard = new SubtitleProfileWizard({ onSave: vi.fn() });

    wizard.start();
    wizard.destroy();

    expect(root.activeElement).toBe(launcher);
  });

  it("temporarily hides the subtitle overlay so manual picking stays clickable", () => {
    const overlay = document.createElement("div");
    overlay.dataset.noritransUi = "subtitle-overlay";
    document.body.append(overlay);
    const wizard = new SubtitleProfileWizard({ onSave: vi.fn() });

    wizard.start();
    expect(overlay.hidden).toBe(true);
    wizard.destroy();

    expect(overlay.hidden).toBe(false);
  });

  it("samples safe visible caption candidates near a video and reports TextTrack", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    video.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
    Object.defineProperty(video, "textTracks", {
      configurable: true,
      value: [{ kind: "subtitles" }],
    });
    document.body.append(video);

    const candidate = document.createElement("div");
    candidate.id = "caption:unsafe";
    candidate.className = "caption-layer unsafe:class";
    candidate.setAttribute("aria-live", "polite");
    candidate.getBoundingClientRect = () => visibleRect(120, 360, 400, 44);
    document.body.append(candidate);

    const wizard = new SubtitleProfileWizard({
      onSave: vi.fn(),
      sampleDurationMs: 40,
    });
    wizard.start();
    candidate.textContent = "A newly visible subtitle line";
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(40);

    const root = wizardRoot();
    const radio = root.querySelector<HTMLInputElement>('input[type="radio"]');
    expect(radio?.value).toBe("div.caption-layer");
    expect(radio?.value).not.toContain("\\");
    expect(root.querySelector(".sample")?.textContent).toBe(
      "A newly visible subtitle line",
    );
    expect(root.querySelector(".step")?.textContent).toContain("2/2");
    expect(root.querySelector<HTMLElement>(".track-status")?.hidden).toBe(
      false,
    );
    expect(root.querySelector("progress")?.getAttribute("max")).toBe("100");
    wizard.destroy();
  });

  it("uses a visible changing child to validate a stable zero-size parent near video", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    video.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
    const player = document.createElement("div");
    player.className = "player-shell";
    const captionRegion = document.createElement("div");
    captionRegion.className = "player-overlay-line";
    captionRegion.getBoundingClientRect = () => visibleRect(0, 0, 0, 0);
    const text = document.createElement("span");
    text.getBoundingClientRect = () => visibleRect(150, 340, 320, 36);
    captionRegion.append(text);
    player.append(video, captionRegion);
    document.body.append(player);

    const wizard = new SubtitleProfileWizard({
      onSave: vi.fn(),
      sampleDurationMs: 30,
    });
    wizard.start();
    text.textContent = "A subtitle rendered by a changing child node";
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30);

    const root = wizardRoot();
    expect(
      Array.from(
        root.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ).map((radio) => radio.value),
    ).toContain("div.player-overlay-line");
    expect(root.querySelector(".sample")?.textContent).toContain(
      "A subtitle rendered by a changing child node",
    );
    wizard.destroy();
  });

  it("detects an existing generic subtitle region when it becomes visible", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    video.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
    const player = document.createElement("div");
    player.className = "media-shell";
    player.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
    const captionRegion = document.createElement("div");
    captionRegion.className = "spoken-line";
    captionRegion.style.display = "none";
    captionRegion.textContent = "Subtitle shown by a style toggle";
    captionRegion.getBoundingClientRect = () => visibleRect(150, 340, 320, 36);
    player.append(video, captionRegion);
    document.body.append(player);

    const wizard = new SubtitleProfileWizard({
      onSave: vi.fn(),
      sampleDurationMs: 30,
    });
    wizard.start();
    captionRegion.style.display = "block";
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30);

    const root = wizardRoot();
    expect(
      root.querySelector<HTMLInputElement>('input[type="radio"]')?.value,
    ).toBe("div.spoken-line");
    expect(root.querySelector(".sample")?.textContent).toBe(
      "Subtitle shown by a style toggle",
    );
    wizard.destroy();
  });

  it("does not accept generic changing text far away from video", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    video.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
    document.body.append(video);
    const unrelated = document.createElement("div");
    unrelated.className = "news-ticker";
    unrelated.getBoundingClientRect = () => visibleRect(800, 800, 200, 30);
    document.body.append(unrelated);

    const wizard = new SubtitleProfileWizard({
      onSave: vi.fn(),
      sampleDurationMs: 20,
    });
    wizard.start();
    unrelated.textContent = "This changing content is not a subtitle";
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    expect(wizardRoot().querySelector('input[type="radio"]')).toBeNull();
    wizard.destroy();
  });

  it("does not offer player settings, controls, or sidebars as caption regions", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    video.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
    const settingsMenu = document.createElement("div");
    settingsMenu.className = "txp-settings-menu";
    settingsMenu.innerHTML =
      '<div class="subtitle-option">字幕设置 清晰度 倍速</div><button>关闭</button>';
    settingsMenu.getBoundingClientRect = () => visibleRect(320, 150, 180, 210);
    const controlBar = document.createElement("div");
    controlBar.className = "txp-player-controls subtitle-controls";
    controlBar.textContent = "播放 音量 字幕 全屏";
    controlBar.getBoundingClientRect = () => visibleRect(80, 350, 480, 50);
    const sidebar = document.createElement("aside");
    sidebar.className = "video-sidebar caption-list";
    sidebar.textContent = "选集 推荐内容";
    sidebar.getBoundingClientRect = () => visibleRect(570, 80, 220, 320);
    document.body.append(video, settingsMenu, controlBar, sidebar);

    const wizard = new SubtitleProfileWizard({
      onSave: vi.fn(),
      sampleDurationMs: 20,
    });
    wizard.start();
    await vi.advanceTimersByTimeAsync(20);

    expect(wizardRoot().querySelector('input[type="radio"]')).toBeNull();
    wizard.destroy();
  });

  it("manually highlights and selects only a safe DOM subtitle candidate", () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
    document.body.append(video);
    const wizard = new SubtitleProfileWizard({ onSave: vi.fn() });
    wizard.start();
    const root = wizardRoot();
    const advanced = Array.from(root.querySelectorAll("button")).find(
      (button) => button.textContent === "profileWizardAdvancedPick",
    );
    advanced?.click();
    expect(root.querySelector(".status")?.textContent).toBe(
      "profileWizardPickHint",
    );

    const unrelated = document.createElement("div");
    unrelated.className = "manual-unrelated-line";
    unrelated.textContent = "A non-subtitle page region";
    unrelated.getBoundingClientRect = () => visibleRect(800, 700, 180, 30);
    document.body.append(unrelated);
    unrelated.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    expect(root.querySelector<HTMLElement>(".picker-highlight")?.hidden).toBe(
      true,
    );

    const candidate = document.createElement("div");
    candidate.className = "manual-spoken-line";
    candidate.textContent = "A manually selected subtitle line";
    candidate.getBoundingClientRect = () => visibleRect(140, 350, 360, 34);
    document.body.append(candidate);
    candidate.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));

    const highlight = root.querySelector<HTMLElement>(".picker-highlight");
    expect(highlight?.hidden).toBe(false);
    expect(highlight?.style.width).toBe("360px");
    const pageClick = vi.fn();
    candidate.addEventListener("click", pageClick);
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    candidate.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    candidate.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(pageClick).not.toHaveBeenCalled();
    expect(highlight?.hidden).toBe(true);
    expect(
      root.querySelector<HTMLInputElement>('input[type="radio"]')?.value,
    ).toBe("div.manual-spoken-line");
    expect(root.querySelector(".step")?.textContent).toContain("2/2");
    wizard.destroy();
  });

  it("cancels manual picking with Escape and restores page interaction", () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
    document.body.append(video);
    const wizard = new SubtitleProfileWizard({ onSave: vi.fn() });
    wizard.start();
    const root = wizardRoot();
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent === "profileWizardAdvancedPick")
      ?.click();

    const candidate = document.createElement("div");
    candidate.className = "escape-spoken-line";
    candidate.textContent = "Subtitle picker cancellation";
    candidate.getBoundingClientRect = () => visibleRect(140, 350, 360, 34);
    document.body.append(candidate);
    candidate.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    expect(root.querySelector<HTMLElement>(".picker-highlight")?.hidden).toBe(
      false,
    );

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(root.querySelector<HTMLElement>(".picker-highlight")?.hidden).toBe(
      true,
    );
    expect(root.querySelector(".status")?.textContent).toBe(
      "profileWizardNoCandidates",
    );

    const pageClick = vi.fn();
    candidate.addEventListener("click", pageClick);
    candidate.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(pageClick).toHaveBeenCalledOnce();
    expect(root.querySelector('input[type="radio"]')).toBeNull();
    wizard.destroy();
  });

  it("closes the wizard with one click while advanced picking is active", () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
    document.body.append(video);
    const wizard = new SubtitleProfileWizard({ onSave: vi.fn() });
    wizard.start();
    const root = wizardRoot();
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent === "profileWizardAdvancedPick")
      ?.click();

    root.querySelector<HTMLButtonElement>("button.close")?.click();

    expect(
      document.querySelector('[data-noritrans-ui="subtitle-profile-wizard"]'),
    ).toBeNull();
  });

  it("lets advanced picking select an unmarked subtitle element", () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
    const player = document.createElement("section");
    const candidate = document.createElement("div");
    candidate.textContent = "Subtitle without id or class";
    candidate.getBoundingClientRect = () => visibleRect(140, 350, 360, 34);
    player.append(video, candidate);
    document.body.append(player);
    const wizard = new SubtitleProfileWizard({ onSave: vi.fn() });
    wizard.start();
    const root = wizardRoot();
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent === "profileWizardAdvancedPick")
      ?.click();

    candidate.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    const selector = root.querySelector<HTMLInputElement>(
      'input[type="radio"]',
    )?.value;
    expect(selector).toContain("nth-of-type");
    expect(selector ? document.querySelector(selector) : null).toBe(candidate);
    expect(root.querySelector(".step")?.textContent).toContain("2/2");
    wizard.destroy();
  });

  it("uses a unique structural selector for a duplicated caption class", () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
    const first = document.createElement("div");
    const selected = document.createElement("div");
    first.className = selected.className = "duplicate-caption";
    first.textContent = "First duplicate";
    selected.textContent = "Selected duplicate";
    first.getBoundingClientRect = () => visibleRect(140, 330, 360, 34);
    selected.getBoundingClientRect = () => visibleRect(140, 370, 360, 34);
    document.body.append(video, first, selected);
    const wizard = new SubtitleProfileWizard({ onSave: vi.fn() });
    wizard.start();
    const root = wizardRoot();
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent === "profileWizardAdvancedPick")
      ?.click();

    selected.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    const selector = root.querySelector<HTMLInputElement>(
      'input[type="radio"]',
    )?.value;
    expect(selector).toContain("nth-of-type");
    expect(selector ? document.querySelectorAll(selector) : []).toHaveLength(1);
    expect(selector ? document.querySelector(selector) : null).toBe(selected);
    wizard.destroy();
  });

  it.each(["video", "canvas"] as const)(
    "blocks page interaction but refuses an embedded %s subtitle target",
    (tagName) => {
      const video = document.createElement("video");
      video.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
      document.body.append(video);
      const target =
        tagName === "video" ? video : document.createElement("canvas");
      target.className = "embedded-caption-surface";
      target.textContent = "Embedded subtitle fallback text";
      target.getBoundingClientRect = () => visibleRect(80, 80, 480, 320);
      if (tagName === "canvas") document.body.append(target);
      const wizard = new SubtitleProfileWizard({ onSave: vi.fn() });
      wizard.start();
      const root = wizardRoot();
      Array.from(root.querySelectorAll("button"))
        .find((button) => button.textContent === "profileWizardAdvancedPick")
        ?.click();

      const pageClick = vi.fn();
      target.addEventListener("click", pageClick);
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(click);

      expect(click.defaultPrevented).toBe(true);
      expect(pageClick).not.toHaveBeenCalled();
      expect(root.querySelector(".status")?.textContent).toBe(
        "profileWizardEmbeddedUnsupported",
      );
      expect(root.querySelector('input[type="radio"]')).toBeNull();
      target.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      expect(pageClick).toHaveBeenCalledOnce();
      wizard.destroy();
    },
  );

  it("saves the selected candidate as a constrained version 1 DOM profile", async () => {
    vi.useFakeTimers();
    createVisibleCandidate();
    const onSave = vi.fn(() => Promise.resolve());
    const wizard = new SubtitleProfileWizard({
      onSave,
      sampleDurationMs: 10,
    });
    wizard.start();
    await vi.advanceTimersByTimeAsync(10);

    const root = wizardRoot();
    root.querySelector<HTMLButtonElement>("button.primary")?.click();
    await Promise.resolve();

    expect(onSave).toHaveBeenCalledWith({
      id: "user-localhost",
      version: 1,
      name: "localhost",
      parser: "dom",
      priority: 1,
      match: { hostnameSuffixes: ["localhost"] },
      selectors: {
        video: "video",
        captions: ["div.caption-layer"],
        nativeCaptions: ["div.caption-layer"],
      },
      capture: {
        formats: [],
        allowedHostnameSuffixes: [],
        urlPatterns: [],
      },
    });
    expect(root.querySelector(".status")?.textContent).toBe(
      "profileWizardSaved",
    );
    wizard.destroy();
  });

  it("excludes extension and non-content nodes, resamples, and closes with Escape", async () => {
    vi.useFakeTimers();
    const extension = document.createElement("div");
    extension.dataset.noritransUi = "test";
    const nested = document.createElement("div");
    nested.className = "caption-extension";
    nested.textContent = "Extension status";
    nested.getBoundingClientRect = () => visibleRect(0, 0, 100, 30);
    extension.append(nested);
    document.body.append(extension);
    const input = document.createElement("input");
    input.className = "caption-input";
    input.value = "Not a subtitle";
    input.getBoundingClientRect = () => visibleRect(0, 0, 100, 30);
    document.body.append(input);

    const wizard = new SubtitleProfileWizard({
      onSave: vi.fn(),
      sampleDurationMs: 10,
    });
    wizard.start();
    await vi.advanceTimersByTimeAsync(10);
    let root = wizardRoot();
    expect(root.querySelector('input[type="radio"]')).toBeNull();
    expect(root.querySelector(".status")?.textContent).toBe(
      "profileWizardNoCandidates",
    );

    root.querySelector<HTMLButtonElement>(".actions button")?.click();
    expect(root.querySelector("progress")?.getAttribute("value")).toBe("0");
    root
      .querySelector(".panel")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    expect(
      document.querySelector('[data-noritrans-ui="subtitle-profile-wizard"]'),
    ).toBeNull();
    root = document.createElement("div").attachShadow({ mode: "open" });
    expect(root.childNodes).toHaveLength(0);
  });
});
