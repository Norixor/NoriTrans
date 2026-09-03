import type { TranslationResponse } from "@/src/messaging/protocol";
import { localizeRuntimeError } from "@/src/shared/runtime-errors";
import { message } from "@/src/shared/i18n";
import { runtimeId } from "@/src/shared/runtime-id";
import type { ContentSettings } from "@/src/shared/settings";
import { ChromeLocalProvider } from "@/src/translation/providers/chrome-local";
import { cleanTranslatedText } from "@/src/translation/output";
import { subscribeTranslationProgress } from "@/src/translation/progress-channel";
import type {
  TranslationProgressCallback,
  TranslationRequest,
  TranslationResult,
} from "@/src/translation/types";
import { browser } from "wxt/browser";

const MAX_SELECTION_CHARACTERS = 5_000;
const VIEWPORT_PADDING = 8;
const POPOVER_GAP = 8;
const SELECTION_SEGMENT_ID = "selection";

const EXCLUDED_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  "[data-noritrans-ui]",
  "noritrans-translation",
].join(",");

const STYLE = `
  :host {
    all: initial;
    display: block !important;
    position: fixed;
    z-index: 2147483647;
    left: 0;
    top: 0;
    color-scheme: light dark;
    max-width: none !important;
    max-height: none !important;
    overflow: visible !important;
    contain: none !important;
    writing-mode: horizontal-tb !important;
    text-orientation: mixed !important;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --nt-selection-bg: #fbf8f2;
    --nt-selection-muted-bg: #f5f0e7;
    --nt-selection-text: #211f1b;
    --nt-selection-muted: #746f66;
    --nt-selection-border: #ded7ca;
    --nt-selection-accent: #b87912;
    --nt-selection-accent-hover: #955d08;
    --nt-selection-danger: #cf222e;
    --nt-selection-focus: #c58a26;
    --nt-selection-shadow: 0 12px 30px rgba(52, 45, 34, 0.2);
  }
  :host([hidden]) { display: none !important; }
  @media (prefers-color-scheme: dark) {
    :host {
      --nt-selection-bg: #211f1b;
      --nt-selection-muted-bg: #2b2822;
      --nt-selection-text: #f6f1e7;
      --nt-selection-muted: #b8b0a3;
      --nt-selection-border: #474138;
      --nt-selection-accent: #d39a37;
      --nt-selection-accent-hover: #e1ad52;
      --nt-selection-danger: #ff7b72;
      --nt-selection-focus: #d8a750;
      --nt-selection-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
    }
  }
  * { box-sizing: border-box; }
  button {
    font: inherit;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  button:focus-visible {
    outline: 3px solid var(--nt-selection-focus);
    outline-offset: 2px;
  }
  .translate-trigger {
    display: grid;
    width: 44px;
    height: 44px;
    place-items: center;
    padding: 0;
    border: 1px solid var(--nt-selection-border);
    border-radius: 6px;
    background: var(--nt-selection-bg);
    color: var(--nt-selection-accent);
    box-shadow: var(--nt-selection-shadow);
  }
  .translate-trigger:hover { color: var(--nt-selection-accent-hover); }
  .translate-trigger svg { width: 22px; height: 22px; }
  .card {
    width: min(336px, calc(100vw - 16px));
    max-height: min(440px, calc(100vh - 16px));
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--nt-selection-border);
    border-radius: 6px;
    background: var(--nt-selection-bg);
    color: var(--nt-selection-text);
    box-shadow: var(--nt-selection-shadow);
  }
  .card[hidden],
  .translate-trigger[hidden],
  .loading[hidden],
  .translated-text[hidden],
  .error[hidden],
  .copy-button[hidden],
  [hidden] { display: none !important; }
  .card-header,
  .card-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
  }
  .card-header { border-bottom: 1px solid var(--nt-selection-border); }
  .card-header strong { font-size: 13px; line-height: 1.35; }
  .icon-button,
  .action-button {
    min-width: 44px;
    min-height: 44px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--nt-selection-muted);
  }
  .icon-button {
    display: grid;
    flex: 0 0 44px;
    place-items: center;
    padding: 0;
  }
  .icon-button:hover,
  .action-button:hover { background: var(--nt-selection-muted-bg); color: var(--nt-selection-text); }
  .icon-button svg { width: 18px; height: 18px; }
  .content { padding: 12px; }
  .content-section + .content-section {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--nt-selection-border);
  }
  .content-label {
    display: block;
    margin-bottom: 5px;
    color: var(--nt-selection-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .content p {
    margin: 0;
    color: var(--nt-selection-text);
    font-size: 14px;
    line-height: 1.55;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .loading {
    display: flex;
    min-height: 44px;
    align-items: center;
    gap: 10px;
    color: var(--nt-selection-muted);
    font-size: 13px;
  }
  .spinner {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
    border: 2px solid var(--nt-selection-border);
    border-top-color: var(--nt-selection-accent);
    border-radius: 50%;
  }
  .error { color: var(--nt-selection-danger); }
  .error p { color: inherit; }
  .retry-button {
    margin-top: 8px;
    padding: 7px 12px;
    border: 1px solid var(--nt-selection-border);
    border-radius: 6px;
    background: var(--nt-selection-bg);
    color: var(--nt-selection-text);
    font-weight: 650;
  }
  .retry-button:hover { background: var(--nt-selection-muted-bg); }
  .card-actions {
    justify-content: flex-end;
    border-top: 1px solid var(--nt-selection-border);
  }
  .copy-status {
    min-width: 0;
    margin-right: auto;
    color: var(--nt-selection-muted);
    font-size: 12px;
  }
  .action-button {
    padding: 8px 12px;
    border-color: var(--nt-selection-border);
    color: var(--nt-selection-text);
    font-weight: 650;
  }
  .action-button:disabled { cursor: not-allowed; opacity: 0.55; }
  @media (prefers-reduced-motion: no-preference) {
    .translate-trigger,
    .icon-button,
    .action-button,
    .retry-button { transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease; }
    .spinner { animation: nt-selection-spin 700ms linear infinite; }
  }
  @keyframes nt-selection-spin { to { transform: rotate(360deg); } }
  @media (forced-colors: active) {
    :host { --nt-selection-shadow: none; }
    .translate-trigger,
    .card,
    .icon-button,
    .action-button,
    .retry-button { forced-color-adjust: auto; }
    .spinner { border-color: GrayText; border-top-color: Highlight; }
  }
`;

interface SelectionSnapshot {
  text: string;
  rect: DOMRect;
}

export interface SelectionTranslationDependencies {
  translate?(
    request: TranslationRequest,
    signal: AbortSignal,
    settings: ContentSettings,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]>;
  copyText?(text: string): Promise<void>;
  message?(key: string): string;
  createLocalProvider?(): ChromeLocalProvider;
}

function defaultMessage(key: string): string {
  return message(key);
}

function isExcludedNode(node: Node | null): boolean {
  let current: Node | null = node;
  while (current) {
    if (current instanceof Element) {
      if (
        current.tagName.startsWith("NORITRANS-") ||
        current.matches(EXCLUDED_SELECTOR) ||
        (current instanceof HTMLInputElement && current.type === "password") ||
        (current instanceof HTMLElement && current.isContentEditable)
      ) {
        return true;
      }
    }
    const root = current.getRootNode();
    current =
      current.parentNode ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

function isPunctuationOnly(value: string): boolean {
  return /^[\p{P}\p{S}\s]+$/u.test(value);
}

function readSelectionSnapshot(): SelectionSnapshot | undefined {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed)
    return undefined;
  const text = selection.toString().trim();
  if (
    text.length === 0 ||
    text.length > MAX_SELECTION_CHARACTERS ||
    isPunctuationOnly(text)
  ) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  if (
    isExcludedNode(selection.anchorNode) ||
    isExcludedNode(selection.focusNode) ||
    isExcludedNode(range.commonAncestorContainer)
  ) {
    return undefined;
  }
  const fragment = range.cloneContents();
  if (fragment.querySelector?.(EXCLUDED_SELECTOR)) return undefined;
  const rects = range.getClientRects();
  const rect = rects.item(rects.length - 1) ?? range.getBoundingClientRect();
  return { text, rect };
}

function isTranslationResponse(value: unknown): value is TranslationResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

function selectionConfigurationChanged(
  previous: ContentSettings,
  next: ContentSettings,
): boolean {
  return (
    previous.page.selectionTranslationEnabled !==
      next.page.selectionTranslationEnabled ||
    previous.page.selectionTranslationSourceLanguage !==
      next.page.selectionTranslationSourceLanguage ||
    previous.page.selectionTranslationTargetLanguage !==
      next.page.selectionTranslationTargetLanguage ||
    previous.page.selectionTranslationMode !==
      next.page.selectionTranslationMode ||
    previous.page.selectionTranslationAiRoute !==
      next.page.selectionTranslationAiRoute ||
    previous.page.selectionTranslationAiResponseMode !==
      next.page.selectionTranslationAiResponseMode ||
    previous.page.selectionTranslationModelOverride !==
      next.page.selectionTranslationModelOverride ||
    previous.page.selectionTranslationFastProviderOverride !==
      next.page.selectionTranslationFastProviderOverride ||
    previous.page.selectionTranslationDisplayMode !==
      next.page.selectionTranslationDisplayMode ||
    previous.provider.fastProvider !== next.provider.fastProvider ||
    previous.provider.aiProvider !== next.provider.aiProvider ||
    previous.provider.baseUrl !== next.provider.baseUrl ||
    previous.provider.microsoftRegion !== next.provider.microsoftRegion ||
    previous.provider.deeplPlan !== next.provider.deeplPlan ||
    previous.provider.model !== next.provider.model ||
    previous.provider.systemPrompt !== next.provider.systemPrompt ||
    previous.provider.timeoutMs !== next.provider.timeoutMs
  );
}

function selectionFastProvider(settings: ContentSettings) {
  return (
    settings.page.selectionTranslationFastProviderOverride ??
    settings.provider.fastProvider
  );
}

async function defaultRemoteTranslate(
  request: TranslationRequest,
  signal: AbortSignal,
  onProgress?: TranslationProgressCallback,
): Promise<TranslationResult[]> {
  const requestId = runtimeId("selection-translation");
  const unsubscribe = onProgress
    ? subscribeTranslationProgress(requestId, (result) => {
        void onProgress(result);
      })
    : () => undefined;
  const cancel = (): void => {
    void browser.runtime.sendMessage({ type: "TRANSLATE_CANCEL", requestId });
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: "TRANSLATE",
      requestId,
      request,
    });
    if (!isTranslationResponse(response) || !response.ok || !response.results) {
      throw new Error(
        isTranslationResponse(response)
          ? (response.error?.code ?? "request_failed")
          : "request_failed",
      );
    }
    return response.results;
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", cancel);
  }
}

function defaultCopyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

/** Translates an ordinary page selection without mutating page or subtitle sessions. */
export class SelectionTranslation {
  private settings: ContentSettings;
  private readonly translate: NonNullable<
    SelectionTranslationDependencies["translate"]
  >;
  private readonly copyText: NonNullable<
    SelectionTranslationDependencies["copyText"]
  >;
  private readonly message: NonNullable<
    SelectionTranslationDependencies["message"]
  >;
  private readonly createLocalProvider: () => ChromeLocalProvider;
  private readonly host = document.createElement(
    "noritrans-selection-translation",
  );
  private readonly root: ShadowRoot;
  private readonly trigger: HTMLButtonElement;
  private readonly card: HTMLElement;
  private readonly originalSection: HTMLElement;
  private readonly originalText: HTMLParagraphElement;
  private readonly translatedText: HTMLParagraphElement;
  private readonly loading: HTMLElement;
  private readonly error: HTMLElement;
  private readonly errorText: HTMLParagraphElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly copyStatus: HTMLOutputElement;
  private readonly closeButton: HTMLButtonElement;
  private snapshot: SelectionSnapshot | undefined;
  private requestController: AbortController | undefined;
  private requestVersion = 0;
  private selectionTimer: number | undefined;
  private returnFocus: HTMLElement | undefined;
  private destroyed = false;
  private localProvider: ChromeLocalProvider | undefined;
  private localProviderConfiguration: string | undefined;

  constructor(
    settings: ContentSettings,
    dependencies: SelectionTranslationDependencies = {},
  ) {
    this.settings = settings;
    this.translate = dependencies.translate
      ? (request, signal, currentSettings, onProgress) =>
          dependencies.translate!(request, signal, currentSettings, onProgress)
      : (request, signal, currentSettings, onProgress) =>
          this.translateRequest(request, signal, currentSettings, onProgress);
    this.copyText = dependencies.copyText
      ? (text) => dependencies.copyText!(text)
      : defaultCopyText;
    this.message = dependencies.message
      ? (key) => dependencies.message!(key)
      : defaultMessage;
    this.createLocalProvider = dependencies.createLocalProvider
      ? () => dependencies.createLocalProvider!()
      : () =>
          new ChromeLocalProvider({
            keepAliveForTask: true,
            dynamicSourceLanguage: true,
          });
    this.host.dataset.noritransUi = "selection-translation";
    this.host.hidden = true;
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = `
      <style>${STYLE}</style>
      <button class="translate-trigger" type="button" hidden>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5h10M9 3v2c0 4.4-2 7.7-6 10M6 9c1.5 2.4 3.5 4.2 6 5.5M14 19l3.5-9 3.5 9M15.3 16h4.4" />
        </svg>
      </button>
      <section class="card" role="dialog" aria-modal="false" aria-labelledby="nt-selection-title" hidden tabindex="-1">
        <header class="card-header">
          <strong id="nt-selection-title"></strong>
          <button class="icon-button close-button" type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div class="content">
          <section class="content-section original-section">
            <span class="content-label original-label"></span>
            <p class="original-text"></p>
          </section>
          <section class="content-section result-section" aria-live="polite">
            <span class="content-label translation-label"></span>
            <div class="loading" hidden><span class="spinner" aria-hidden="true"></span><span class="loading-text"></span></div>
            <p class="translated-text" hidden></p>
            <div class="error" hidden><p class="error-text"></p><button class="retry-button" type="button"></button></div>
          </section>
        </div>
        <footer class="card-actions">
          <output class="copy-status" aria-live="polite"></output>
          <button class="action-button copy-button" type="button" hidden disabled></button>
        </footer>
      </section>
    `;
    this.trigger = this.required<HTMLButtonElement>(".translate-trigger");
    this.card = this.required<HTMLElement>(".card");
    this.originalSection = this.required<HTMLElement>(".original-section");
    this.originalText = this.required<HTMLParagraphElement>(".original-text");
    this.translatedText =
      this.required<HTMLParagraphElement>(".translated-text");
    this.loading = this.required<HTMLElement>(".loading");
    this.error = this.required<HTMLElement>(".error");
    this.errorText = this.required<HTMLParagraphElement>(".error-text");
    this.retryButton = this.required<HTMLButtonElement>(".retry-button");
    this.copyButton = this.required<HTMLButtonElement>(".copy-button");
    this.copyStatus = this.required<HTMLOutputElement>(".copy-status");
    this.closeButton = this.required<HTMLButtonElement>(".close-button");
    this.localizeUi();
    (document.documentElement ?? document).append(this.host);
    this.bindEvents();
  }

  updateSettings(settings: ContentSettings): void {
    const changed = selectionConfigurationChanged(this.settings, settings);
    this.settings = settings;
    if (changed) {
      this.dismiss();
      if (
        this.localProviderConfiguration !==
        this.localProviderConfigurationFor(settings)
      ) {
        this.releaseLocalProvider();
      }
    }
  }

  refreshLocale(): void {
    this.localizeUi();
  }

  dismiss(restoreFocus = false): void {
    this.cancelRequest();
    this.snapshot = undefined;
    this.host.hidden = true;
    this.trigger.hidden = true;
    this.card.hidden = true;
    this.host.dataset.state = "idle";
    this.copyStatus.textContent = "";
    if (restoreFocus && this.returnFocus?.isConnected) this.returnFocus.focus();
    this.returnFocus = undefined;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.dismiss(false);
    this.releaseLocalProvider();
    if (this.selectionTimer !== undefined)
      window.clearTimeout(this.selectionTimer);
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("pointerup", this.onPointerUp, true);
    document.removeEventListener(
      "pointerdown",
      this.onDocumentPointerDown,
      true,
    );
    document.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("scroll", this.onViewportChange, true);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("popstate", this.onNavigation);
    window.removeEventListener("hashchange", this.onNavigation);
    window.removeEventListener("yt-navigate-start", this.onNavigation);
    window.removeEventListener("yt-navigate-finish", this.onNavigation);
    this.host.remove();
  }

  private required<T extends Element>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element)
      throw new Error(`Missing selection translation element: ${selector}`);
    return element;
  }

  private localizeUi(): void {
    this.trigger.setAttribute("aria-label", this.message("selectionTranslate"));
    this.trigger.title = this.message("selectionTranslate");
    this.required<HTMLElement>("#nt-selection-title").textContent =
      this.message("selectionTranslationTitle");
    this.required<HTMLElement>(".original-label").textContent =
      this.message("selectionOriginal");
    this.required<HTMLElement>(".translation-label").textContent = this.message(
      "selectionTranslation",
    );
    this.required<HTMLElement>(".loading-text").textContent = this.message(
      "selectionTranslating",
    );
    this.retryButton.textContent = this.message("selectionRetry");
    this.copyButton.textContent = this.message("selectionCopy");
    this.closeButton.setAttribute("aria-label", this.message("selectionClose"));
    this.closeButton.title = this.message("selectionClose");
  }

  private bindEvents(): void {
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("pointerup", this.onPointerUp, true);
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("scroll", this.onViewportChange, true);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("popstate", this.onNavigation);
    window.addEventListener("hashchange", this.onNavigation);
    window.addEventListener("yt-navigate-start", this.onNavigation);
    window.addEventListener("yt-navigate-finish", this.onNavigation);
    this.trigger.addEventListener("pointerdown", (event) =>
      event.preventDefault(),
    );
    this.trigger.addEventListener("click", () => void this.startTranslation());
    this.retryButton.addEventListener(
      "click",
      () => void this.startTranslation(),
    );
    this.copyButton.addEventListener(
      "click",
      () => void this.copyTranslation(),
    );
    this.closeButton.addEventListener("click", () => this.dismiss(true));
  }

  private readonly onSelectionChange = (): void => this.queueSelectionRead();
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.composedPath().includes(this.host)) return;
    this.queueSelectionRead();
  };
  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (this.host.hidden || event.composedPath().includes(this.host)) return;
    this.dismiss(false);
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.host.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    this.dismiss(true);
  };
  private readonly onViewportChange = (event: Event): void => {
    if (event.composedPath().includes(this.host)) return;
    this.dismiss(false);
  };
  private readonly onResize = (): void => this.dismiss(false);
  private readonly onNavigation = (): void => this.dismiss(false);

  private queueSelectionRead(): void {
    if (this.destroyed || !this.settings.page.selectionTranslationEnabled)
      return;
    if (this.selectionTimer !== undefined)
      window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => {
      this.selectionTimer = undefined;
      if (this.root.activeElement) return;
      const snapshot = readSelectionSnapshot();
      if (!snapshot) {
        this.dismiss(false);
        return;
      }
      this.cancelRequest();
      this.snapshot = snapshot;
      this.returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined;
      this.showTrigger(snapshot);
    }, 0);
  }

  private showTrigger(snapshot: SelectionSnapshot): void {
    this.host.hidden = false;
    this.host.dataset.state = "ready";
    this.card.hidden = true;
    this.trigger.hidden = false;
    const left = snapshot.rect.right - 22;
    const top = snapshot.rect.bottom + POPOVER_GAP;
    this.position(left, top, 44, 44, snapshot.rect);
  }

  private showCard(state: "loading" | "translated" | "error"): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.host.hidden = false;
    this.host.dataset.state = state;
    this.trigger.hidden = true;
    this.card.hidden = false;
    this.originalSection.hidden =
      this.settings.page.selectionTranslationDisplayMode === "translated";
    this.originalText.textContent = snapshot.text;
    this.loading.hidden = state !== "loading";
    this.translatedText.hidden = state !== "translated";
    this.error.hidden = state !== "error";
    this.copyButton.hidden = state !== "translated";
    this.copyButton.disabled = state !== "translated";
    this.required<HTMLElement>(".result-section").setAttribute(
      "aria-busy",
      String(state === "loading"),
    );
    this.host.style.left = "0px";
    this.host.style.top = "0px";
    const width = Math.max(
      this.card.getBoundingClientRect().width,
      Math.min(360, innerWidth - 16),
    );
    const height = Math.max(this.card.getBoundingClientRect().height, 220);
    this.position(
      snapshot.rect.left,
      snapshot.rect.bottom + POPOVER_GAP,
      width,
      height,
      snapshot.rect,
    );
  }

  private position(
    desiredLeft: number,
    desiredTop: number,
    width: number,
    height: number,
    selectionRect: DOMRect,
  ): void {
    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      innerWidth - width - VIEWPORT_PADDING,
    );
    const left = Math.min(maxLeft, Math.max(VIEWPORT_PADDING, desiredLeft));
    const preferredAbove = selectionRect.top - height - POPOVER_GAP;
    const top =
      desiredTop + height <= innerHeight - VIEWPORT_PADDING
        ? desiredTop
        : Math.max(VIEWPORT_PADDING, preferredAbove);
    this.host.style.left = `${Math.round(left)}px`;
    this.host.style.top = `${Math.round(top)}px`;
  }

  private cancelRequest(): void {
    this.requestVersion += 1;
    this.requestController?.abort();
    this.requestController = undefined;
  }

  private localProviderConfigurationFor(
    settings: ContentSettings,
  ): string | undefined {
    if (
      !settings.page.selectionTranslationEnabled ||
      settings.page.selectionTranslationMode !== "fast" ||
      selectionFastProvider(settings) !== "chrome-local"
    ) {
      return undefined;
    }
    return [
      settings.page.selectionTranslationSourceLanguage,
      settings.page.selectionTranslationTargetLanguage,
    ].join("\u001f");
  }

  private ensureLocalProvider(
    settings: ContentSettings,
  ): ChromeLocalProvider | undefined {
    const configuration = this.localProviderConfigurationFor(settings);
    if (!configuration) {
      this.releaseLocalProvider();
      return undefined;
    }
    if (
      configuration !== this.localProviderConfiguration ||
      !this.localProvider
    ) {
      this.releaseLocalProvider();
      this.localProviderConfiguration = configuration;
      this.localProvider = this.createLocalProvider();
    }
    return this.localProvider;
  }

  private releaseLocalProvider(): void {
    const provider = this.localProvider;
    this.localProvider = undefined;
    this.localProviderConfiguration = undefined;
    void provider?.dispose();
  }

  private translateRequest(
    request: TranslationRequest,
    signal: AbortSignal,
    settings: ContentSettings,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    if (
      request.mode === "fast" &&
      selectionFastProvider(settings) === "chrome-local"
    ) {
      const provider = this.ensureLocalProvider(settings);
      if (provider) return provider.translateBatch(request, signal, onProgress);
    }
    this.releaseLocalProvider();
    return defaultRemoteTranslate(request, signal, onProgress);
  }

  private async startTranslation(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.cancelRequest();
    const version = this.requestVersion;
    const controller = new AbortController();
    this.requestController = controller;
    this.copyStatus.textContent = "";
    this.showCard("loading");
    this.card.focus({ preventScroll: true });
    const request: TranslationRequest = {
      sourceLanguage: this.settings.page.selectionTranslationSourceLanguage,
      targetLanguage: this.settings.page.selectionTranslationTargetLanguage,
      mode: this.settings.page.selectionTranslationMode,
      ...(this.settings.page.selectionTranslationMode === "ai"
        ? { aiRoute: this.settings.page.selectionTranslationAiRoute }
        : {}),
      responseMode: this.settings.page.selectionTranslationAiResponseMode,
      scope: `selection:${location.origin}${location.pathname}`,
      segments: [{ id: SELECTION_SEGMENT_ID, text: snapshot.text }],
      ...(this.settings.page.selectionTranslationMode === "ai" &&
      this.settings.page.selectionTranslationModelOverride
        ? {
            modelOverride: this.settings.page.selectionTranslationModelOverride,
          }
        : {}),
      ...(this.settings.page.selectionTranslationMode === "fast"
        ? { providerOverride: selectionFastProvider(this.settings) }
        : {}),
    };
    let hasSuccessfulResult = false;
    const applySuccessfulResult = (result: TranslationResult): boolean => {
      if (
        hasSuccessfulResult ||
        controller.signal.aborted ||
        version !== this.requestVersion ||
        snapshot !== this.snapshot ||
        result.id !== SELECTION_SEGMENT_ID ||
        result.translatedText.trim().length === 0
      ) {
        return false;
      }
      hasSuccessfulResult = true;
      this.translatedText.textContent = cleanTranslatedText(
        result.translatedText,
      );
      this.showCard("translated");
      return true;
    };
    try {
      const results = await this.translate(
        request,
        controller.signal,
        this.settings,
        (result) => {
          applySuccessfulResult(result);
        },
      );
      if (
        controller.signal.aborted ||
        version !== this.requestVersion ||
        snapshot !== this.snapshot
      ) {
        return;
      }
      const result = results[0];
      if (
        results.length !== 1 ||
        result?.id !== SELECTION_SEGMENT_ID ||
        result.translatedText.trim().length === 0
      ) {
        if (hasSuccessfulResult) return;
        throw new Error("invalid_response");
      }
      applySuccessfulResult(result);
    } catch (error) {
      if (
        controller.signal.aborted ||
        version !== this.requestVersion ||
        snapshot !== this.snapshot
      ) {
        return;
      }
      if (hasSuccessfulResult) return;
      this.errorText.textContent = localizeRuntimeError(error, (key) =>
        this.message(key),
      );
      this.showCard("error");
      this.retryButton.focus({ preventScroll: true });
    } finally {
      if (this.requestController === controller)
        this.requestController = undefined;
    }
  }

  private async copyTranslation(): Promise<void> {
    const value = this.translatedText.textContent ?? "";
    if (!value) return;
    this.copyButton.disabled = true;
    try {
      await this.copyText(value);
      this.copyStatus.textContent = this.message("selectionCopied");
    } catch {
      this.copyStatus.textContent = this.message("selectionCopyFailed");
    } finally {
      if (!this.host.hidden && this.host.dataset.state === "translated")
        this.copyButton.disabled = false;
    }
  }
}
