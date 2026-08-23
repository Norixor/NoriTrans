import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import {
  isExcludedDomCaptionElement,
  isWithinVideoCaptionArea,
  normalizedDomCaptionText,
} from "@/src/subtitles/dom-candidate";
import { browser } from "wxt/browser";

export interface SubtitleProfileWizardOptions {
  onSave(profile: SubtitleSiteProfile): Promise<void> | void;
  sampleDurationMs?: number;
}

interface ProfileCandidate {
  selector: string;
  sampleText: string;
  score: number;
}

interface EvaluatedCandidate {
  highlight: Element;
  profile: ProfileCandidate;
}

const DEFAULT_SAMPLE_DURATION_MS = 8_000;
const MAX_CANDIDATES = 12;
const MAX_SAMPLE_TEXT_LENGTH = 280;
const MAX_INITIAL_SCAN_ELEMENTS = 600;
const MAX_MUTATION_SCAN_ELEMENTS = 200;
const MAX_VISIBLE_DESCENDANTS = 40;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/u;
const CAPTION_HINT = /(caption|subtitle|texttrack)/iu;
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "BUTTON",
  "VIDEO",
  "CANVAS",
  "CODE",
  "PRE",
]);

function message(key: string, substitutions?: string[]): string {
  return browser.i18n.getMessage(key as never, substitutions) || key;
}

function stepMessage(current: 1 | 2): string {
  return message("profileWizardStep", [String(current), "2"]);
}

function safeEscapedIdentifier(value: string): string | null {
  if (!SAFE_IDENTIFIER.test(value)) return null;
  const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value;
  return SAFE_IDENTIFIER.test(escaped) && !escaped.includes("\\")
    ? escaped
    : null;
}

function normalizedHostnameId(hostname: string): string {
  const normalized = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 59)
    .replace(/-+$/u, "");
  return `user-${normalized || "site"}`;
}

function normalizedText(element: Element): string {
  return (element.textContent ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_SAMPLE_TEXT_LENGTH);
}

function isExtensionUi(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (
      current.tagName.startsWith("NORIXOR-") ||
      current.hasAttribute("data-norixortrans-ui") ||
      current.hasAttribute("data-norixor-ui") ||
      current.hasAttribute("data-norixor-translated")
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isVisibleCandidate(element: Element): boolean {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (
      SKIP_TAGS.has(current.tagName) ||
      isExtensionUi(current) ||
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden") === "true" ||
      (current instanceof HTMLElement && current.isContentEditable)
    ) {
      return false;
    }
    const style = getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    current = current.parentElement;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function hasCaptionSignal(element: Element): boolean {
  const ariaLive = element.getAttribute("aria-live");
  return (
    ariaLive === "polite" ||
    ariaLive === "assertive" ||
    CAPTION_HINT.test(element.id) ||
    Array.from(element.classList).some((name) => CAPTION_HINT.test(name))
  );
}

function structuralSelector(element: Element): string | null {
  const parts: string[] = [];
  let current: Element | null = element;
  let anchored = false;
  for (let depth = 0; current && depth < 10; depth += 1) {
    if (current === document.documentElement) break;
    if (current === document.body) {
      parts.unshift("body");
      anchored = true;
      break;
    }
    const tag = current.tagName.toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/u.test(tag)) return null;
    const id = safeEscapedIdentifier(current.id);
    if (id) {
      const idSelector = `#${id}`;
      try {
        if (document.querySelectorAll(idSelector).length === 1) {
          parts.unshift(idSelector);
          anchored = true;
          break;
        }
      } catch {
        return null;
      }
    }
    const currentTag = current.tagName;
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) return null;
    const siblings: Element[] = Array.from(parent.children).filter(
      (sibling) => sibling.tagName === currentTag,
    );
    parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
    current = parent;
  }
  const selector = parts.join(" > ");
  if (!anchored || !selector) return null;
  try {
    return document.querySelectorAll(selector).length === 1 ? selector : null;
  } catch {
    return null;
  }
}

function stableSelector(
  element: Element,
  allowStructural = false,
): string | null {
  const id = safeEscapedIdentifier(element.id);
  if (id) {
    const selector = `#${id}`;
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch {
      return null;
    }
  }

  const tag = element.tagName.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/u.test(tag)) return null;
  const classes = Array.from(element.classList)
    .map(safeEscapedIdentifier)
    .filter((value): value is string => value !== null)
    .slice(0, 2);
  if (classes.length === 0)
    return allowStructural ? structuralSelector(element) : null;
  const classSelector = `${tag}${classes.map((name) => `.${name}`).join("")}`;
  if (!allowStructural) return classSelector;
  try {
    return document.querySelectorAll(classSelector).length === 1
      ? classSelector
      : structuralSelector(element);
  } catch {
    return null;
  }
}

function rectDistance(left: DOMRect, right: DOMRect): number {
  const horizontal = Math.max(
    0,
    left.left - right.right,
    right.left - left.right,
  );
  const vertical = Math.max(
    0,
    left.top - right.bottom,
    right.top - left.bottom,
  );
  return Math.hypot(horizontal, vertical);
}

function deepestActiveElement(): HTMLElement | undefined {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active instanceof HTMLElement ? active : undefined;
}

const STYLE = `
  :host {
    all: initial;
    display: block !important;
    position: fixed !important;
    z-index: 2147483647 !important;
    pointer-events: auto !important;
    right: max(16px, env(safe-area-inset-right));
    bottom: max(16px, env(safe-area-inset-bottom));
    max-width: none !important;
    max-height: none !important;
    overflow: visible !important;
    contain: none !important;
    writing-mode: horizontal-tb !important;
    text-orientation: mixed !important;
    color-scheme: light dark;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --bg: #fbf8f2;
    --surface: #f5f0e7;
    --border: #ded7ca;
    --text: #211f1b;
    --muted: #746f66;
    --primary: #b87912;
    --primary-hover: #955d08;
    --primary-button: #23211e;
    --primary-button-hover: #11100f;
    --primary-gradient: var(--primary-button);
    --danger: #cf222e;
    --focus: #c58a26;
  }
  :host([data-fullscreen-hidden="true"]) { display: none !important; }
  * { box-sizing: border-box; }
  .panel {
    width: min(372px, calc(100vw - 24px));
    max-height: min(640px, calc(100vh - 24px));
    overflow: auto;
    overscroll-behavior: contain;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    box-shadow: 0 12px 32px rgb(31 35 40 / 20%);
  }
  .header { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 12px; }
  .title { font-size: 14px; font-weight: 750; line-height: 1.4; }
  .step { color: var(--muted); font-size: 12px; font-weight: 650; }
  .status { min-height: 22px; margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
  .track-status { margin: 6px 0 0; color: var(--primary); font-size: 12px; font-weight: 650; line-height: 1.4; }
  .track-status[hidden] { display: none; }
  progress { width: 100%; height: 8px; margin-top: 8px; accent-color: var(--primary); }
  .candidate-heading { margin: 12px 0 6px; font-size: 12px; font-weight: 700; }
  .candidates { display: grid; gap: 6px; max-height: 280px; overflow: auto; overscroll-behavior: contain; }
  .candidate {
    display: grid;
    min-height: 58px;
    grid-template-columns: 20px minmax(0, 1fr);
    align-items: start;
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    cursor: pointer;
  }
  .candidate:hover { border-color: var(--primary); }
  .candidate input { width: 18px; height: 18px; margin: 3px 0 0; accent-color: var(--primary); cursor: pointer; }
  .candidate-copy { min-width: 0; }
  .selector { display: block; overflow: hidden; color: var(--text); font: 650 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
  .sample { display: -webkit-box; overflow: hidden; margin-top: 3px; color: var(--muted); font-size: 12px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
  .advanced { grid-column: 1 / -1; }
  .picker-highlight {
    position: fixed;
    z-index: 2147483646;
    border: 2px solid var(--primary);
    border-radius: 3px;
    background: rgb(184 121 18 / 12%);
    box-shadow: 0 0 0 2px rgb(251 248 242 / 78%);
    pointer-events: none;
  }
  .picker-highlight[hidden] { display: none; }
  button {
    min-width: 44px;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font: 700 12px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  button.primary { border-color: var(--primary-button); background: var(--primary-gradient); color: #fffdf8; }
  button:hover { border-color: var(--primary); }
  button.primary:hover { background: var(--primary-button-hover); }
  button.close { width: 44px; padding: 0; color: var(--muted); }
  button.close { display: grid; place-items: center; }
  button.close::before {
    width: 18px;
    height: 18px;
    background: currentcolor;
    content: "";
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 6 12 12M18 6 6 18' stroke='black' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") center / contain no-repeat;
  }
  button:focus-visible, input:focus-visible, .candidate:has(input:focus-visible) {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
  }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
  @media (prefers-color-scheme: dark) {
    :host {
      --bg: #211f1b;
      --surface: #2b2822;
      --border: #474138;
      --text: #f6f1e7;
      --muted: #b8b0a3;
      --primary: #d39a37;
      --primary-hover: #e1ad52;
      --primary-button: #f0e9de;
      --primary-button-hover: #ffffff;
      --primary-gradient: var(--primary-button);
      --danger: #ff7b72;
      --focus: #d8a750;
    }
    button.primary { color: #211f1b; }
    .panel { box-shadow: 0 12px 32px rgb(1 4 9 / 48%); }
  }
  @media (max-width: 420px) {
    :host { right: 12px; bottom: 12px; }
    .panel { width: calc(100vw - 24px); max-height: calc(100vh - 24px); }
  }
  @media (prefers-reduced-motion: no-preference) {
    button, .candidate { transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease; }
  }
`;

export class SubtitleProfileWizard {
  private readonly host = document.createElement(
    "norixor-subtitle-profile-wizard",
  );
  private readonly panel = document.createElement("section");
  private readonly step = document.createElement("div");
  private readonly status = document.createElement("p");
  private readonly trackStatus = document.createElement("p");
  private readonly progress = document.createElement("progress");
  private readonly candidateList = document.createElement("div");
  private readonly resampleButton = document.createElement("button");
  private readonly advancedPickButton = document.createElement("button");
  private readonly saveButton = document.createElement("button");
  private readonly closeButton = document.createElement("button");
  private readonly pickerHighlight = document.createElement("div");
  private readonly candidates = new Map<string, ProfileCandidate>();
  private readonly sampleDurationMs: number;
  private observer: MutationObserver | undefined;
  private sampleTimer: number | undefined;
  private progressTimer: number | undefined;
  private samplingStartedAt = 0;
  private selectedSelector: string | undefined;
  private sampling = false;
  private picking = false;
  private saving = false;
  private destroyed = false;
  private hasTextTrack = false;
  private pickerHoverTarget: Element | undefined;
  private returnFocus: HTMLElement | undefined;
  private readonly suppressedOverlays = new Map<
    HTMLElement,
    HTMLElement["hidden"]
  >();

  constructor(private readonly options: SubtitleProfileWizardOptions) {
    this.sampleDurationMs = Math.max(
      1,
      options.sampleDurationMs ?? DEFAULT_SAMPLE_DURATION_MS,
    );
    this.host.dataset.norixortransUi = "subtitle-profile-wizard";
    const root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;

    this.panel.className = "panel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "false");
    this.panel.setAttribute("aria-label", message("profileWizard"));

    const header = document.createElement("div");
    header.className = "header";
    const heading = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = message("profileWizard");
    this.step.className = "step";
    this.step.textContent = stepMessage(1);
    heading.append(title, this.step);
    this.closeButton.type = "button";
    this.closeButton.className = "close";
    this.closeButton.setAttribute("aria-label", message("profileWizardClose"));
    this.closeButton.title = message("profileWizardClose");
    header.append(heading, this.closeButton);

    this.status.className = "status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.trackStatus.className = "track-status";
    this.trackStatus.textContent = message("profileWizardTextTrackFound");
    this.trackStatus.hidden = true;
    this.progress.max = 100;
    this.progress.value = 0;
    this.progress.setAttribute("aria-label", message("profileWizardSampling"));

    const candidateHeading = document.createElement("div");
    candidateHeading.className = "candidate-heading";
    candidateHeading.textContent = message("profileWizardCandidate");
    this.candidateList.className = "candidates";

    const actions = document.createElement("div");
    actions.className = "actions";
    this.resampleButton.type = "button";
    this.resampleButton.textContent = message("profileWizardResample");
    this.advancedPickButton.type = "button";
    this.advancedPickButton.className = "advanced";
    this.advancedPickButton.textContent = message("profileWizardAdvancedPick");
    this.saveButton.type = "button";
    this.saveButton.className = "primary";
    this.saveButton.textContent = message("profileWizardSave");
    actions.append(
      this.resampleButton,
      this.saveButton,
      this.advancedPickButton,
    );

    this.panel.append(
      header,
      this.status,
      this.trackStatus,
      this.progress,
      candidateHeading,
      this.candidateList,
      actions,
    );
    this.pickerHighlight.className = "picker-highlight";
    this.pickerHighlight.hidden = true;
    root.append(style, this.panel, this.pickerHighlight);

    this.resampleButton.addEventListener("click", this.beginSampling);
    this.advancedPickButton.addEventListener("click", this.beginAdvancedPick);
    this.saveButton.addEventListener("click", this.handleSave);
    this.closeButton.addEventListener("click", this.destroy);
    this.panel.addEventListener("keydown", this.handleKeydown);
    document.addEventListener("fullscreenchange", this.handleFullscreenChange);
  }

  start(): void {
    if (this.destroyed) return;
    this.returnFocus = deepestActiveElement();
    for (const overlay of document.querySelectorAll<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    )) {
      this.suppressedOverlays.set(overlay, overlay.hidden);
      overlay.hidden = true;
    }
    if (!this.host.isConnected) document.documentElement.append(this.host);
    this.handleFullscreenChange();
    this.beginSampling();
    this.closeButton.focus();
  }

  destroy = (): void => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopSampling();
    this.stopAdvancedPick();
    this.resampleButton.removeEventListener("click", this.beginSampling);
    this.advancedPickButton.removeEventListener(
      "click",
      this.beginAdvancedPick,
    );
    this.saveButton.removeEventListener("click", this.handleSave);
    this.closeButton.removeEventListener("click", this.destroy);
    this.panel.removeEventListener("keydown", this.handleKeydown);
    document.removeEventListener(
      "fullscreenchange",
      this.handleFullscreenChange,
    );
    this.host.remove();
    for (const [overlay, wasHidden] of this.suppressedOverlays) {
      if (overlay.isConnected) overlay.hidden = wasHidden;
    }
    this.suppressedOverlays.clear();
    if (this.returnFocus?.isConnected) {
      if (this.returnFocus.closest("[hidden]")) {
        const root = this.returnFocus.getRootNode();
        const launcher =
          root instanceof ShadowRoot
            ? root.querySelector<HTMLElement>(".launcher")
            : null;
        launcher?.focus();
      } else {
        this.returnFocus.focus();
      }
    }
    this.returnFocus = undefined;
  };

  private readonly handleFullscreenChange = (): void => {
    this.host.dataset.fullscreenHidden = String(
      document.fullscreenElement !== null,
    );
  };

  private readonly beginSampling = (): void => {
    if (this.destroyed || this.saving) return;
    this.stopAdvancedPick();
    this.stopSampling();
    this.candidates.clear();
    this.selectedSelector = undefined;
    this.sampling = true;
    this.step.textContent = stepMessage(1);
    this.samplingStartedAt = performance.now();
    this.progress.value = 0;
    this.status.textContent = `${message("profileWizardSampling")} ${message("profileWizardPlayHint")}`;
    this.detectTextTracks();
    this.renderCandidates();
    this.scanInitialCandidates();

    this.observer = new MutationObserver(this.collectMutations);
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "aria-live", "class", "hidden", "style"],
    });
    this.sampleTimer = window.setTimeout(
      this.finishSampling,
      this.sampleDurationMs,
    );
    const progressInterval = Math.min(
      250,
      Math.max(16, Math.floor(this.sampleDurationMs / 20)),
    );
    this.progressTimer = window.setInterval(
      this.updateProgress,
      progressInterval,
    );
    this.syncActions();
  };

  private stopSampling(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.sampleTimer !== undefined) window.clearTimeout(this.sampleTimer);
    if (this.progressTimer !== undefined)
      window.clearInterval(this.progressTimer);
    this.sampleTimer = undefined;
    this.progressTimer = undefined;
    this.sampling = false;
  }

  private readonly beginAdvancedPick = (): void => {
    if (this.destroyed || this.saving || this.picking) return;
    this.stopSampling();
    this.picking = true;
    this.pickerHoverTarget = undefined;
    this.pickerHighlight.hidden = true;
    this.step.textContent = stepMessage(1);
    this.status.textContent = message("profileWizardPickHint");
    document.addEventListener("pointermove", this.handlePickPointerMove, true);
    document.addEventListener("pointerdown", this.handlePickPointerDown, true);
    document.addEventListener("click", this.handlePickClick, true);
    document.addEventListener("keydown", this.handlePickKeydown, true);
    this.syncActions();
  };

  private stopAdvancedPick(): void {
    if (this.picking) {
      document.removeEventListener(
        "pointermove",
        this.handlePickPointerMove,
        true,
      );
      document.removeEventListener(
        "pointerdown",
        this.handlePickPointerDown,
        true,
      );
      document.removeEventListener("click", this.handlePickClick, true);
      document.removeEventListener("keydown", this.handlePickKeydown, true);
    }
    this.picking = false;
    this.pickerHoverTarget = undefined;
    this.pickerHighlight.hidden = true;
    this.syncActions();
  }

  private readonly handlePickPointerMove = (event: Event): void => {
    if (!this.picking) return;
    const target = event.target;
    if (!(target instanceof Element) || target === this.pickerHoverTarget)
      return;
    this.pickerHoverTarget = target;
    if (this.isEmbeddedMediaTarget(target)) {
      this.pickerHighlight.hidden = true;
      return;
    }
    const evaluated = this.evaluateCandidate(target, target, true);
    if (!evaluated) {
      this.pickerHighlight.hidden = true;
      return;
    }
    const rect = evaluated.highlight.getBoundingClientRect();
    Object.assign(this.pickerHighlight.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    this.pickerHighlight.hidden = false;
  };

  private readonly handlePickPointerDown = (event: Event): void => {
    if (!this.picking) return;
    if (event.composedPath().includes(this.host)) return;
    event.stopImmediatePropagation();
  };

  private readonly handlePickClick = (event: Event): void => {
    if (!this.picking) return;
    if (event.composedPath().includes(this.host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target;
    try {
      if (!(target instanceof Element)) {
        this.status.textContent = message("profileWizardNoCandidates");
        return;
      }
      if (this.isEmbeddedMediaTarget(target)) {
        this.status.textContent = message("profileWizardEmbeddedUnsupported");
        return;
      }
      const evaluated = this.evaluateCandidate(target, target, true);
      if (!evaluated) {
        this.status.textContent = message("profileWizardNoCandidates");
        return;
      }
      this.candidates.set(evaluated.profile.selector, {
        ...evaluated.profile,
        score: evaluated.profile.score + 1_000,
      });
      this.selectedSelector = evaluated.profile.selector;
      this.trimCandidates();
      this.progress.value = 100;
      this.step.textContent = stepMessage(2);
      this.status.textContent = message("profileWizardCandidate");
      this.renderCandidates();
    } finally {
      this.stopAdvancedPick();
    }
  };

  private readonly handlePickKeydown = (event: KeyboardEvent): void => {
    if (!this.picking || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.stopAdvancedPick();
    this.status.textContent =
      this.candidates.size > 0
        ? message("profileWizardCandidate")
        : message("profileWizardNoCandidates");
    if (this.candidates.size > 0) this.step.textContent = stepMessage(2);
    this.syncActions();
  };

  private isEmbeddedMediaTarget(element: Element): boolean {
    return element.closest("video,canvas") !== null;
  }

  private readonly finishSampling = (): void => {
    this.stopSampling();
    this.progress.value = 100;
    this.status.textContent =
      this.candidates.size === 0
        ? message("profileWizardNoCandidates")
        : message("profileWizardCandidate");
    if (this.candidates.size > 0) this.step.textContent = stepMessage(2);
    this.syncActions();
  };

  private readonly updateProgress = (): void => {
    const elapsed = performance.now() - this.samplingStartedAt;
    this.progress.value = Math.min(
      99,
      Math.round((elapsed / this.sampleDurationMs) * 100),
    );
  };

  private detectTextTracks(): void {
    this.hasTextTrack = Array.from(document.querySelectorAll("video")).some(
      (video) => video.textTracks.length > 0 || video.querySelector("track"),
    );
    this.trackStatus.hidden = !this.hasTextTrack;
  }

  private scanInitialCandidates(): void {
    const selector = [
      '[aria-live="polite"]',
      '[aria-live="assertive"]',
      '[class*="caption" i]',
      '[class*="subtitle" i]',
      '[class*="texttrack" i]',
      '[id*="caption" i]',
      '[id*="subtitle" i]',
      '[id*="texttrack" i]',
    ].join(",");
    const elements = new Set<Element>();
    let remaining = MAX_INITIAL_SCAN_ELEMENTS;
    const collect = (element: Element): void => {
      if (remaining === 0 || elements.has(element)) return;
      elements.add(element);
      remaining -= 1;
    };
    for (const element of document.querySelectorAll(selector)) {
      collect(element);
      if (remaining <= MAX_INITIAL_SCAN_ELEMENTS / 2) break;
    }
    for (const video of document.querySelectorAll("video")) {
      let container = video.parentElement;
      for (
        let depth = 0;
        container &&
        container !== document.body &&
        container !== document.documentElement &&
        depth < 4 &&
        remaining > 0;
        depth += 1
      ) {
        if (container.id || container.classList.length > 0) collect(container);
        const walker = document.createTreeWalker(
          container,
          NodeFilter.SHOW_ELEMENT,
        );
        let node = walker.nextNode();
        while (node && remaining > 0) {
          const element = node as Element;
          if (
            element.id ||
            element.classList.length > 0 ||
            element.hasAttribute("aria-live")
          ) {
            collect(element);
          }
          node = walker.nextNode();
        }
        container = container.parentElement;
      }
    }
    for (const element of elements) {
      this.considerElement(element, element);
    }
  }

  private readonly collectMutations = (
    mutations: readonly MutationRecord[],
  ): void => {
    const changedElements = new Map<Element, Element>();
    let remaining = MAX_MUTATION_SCAN_ELEMENTS;
    const collect = (element: Element, evidence: Element): void => {
      if (remaining === 0 || changedElements.has(element)) return;
      changedElements.set(element, evidence);
      remaining -= 1;
    };
    for (const mutation of mutations) {
      if (mutation.target instanceof Text) {
        if (mutation.target.parentElement) {
          collect(mutation.target.parentElement, mutation.target.parentElement);
        }
        continue;
      }
      if (mutation.target instanceof Element)
        collect(mutation.target, mutation.target);
      for (const node of mutation.addedNodes) {
        if (node instanceof Text && node.parentElement) {
          collect(node.parentElement, node.parentElement);
        } else if (node instanceof Element) {
          collect(node, node);
          const walker = document.createTreeWalker(
            node,
            NodeFilter.SHOW_ELEMENT,
          );
          let child = walker.nextNode();
          while (child && remaining > 0) {
            const element = child as Element;
            collect(element, element);
            child = walker.nextNode();
          }
        }
        if (remaining === 0) break;
      }
      if (remaining === 0) break;
    }
    for (const [element, evidence] of changedElements) {
      this.considerElement(element, evidence);
    }
  };

  private considerElement(element: Element, evidence: Element): void {
    const evaluated = this.evaluateCandidate(element, evidence);
    if (!evaluated) return;
    const { profile } = evaluated;
    const previous = this.candidates.get(profile.selector);
    this.candidates.set(profile.selector, {
      ...profile,
      score: Math.max(previous?.score ?? 0, profile.score),
    });
    this.trimCandidates();
    if (!this.selectedSelector || !this.candidates.has(this.selectedSelector))
      this.selectedSelector = this.sortedCandidates()[0]?.selector;
    this.renderCandidates();
  }

  private evaluateCandidate(
    element: Element,
    evidence: Element,
    allowStructuralSelector = false,
  ): EvaluatedCandidate | null {
    const candidate = this.findCandidateAnchor(
      element,
      allowStructuralSelector,
    );
    if (!candidate) return null;
    if (isExcludedDomCaptionElement(candidate)) return null;
    const visibleEvidence = this.findVisibleEvidence(evidence, candidate);
    if (!visibleEvidence) return null;
    const sampleText = normalizedDomCaptionText(
      candidate.textContent ?? "",
    ).slice(0, MAX_SAMPLE_TEXT_LENGTH);
    if (!sampleText) return null;
    const selector = stableSelector(candidate, allowStructuralSelector);
    if (!selector) return null;
    const captionSignal = hasCaptionSignal(candidate);
    if (candidate.querySelector("video,canvas")) return null;
    const visibleVideos = Array.from(document.querySelectorAll("video")).filter(
      (video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
    );
    if (
      visibleVideos.length > 0 &&
      !visibleVideos.some((video) =>
        isWithinVideoCaptionArea(visibleEvidence, video),
      )
    ) {
      return null;
    }
    const proximity = Math.max(
      this.videoProximity(candidate),
      this.videoProximity(visibleEvidence),
    );
    if (!captionSignal && proximity === 0) return null;
    const score =
      (selector.startsWith("#") ? 200 : 0) +
      (captionSignal ? 120 : 0) +
      proximity +
      (this.hasTextTrack ? 20 : 0);
    return {
      highlight: visibleEvidence,
      profile: { selector, sampleText, score },
    };
  }

  private findCandidateAnchor(
    element: Element,
    allowStructuralSelector = false,
  ): Element | null {
    let current: Element | null = element;
    let fallback: Element | null = null;
    for (let depth = 0; current && depth < 6; depth += 1) {
      if (current === document.body || current === document.documentElement)
        break;
      if (SKIP_TAGS.has(current.tagName) || isExtensionUi(current)) return null;
      if (
        hasCaptionSignal(current) &&
        stableSelector(current, allowStructuralSelector)
      )
        return current;
      if (!fallback && stableSelector(current, allowStructuralSelector))
        fallback = current;
      current = current.parentElement;
    }
    return fallback;
  }

  private findVisibleEvidence(
    element: Element,
    candidate: Element,
  ): Element | null {
    let current: Element | null = element;
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (normalizedText(current).length >= 2 && isVisibleCandidate(current))
        return current;
      if (current === candidate) break;
      current = current.parentElement;
    }
    let inspected = 0;
    const walker = document.createTreeWalker(
      candidate,
      NodeFilter.SHOW_ELEMENT,
    );
    let child = walker.nextNode();
    while (child) {
      inspected += 1;
      const element = child as Element;
      if (normalizedText(element).length >= 2 && isVisibleCandidate(element))
        return element;
      if (inspected >= MAX_VISIBLE_DESCENDANTS) break;
      child = walker.nextNode();
    }
    return null;
  }

  private videoProximity(element: Element): number {
    const candidateRect = element.getBoundingClientRect();
    let minimumDistance = Number.POSITIVE_INFINITY;
    for (const video of document.querySelectorAll("video")) {
      const videoRect = video.getBoundingClientRect();
      if (videoRect.width <= 0 || videoRect.height <= 0) continue;
      minimumDistance = Math.min(
        minimumDistance,
        rectDistance(candidateRect, videoRect),
      );
    }
    if (minimumDistance === 0) return 100;
    return minimumDistance <= 160 ? 60 : 0;
  }

  private trimCandidates(): void {
    const sorted = this.sortedCandidates();
    for (const candidate of sorted.slice(MAX_CANDIDATES))
      this.candidates.delete(candidate.selector);
  }

  private sortedCandidates(): ProfileCandidate[] {
    return [...this.candidates.values()].sort(
      (left, right) =>
        right.score - left.score || left.selector.localeCompare(right.selector),
    );
  }

  private renderCandidates(): void {
    this.candidateList.replaceChildren();
    for (const candidate of this.sortedCandidates()) {
      const label = document.createElement("label");
      label.className = "candidate";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "norixortrans-profile-candidate";
      radio.value = candidate.selector;
      radio.checked = candidate.selector === this.selectedSelector;
      radio.addEventListener("change", () => {
        this.selectedSelector = radio.value;
        this.syncActions();
      });
      const copy = document.createElement("span");
      copy.className = "candidate-copy";
      const selector = document.createElement("span");
      selector.className = "selector";
      selector.textContent = candidate.selector;
      const sample = document.createElement("span");
      sample.className = "sample";
      sample.textContent = candidate.sampleText;
      copy.append(selector, sample);
      label.append(radio, copy);
      this.candidateList.append(label);
    }
    this.syncActions();
  }

  private syncActions(): void {
    this.resampleButton.disabled = this.saving;
    this.advancedPickButton.disabled = this.saving || this.picking;
    this.saveButton.disabled =
      this.saving || this.sampling || this.picking || !this.selectedSelector;
  }

  private readonly save = async (): Promise<void> => {
    const selector = this.selectedSelector;
    if (!selector || this.sampling || this.saving) return;
    this.saving = true;
    this.syncActions();
    const hostname = location.hostname.toLowerCase();
    const profile: SubtitleSiteProfile = {
      id: normalizedHostnameId(hostname),
      version: 1,
      name: hostname,
      parser: "dom",
      priority: 1,
      match: { hostnameSuffixes: [hostname] },
      selectors: {
        video: "video",
        captions: [selector],
        nativeCaptions: [selector],
      },
      capture: {
        formats: [],
        allowedHostnameSuffixes: [],
        urlPatterns: [],
      },
    };
    try {
      await this.options.onSave(profile);
      this.status.textContent = message("profileWizardSaved");
    } catch {
      this.status.textContent = message("profileWizardSaveFailed");
    } finally {
      this.saving = false;
      this.syncActions();
    }
  };

  private readonly handleSave = (): void => {
    void this.save();
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.destroy();
  };
}
