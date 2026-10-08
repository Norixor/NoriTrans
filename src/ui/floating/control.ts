// Must stay the first import: the polyfill has to be evaluated before `lit`.
import {
  createFullscreenPortal,
  createInjectedRoot,
  ensureInjectedUi,
  type FullscreenPortal,
  type FullscreenPresentation,
  type InjectedRoot,
  type InjectedUiResult,
} from "@/src/ui/inject";
import type { ImageTranslationStatus } from "@/src/image-translation/controller";
import type { PageStatus, SubtitleStatus } from "@/src/messaging/protocol";
import type { OcrStatus } from "@/src/ocr/types";
import { message } from "@/src/shared/i18n";
import type { ContentSettings } from "@/src/shared/settings";
import type { FloatingControlCallbacks } from "./callbacks";
import { queryDocumentTranslationCapabilities } from "@/src/translation/provider-capabilities";
import type { NtMenuItem, NtPillFab, NtTabItem } from "@/src/ui/components";
import { deepActiveElement } from "@/src/ui/components/shared";
import type { StatusView } from "@/src/ui/status";
import { html, nothing, render, svg, type TemplateResult } from "lit";
import { browser } from "wxt/browser";
import {
  keyboardMoveDirection,
  type NormalizedPosition,
  panelPlacement,
  pillDirection,
  readViewport,
} from "./geometry";
import { ImageSection } from "./image-section";
import { isImageRunning } from "./image-view";
import { OcrSection, type OcrRuntimeQuery } from "./ocr-section";
import { defaultQueryOcrRuntime } from "./ocr-runtime";
import { isOcrRunning } from "./ocr-view";
import { EMPTY_CAPABILITIES, type CapabilitySnapshot } from "./options";
import { PageTab } from "./page-tab";
import { FloatingPositioner } from "./position";
import { FLOATING_HOST_STYLE, floatingStyles } from "./styles";
import type { FloatingTab, FloatingTabContext, SettingsSection } from "./tab";
import { VideoTab, type VideoTabExtraCallbacks } from "./video-tab";
import {
  announcementFor,
  launcherSource,
  localize,
  progressValue,
  tabIndicator,
  visualState,
  type FloatingTabId,
} from "./view";

/** `data-noritrans-ui` markers; see src/shared/runtime-ui-cleanup.ts. */
export const FLOATING_CONTROL_SURFACE = "floating-control";
export const FLOATING_CONTROL_PORTAL_SURFACE = "floating-control-portal";

export interface FloatingControlOptions
  extends FloatingControlCallbacks, VideoTabExtraCallbacks {
  /**
   * Persists "always hide". Defaults to the same background message the
   * previous control sent (`FLOATING_BUTTON_SET`, surface `all`).
   */
  onHidePermanently?(): Promise<void> | void;
  /** Opens an options-page section; defaults to an `options.html` link. */
  onOpenSettings?(section?: SettingsSection): void;
  /** Pill announcements on the collapsed button; defaults to on. */
  announcements?: boolean;
  /**
   * Whether the image recognition pack for a source language is installed.
   * Defaults to the read-only `OCR_RUNTIME_LIST` background message.
   */
  queryOcrRuntime?: OcrRuntimeQuery;
}

/** Result of mounting; `ok: false` means nothing was rendered. */
export type FloatingMountResult =
  | { ok: true }
  | { ok: false; code: Exclude<InjectedUiResult, { ok: true }>["code"] };

type MenuItemId = "hide-current" | "hide-always" | "settings";

/** Id of the settings panel the launcher button controls. */
const PANEL_ID = "nt-floating-panel";

const translateIcon = svg`<path d="M4 5h9M8.5 3v2M11 5c-.6 3.6-2.8 6.6-6 8.5M6.5 8.5c1 2.4 3 4.4 5.5 5.5M12.5 20l4-9 4 9M13.9 17h5.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

async function defaultHidePermanently(): Promise<void> {
  const response: unknown = await browser.runtime.sendMessage({
    type: "FLOATING_BUTTON_SET",
    surface: "all",
    enabled: false,
  });
  if (
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    response.ok !== true
  ) {
    throw new Error("floating-hide-failed");
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Direction B floating control: a draggable pill button that opens a panel
 * with "Page / Video" tabs. Public API matches the previous control so the
 * content entry can switch implementations without other changes.
 *
 * Mounting: the polyfill is loaded by the first import; components are
 * defined (`ensureInjectedUi`) before any element is created. When that fails
 * nothing is rendered, every method becomes a no-op and `mount` reports the
 * reason (also logged once to the content-script console).
 *
 * Fullscreen: the host is moved into the fullscreen element (interactive
 * top-layer portal) and the panel collapses. For a fullscreen `<video>` the
 * portal can only sit at the root, where Chromium makes it inert, so the
 * button shows status only. Leaving fullscreen restores the position and the
 * expanded state from before.
 */
export class FloatingControl {
  readonly mount: FloatingMountResult;

  private readonly options: FloatingControlOptions;
  private readonly ui: InjectedRoot | undefined;
  private positioner: FloatingPositioner | undefined;
  private portal: FullscreenPortal | undefined;
  private pageTab: PageTab | undefined;
  private videoTab: VideoTab | undefined;
  private ocrSection: OcrSection | undefined;
  private imageSection: ImageSection | undefined;
  private tabs: FloatingTab[] = [];

  private settings: ContentSettings;
  private capabilities: CapabilitySnapshot = EMPTY_CAPABILITIES;
  private capabilitiesRevision = 0;
  private selectedTab: FloatingTabId = "page";
  private expanded = false;
  private menuOpen = false;
  private confirmingHide = false;
  private hideBusy = false;
  private hideFailed = false;
  private hidden = false;
  private announcementsEnabled: boolean;
  private announcedKind: string | undefined;
  private announcement = "";
  private presentation: FullscreenPresentation = "inline";
  private fullscreenSnapshot:
    | {
        position: ReturnType<FloatingPositioner["snapshot"]>;
        expanded: boolean;
      }
    | undefined;
  private renderQueued = false;
  private destroyed = false;
  private fab: NtPillFab | null = null;
  private moreButton: HTMLElement | null = null;
  private panel: HTMLElement | null = null;

  constructor(options: FloatingControlOptions) {
    this.options = options;
    this.settings = options.settings;
    this.announcementsEnabled = options.announcements !== false;
    const ready = ensureInjectedUi();
    if (!ready.ok) {
      this.mount = { ok: false, code: ready.code };
      console.warn(`[NoriTrans] floating control unavailable: ${ready.code}`);
      return;
    }
    this.mount = { ok: true };
    this.ui = createInjectedRoot({
      surface: FLOATING_CONTROL_SURFACE,
      hostStyle: {
        ...FLOATING_HOST_STYLE,
        ...(prefersReducedMotion()
          ? {}
          : { transition: "transform 180ms cubic-bezier(0.2, 0, 0, 1)" }),
      },
      styles: [floatingStyles],
    });
    const context: FloatingTabContext = {
      requestRender: () => this.requestRender(),
      capabilities: () => this.capabilities,
      openSettings: (section) => this.openSettings(section),
      hostname: () => location.hostname,
      collapse: () => this.collapse(false),
      focus: (selector) => this.focusAfterRender(selector),
    };
    this.pageTab = new PageTab(options, this.settings, context);
    this.videoTab = new VideoTab(options, this.settings, context);
    this.tabs = [this.pageTab, this.videoTab];
    const videoTab = this.videoTab;
    const ocrSection = new OcrSection({
      callbacks: options,
      settings: this.settings,
      context,
      subtitle: () => videoTab.subtitle,
      queryRuntime: options.queryOcrRuntime ?? defaultQueryOcrRuntime,
    });
    this.ocrSection = ocrSection;
    videoTab.addSection(ocrSection);
    if (ocrSection.canStart) {
      videoTab.setTryOcrHandler(() => void ocrSection.tryOcr());
    }
    this.imageSection = new ImageSection(options, this.settings, context);
    this.pageTab.addSection(this.imageSection);

    this.flushRender();
    this.fab = this.ui.root.querySelector("nt-pill-fab");
    this.moreButton = this.ui.root.querySelector(".more");
    this.panel = this.ui.root.querySelector(".panel");
    if (this.fab) {
      this.positioner = new FloatingPositioner({
        setHostStyle: (declarations) => this.ui?.setHostStyle(declarations),
        host: this.ui.host,
        handle: this.fab,
        ...(options.loadPosition
          ? {
              loadPosition: () =>
                options.loadPosition?.() ?? Promise.resolve(undefined),
            }
          : {}),
        ...(options.onPositionChange
          ? {
              onPositionChange: (position: NormalizedPosition) =>
                options.onPositionChange?.(position),
            }
          : {}),
        onLayout: () => this.requestRender(),
        onDockedByDrag: () => this.collapse(false),
        canTuck: () => !this.expanded,
        beforeTuck: () => this.releasePointerFocus(),
      });
      this.fab.addEventListener("click", this.onFabClick);
      this.fab.addEventListener("keydown", this.onFabKeyDown);
    }
    this.ui.host.addEventListener("pointerleave", this.onHostPointerLeave);
    this.ui.host.addEventListener("focusin", this.onHostFocusIn);
    this.ui.host.addEventListener("focusout", this.onHostFocusOut);
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.addEventListener("keydown", this.onDocumentKeyDown);
    window.addEventListener("resize", this.onViewportResize);
    window.visualViewport?.addEventListener("resize", this.onViewportResize);
    this.portal = createFullscreenPortal({
      host: this.ui.host,
      surface: FLOATING_CONTROL_PORTAL_SURFACE,
      onChange: ({ presentation }) => this.onFullscreenChange(presentation),
    });
    this.portal.sync();
    void this.positioner?.restore();
    void this.refreshCapabilities();
  }

  /** The host element (undefined when mounting failed). */
  get element(): HTMLElement | undefined {
    return this.ui?.host;
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  updateSettings(settings: ContentSettings): void {
    if (!this.ui) return;
    this.settings = settings;
    for (const tab of this.tabs) tab.updateSettings(settings);
  }

  updatePageStatus(status: PageStatus): void {
    if (!this.ui) return;
    this.pageTab?.updateStatus(status);
    if (status.state === "scanning" || status.state === "translating") {
      this.preferTab("page");
    }
  }

  updateSubtitleStatus(status: SubtitleStatus): void {
    if (!this.ui) return;
    this.videoTab?.updateSubtitleStatus(status);
    if (status.state === "translating") this.preferTab("video");
  }

  updateOcrStatus(status: OcrStatus): void {
    if (!this.ui) return;
    this.ocrSection?.updateStatus(status);
    if (isOcrRunning(status)) this.preferTab("video");
  }

  updateImageStatus(status: ImageTranslationStatus): void {
    if (!this.ui) return;
    this.imageSection?.updateStatus(status);
    if (isImageRunning(status)) this.preferTab("page");
  }

  /** Turns pill announcements on or off (the live region still speaks). */
  setAnnouncementsEnabled(enabled: boolean): void {
    this.announcementsEnabled = enabled;
    this.requestRender();
  }

  show(): void {
    if (!this.ui) return;
    this.hidden = false;
    this.applyVisibility();
  }

  hide(): void {
    if (!this.ui) return;
    this.collapse(false);
    this.hidden = true;
    this.applyVisibility();
  }

  destroy(): void {
    if (!this.ui || this.destroyed) return;
    this.destroyed = true;
    document.removeEventListener(
      "pointerdown",
      this.onDocumentPointerDown,
      true,
    );
    document.removeEventListener("keydown", this.onDocumentKeyDown);
    window.removeEventListener("resize", this.onViewportResize);
    window.visualViewport?.removeEventListener("resize", this.onViewportResize);
    this.fab?.removeEventListener("click", this.onFabClick);
    this.fab?.removeEventListener("keydown", this.onFabKeyDown);
    this.positioner?.dispose();
    for (const tab of this.tabs) tab.dispose();
    this.portal?.dispose();
    render(nothing, this.ui.theme);
    this.ui.dispose();
  }

  // --- expand / collapse ----------------------------------------------------

  /** Opens the panel; moves focus to the selected tab when asked. */
  expand(moveFocus = true): void {
    if (!this.ui || this.expanded || this.statusOnly() || this.hidden) return;
    this.positioner?.reveal();
    this.selectedTab = this.taskTab();
    this.expanded = true;
    this.hideFailed = false;
    this.flushRender();
    if (moveFocus) this.focusSelectedTab();
  }

  /** Closes the panel; focus returns to the button when asked or owned. */
  collapse(restoreFocus: boolean): void {
    if (!this.ui || !this.expanded) return;
    const active = deepActiveElement();
    const panelOwnedFocus =
      active instanceof Node && this.nestedWithin(this.panel, active);
    this.expanded = false;
    this.menuOpen = false;
    this.confirmingHide = false;
    this.flushRender();
    if ((restoreFocus || panelOwnedFocus) && !this.hidden) this.focusFab();
    this.positioner?.scheduleTuck();
  }

  /** Renders now, then focuses `selector` once the target has rendered. */
  private focusAfterRender(selector: string): void {
    if (!this.ui || !this.expanded) return;
    this.flushRender();
    const target = this.ui.root.querySelector<HTMLElement>(selector);
    if (!target) return;
    const ready =
      "updateComplete" in target
        ? (target as HTMLElement & { updateComplete: Promise<unknown> })
            .updateComplete
        : Promise.resolve();
    void ready.then(() => {
      if (this.expanded && target.isConnected) {
        target.focus({ preventScroll: true });
      }
    });
  }

  private focusFab(): void {
    const button = this.fab?.shadowRoot?.querySelector("button");
    (button ?? this.fab)?.focus({ preventScroll: true });
  }

  private focusSelectedTab(): void {
    const tabs = this.ui?.root.querySelector("nt-tabs");
    if (!tabs) return;
    // The tab list re-renders asynchronously after a selection change.
    void tabs.updateComplete.then(() => {
      if (!this.expanded) return;
      const selected = tabs.shadowRoot?.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      );
      (selected ?? this.panel)?.focus({ preventScroll: true });
    });
  }

  /** Drops focus that came from a pointer before the button tucks away. */
  private releasePointerFocus(): void {
    const active = deepActiveElement();
    if (!(active instanceof HTMLElement) || !this.owns(active)) return;
    try {
      if (active.matches(":focus-visible")) return;
    } catch {
      // Older engines may not support :focus-visible in matches().
    }
    active.blur();
  }

  /** Whether `node` lives inside the host, through any nested shadow roots. */
  private owns(node: Node): boolean {
    return this.nestedWithin(this.ui?.host, node);
  }

  /**
   * Whether `node` is inside `container`, descending through nested shadow
   * roots. Plain `contains()` stops at a shadow boundary, so a button inside
   * an `nt-*` component would otherwise look like it sits outside the panel.
   */
  private nestedWithin(
    container: Element | null | undefined,
    node: Node,
  ): boolean {
    if (!container) return false;
    let current: Node = node;
    for (;;) {
      if (current === container || container.contains(current)) return true;
      const root = current.getRootNode();
      if (!(root instanceof ShadowRoot)) return false;
      current = root.host;
    }
  }

  private statusOnly(): boolean {
    return this.presentation === "inert-portal";
  }

  private applyVisibility(): void {
    this.ui?.setHostStyle({
      display:
        this.hidden || this.presentation === "unsupported" ? "none" : "block",
    });
  }

  // --- tabs and status --------------------------------------------------------

  private views(): Record<FloatingTabId, StatusView> {
    return {
      page: this.pageTab!.statusView(),
      video: this.videoTab!.statusView(),
    };
  }

  private preferTab(id: FloatingTabId): void {
    if (!this.expanded) this.selectedTab = id;
  }

  /** Tab that should open: the only running task, else the last selected. */
  private taskTab(): FloatingTabId {
    const views = this.views();
    const active = (["page", "video"] as const).filter(
      (id) => views[id].kind === "scanning" || views[id].kind === "translating",
    );
    return active.length === 1 ? active[0]! : this.selectedTab;
  }

  private async refreshCapabilities(): Promise<void> {
    const revision = ++this.capabilitiesRevision;
    let capabilities = EMPTY_CAPABILITIES.capabilities;
    try {
      capabilities = await queryDocumentTranslationCapabilities();
    } catch {
      // Treat every language as available, like the previous control.
    }
    if (revision !== this.capabilitiesRevision || this.destroyed) return;
    this.capabilities = { ready: true, capabilities };
    this.requestRender();
  }

  // --- menu actions -----------------------------------------------------------

  private menuItems(): NtMenuItem[] {
    return [
      {
        id: "hide-current",
        label: message("hideCurrentPage"),
        icon: "eye-off",
        disabled: this.hideBusy,
      },
      {
        id: "hide-always",
        label: message("floatingHideAlwaysMenu"),
        icon: "power",
        danger: true,
        disabled: this.hideBusy,
      },
      {
        id: "settings",
        label: message("optionsTitle"),
        icon: "settings",
        separatorBefore: true,
      },
    ];
  }

  private onMenuSelect(id: MenuItemId): void {
    this.menuOpen = false;
    switch (id) {
      case "hide-current":
        void this.runHide(() => this.options.onHideCurrent());
        break;
      case "hide-always":
        this.confirmingHide = true;
        this.hideFailed = false;
        this.flushRender();
        // The menu restores focus to its trigger after this event; move it
        // into the confirmation afterwards.
        setTimeout(() => {
          this.ui?.root
            .querySelector<HTMLElement>('.confirm [data-confirm="cancel"]')
            ?.focus();
        }, 0);
        break;
      case "settings":
        this.collapse(false);
        this.openSettings();
        break;
    }
    this.requestRender();
  }

  private async runHide(request: () => Promise<void> | void): Promise<void> {
    if (this.hideBusy) return;
    this.hideBusy = true;
    this.hideFailed = false;
    this.requestRender();
    try {
      await request();
      this.confirmingHide = false;
      this.hide();
    } catch {
      this.hideFailed = true;
    } finally {
      this.hideBusy = false;
      this.requestRender();
    }
  }

  private confirmHideAlways(): void {
    void this.runHide(() =>
      this.options.onHidePermanently
        ? this.options.onHidePermanently()
        : defaultHidePermanently(),
    );
  }

  private cancelHideAlways(): void {
    this.confirmingHide = false;
    this.flushRender();
    this.moreButton?.focus();
  }

  private openSettings(section?: SettingsSection): void {
    if (this.options.onOpenSettings) {
      this.options.onOpenSettings(section);
      return;
    }
    const hash = section ? `#${section}` : "";
    const link = document.createElement("a");
    link.href =
      browser.runtime?.getURL?.(`/options.html${hash}` as "/options.html") ??
      (hash || "#settings");
    link.target = "_blank";
    link.rel = "noopener";
    this.ui?.root.append(link);
    link.click();
    link.remove();
  }

  // --- events ------------------------------------------------------------------

  private readonly onFabClick = (event: MouseEvent): void => {
    if (this.positioner?.consumeClickSuppression()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (this.statusOnly()) return;
    if (this.expanded) this.collapse(false);
    else this.expand();
  };

  private readonly onFabKeyDown = (event: KeyboardEvent): void => {
    const direction = keyboardMoveDirection(event.key);
    if (!direction || this.statusOnly()) return;
    event.preventDefault();
    this.positioner?.moveBy(direction, event.shiftKey);
  };

  private readonly onHostPointerLeave = (): void => {
    this.positioner?.scheduleTuck();
  };

  private readonly onHostFocusIn = (): void => {
    this.positioner?.reveal();
  };

  private readonly onHostFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.owns(next)) return;
    this.positioner?.scheduleTuck();
  };

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (!this.expanded || !this.ui) return;
    if (event.composedPath().includes(this.ui.host)) return;
    this.collapse(false);
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.expanded || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    if (this.confirmingHide) {
      this.cancelHideAlways();
      return;
    }
    const openDiagnostics =
      this.ui?.root.querySelector<HTMLDetailsElement>("details.diag[open]");
    if (openDiagnostics) {
      openDiagnostics.open = false;
      openDiagnostics.querySelector("summary")?.focus();
      return;
    }
    const tab = this.tabs.find(
      (candidate) => candidate.id === this.selectedTab,
    );
    if (tab?.handleEscape?.()) {
      // Keep focus where it is when it survived (e.g. a section header that
      // collapsed its own body); otherwise fall back to the selected tab.
      this.flushRender();
      const active = deepActiveElement();
      const kept =
        active instanceof HTMLElement &&
        active.isConnected &&
        this.owns(active);
      if (!kept) this.focusSelectedTab();
      return;
    }
    this.collapse(true);
  };

  private readonly onViewportResize = (): void => {
    this.positioner?.handleResize(this.presentation === "inline");
  };

  private onFullscreenChange(presentation: FullscreenPresentation): void {
    const wasInline = this.presentation === "inline";
    this.presentation = presentation;
    if (presentation !== "inline" && wasInline && this.positioner) {
      this.fullscreenSnapshot = {
        position: this.positioner.snapshot(),
        expanded: this.expanded,
      };
      // AGENTS §12: entering video fullscreen collapses the settings panel.
      this.collapse(false);
      this.positioner.reveal();
      this.positioner.handleResize(false);
    } else if (presentation === "inline" && !wasInline) {
      const snapshot = this.fullscreenSnapshot;
      this.fullscreenSnapshot = undefined;
      if (snapshot && this.positioner) {
        this.positioner.restoreSnapshot(snapshot.position);
        if (snapshot.expanded) this.expand(false);
      }
    } else {
      this.positioner?.handleResize(false);
    }
    this.applyVisibility();
    this.requestRender();
  }

  // --- rendering -------------------------------------------------------------

  private requestRender(): void {
    if (!this.ui || this.renderQueued || this.destroyed) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      if (this.renderQueued) this.flushRender();
    });
  }

  private flushRender(): void {
    if (!this.ui || this.destroyed) return;
    this.renderQueued = false;
    render(this.template(), this.ui.theme);
    this.placePanel();
  }

  private placePanel(): void {
    const panel = this.panel;
    if (!this.expanded || !panel || !this.ui) return;
    const viewport = readViewport();
    const launcher = this.ui.host.getBoundingClientRect();
    panel.style.removeProperty("max-height");
    const natural = panel.getBoundingClientRect().height;
    const placement = panelPlacement(launcher, natural, viewport);
    panel.style.left = `${placement.left}px`;
    panel.style.width = `${placement.width}px`;
    panel.style.maxHeight = `${placement.maxHeight}px`;
    panel.toggleAttribute("data-open-up", placement.openUp);
  }

  private launcherModel(views: Record<FloatingTabId, StatusView>): {
    view: StatusView;
    message: string;
    label: string;
  } {
    const view = views[launcherSource(views, this.selectedTab)];
    // Announce once per outcome; counts changing in the same state do not
    // re-trigger the pill.
    const key = `${view.task}:${view.kind}`;
    if (key !== this.announcedKind) {
      this.announcedKind = key;
      this.announcement = announcementFor(view);
    }
    const title = localize(view.title);
    return {
      view,
      message: this.expanded ? "" : this.announcement,
      label: `${message("floatingControl")} · ${title}`,
    };
  }

  private template(): TemplateResult {
    const views = this.views();
    const fab = this.launcherModel(views);
    const point = this.positioner?.currentPoint();
    const direction = point
      ? pillDirection(point.left, readViewport())
      : "start";
    const statusOnly = this.statusOnly();
    const tabItems: NtTabItem[] = this.tabs.map((tab) => ({
      id: tab.id,
      label: tab.label(),
      indicator: tabIndicator(views[tab.id]),
      indicatorLabel: localize(views[tab.id].title),
    }));
    return html`<div
        class="launcher"
        data-direction=${direction}
        ?data-status-only=${statusOnly}
      >
        <nt-pill-fab
          state=${visualState(fab.view)}
          .progress=${progressValue(fab.view)}
          label=${fab.label}
          message=${fab.message}
          ?silent=${!this.announcementsEnabled}
          direction=${direction}
          expanded=${statusOnly ? "" : String(this.expanded)}
          controls=${!statusOnly && this.expanded ? PANEL_ID : ""}
        ></nt-pill-fab>
      </div>
      <section
        class="panel"
        id=${PANEL_ID}
        role="dialog"
        aria-label=${message("floatingControl")}
        tabindex="-1"
        ?hidden=${!this.expanded}
      >
        <div class="hd">
          <span class="ttl"
            ><span class="logo" aria-hidden="true"
              ><svg viewBox="0 0 24 24">${translateIcon}</svg></span
            >NoriTrans</span
          >
          <nt-icon-button
            class="more"
            icon="more"
            label=${message("visibilityMenu")}
            haspopup="menu"
            expanded=${String(this.menuOpen)}
            @click=${() => {
              this.menuOpen = !this.menuOpen;
              this.requestRender();
            }}
          ></nt-icon-button>
          <nt-icon-button
            class="close"
            icon="close"
            label=${message("closeQuickSettings")}
            @click=${() => this.collapse(true)}
          ></nt-icon-button>
        </div>
        <nt-menu
          class="menu"
          label=${message("visibilityMenu")}
          .items=${this.menuItems()}
          .open=${this.menuOpen}
          .anchor=${this.moreButton}
          @nt-select=${(event: CustomEvent<{ id: MenuItemId }>) =>
            this.onMenuSelect(event.detail.id)}
          @nt-close=${() => {
            this.menuOpen = false;
            this.requestRender();
          }}
        ></nt-menu>
        <div class="body">
          ${this.confirmingHide ? this.renderHideConfirm() : nothing}
          ${
            this.hideFailed
              ? html`<nt-note class="notice" tone="warn" icon="warning"
                  >${message("floatingHideFailed")}</nt-note
                >`
              : nothing
          }
          <nt-tabs
            label=${message("floatingControl")}
            .tabs=${tabItems}
            selected=${this.selectedTab}
            @nt-change=${(event: CustomEvent<{ id: FloatingTabId }>) => {
              this.selectedTab = event.detail.id;
              this.requestRender();
            }}
          >
            ${this.tabs.map(
              (tab) =>
                html`<div slot=${tab.id}>
                  ${tab.id === this.selectedTab ? tab.render() : nothing}
                </div>`,
            )}
          </nt-tabs>
        </div>
      </section>`;
  }

  private renderHideConfirm(): TemplateResult {
    return html`<div
      class="confirm"
      role="alertdialog"
      aria-labelledby="nt-hide-title"
      aria-describedby="nt-hide-body"
    >
      <h2 id="nt-hide-title">${message("floatingHideAlwaysTitle")}</h2>
      <p id="nt-hide-body">${message("floatingHideAlwaysBody")}</p>
      <div class="acts">
        <nt-button
          variant="danger"
          size="sm"
          data-confirm="ok"
          ?busy=${this.hideBusy}
          @click=${() => this.confirmHideAlways()}
          >${message("disableFloatingPermanently")}</nt-button
        >
        <nt-button
          variant="ghost"
          size="sm"
          data-confirm="cancel"
          ?disabled=${this.hideBusy}
          @click=${() => this.cancelHideAlways()}
          >${message("floatingCancel")}</nt-button
        >
      </div>
    </div>`;
  }
}
