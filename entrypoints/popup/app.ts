import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { browser } from "wxt/browser";
import {
  isPageStatusValue,
  isSubtitleStatusValue,
  type PageStatus,
  type SubtitleStatus,
} from "@/src/messaging/protocol";
import {
  autoTranslateSitePatternForHostname,
  isSiteAutoTranslateEnabled,
  updateSiteAutoTranslateRules,
} from "@/src/shared/auto-translate-sites";
import { message } from "@/src/shared/i18n";
import {
  loadSettings,
  mergeSettings,
  type AppSettings,
} from "@/src/shared/settings";
import {
  isSettingsPatchResponse,
  type SettingsPatch,
} from "@/src/shared/settings-patch";
import { STATUS_REASON } from "@/src/shared/status-reasons";
import type { NtChipTone } from "@/src/ui/components";
import { icon } from "@/src/ui/components/icons";
import {
  localize,
  primaryVariant,
  progressValue,
  visualState,
} from "@/src/ui/floating/view";
import {
  pageStatusKind,
  pageStatusView,
  subtitleStatusKind,
  subtitleStatusView,
  type StatusAction,
  type StatusView,
  type SubtitleTrackTag,
} from "@/src/ui/status";
import type { ExtensionUpdateStatus } from "@/src/update/checker";
import {
  activePopupTab,
  ensureTabContent,
  queryTopFrame,
  sendTabCommand,
  type PopupTab,
  type PopupTabCommand,
} from "./tab";
import { TaskCardState } from "./task-state";

/** Poll interval for task status while the popup is open. */
export const POPUP_REFRESH_MS = 1500;
const MAX_DETAILS_LENGTH = 4_000;

const TRACK_CHIPS: Readonly<
  Record<SubtitleTrackTag, { tone: NtChipTone; key: string }>
> = {
  full: { tone: "full", key: "statusTrackFull" },
  stream: { tone: "stream", key: "statusTrackStream" },
  experimental: { tone: "experimental", key: "statusTrackExperimental" },
};

/** Status the popup shows for a tab whose content it cannot reach. */
export const RESTRICTED_PAGE_STATUS: PageStatus = {
  state: "unavailable",
  total: 0,
  completed: 0,
  failed: 0,
  reasonCode: STATUS_REASON.restrictedPage,
};

type Target =
  | { kind: "loading" }
  | { kind: "restricted" }
  | { kind: "page"; tab: PopupTab };

type NoticeKey =
  | "pageActionFailed"
  | "subtitleTaskActionFailed"
  | "settingsSaveFailed"
  | "openSettingsFailed";

function isSuccessfulAction(value: unknown): value is { ok: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
}

export function isUpdateStatus(value: unknown): value is ExtensionUpdateStatus {
  return (
    isSuccessfulAction(value) &&
    "state" in value &&
    typeof value.state === "string" &&
    ["never", "current", "available", "ignored", "error"].includes(
      value.state,
    ) &&
    "currentVersion" in value &&
    typeof value.currentVersion === "string" &&
    "autoCheckEnabled" in value &&
    typeof value.autoCheckEnabled === "boolean"
  );
}

/**
 * Toolbar popup: two task status cards (page, video), the update notice and
 * two quick switches. Language and method forms live in the floating control
 * and the settings page. Every change applies immediately.
 */
export class PopupApp {
  private settings: AppSettings;
  private target: Target = { kind: "loading" };
  /** True once the active tab's content scripts were confirmed. */
  private contentReady = false;
  private pageStatus: PageStatus | undefined;
  private subtitleStatus: SubtitleStatus | undefined;
  private update: ExtensionUpdateStatus | undefined;
  private notice: NoticeKey | undefined;
  private siteBusy = false;
  private siteRequested: boolean | undefined;
  private floatingBusy = false;
  private refreshing = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly page: TaskCardState;
  private readonly subtitle: TaskCardState;
  private readonly onStorageChange = (
    changes: Record<string, Browser.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local" || !changes.settings) return;
    void loadSettings()
      .then((next) => {
        if (next.uiLanguage !== this.settings.uiLanguage) {
          window.location.reload();
          return;
        }
        this.settings = next;
        this.render();
      })
      .catch(() => this.showNotice("settingsSaveFailed"));
  };

  constructor(
    private readonly root: HTMLElement,
    settings: AppSettings,
    options: { pendingGraceMs?: number } = {},
  ) {
    this.settings = settings;
    this.page = new TaskCardState(() => this.render(), options.pendingGraceMs);
    this.subtitle = new TaskCardState(
      () => this.render(),
      options.pendingGraceMs,
    );
  }

  async start(refreshMs = POPUP_REFRESH_MS): Promise<void> {
    browser.storage.onChanged.addListener(this.onStorageChange);
    this.render();
    await Promise.all([this.loadUpdateStatus(), this.refresh()]);
    if (refreshMs > 0) {
      this.timer = setInterval(() => void this.refresh(), refreshMs);
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    browser.storage.onChanged.removeListener(this.onStorageChange);
    this.page.dispose();
    this.subtitle.dispose();
  }

  /** Re-reads the active tab and both task statuses. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const tab = await activePopupTab().catch(() => null);
      if (!tab || tab.restricted) {
        this.setRestricted();
        return;
      }
      if (!this.contentReady || this.target.kind !== "page") {
        this.contentReady = await ensureTabContent(tab.id);
      }
      const [page, subtitle] = this.contentReady
        ? await Promise.all([
            queryTopFrame(tab.id, "PAGE_STATUS"),
            queryTopFrame(tab.id, "SUBTITLE_STATUS"),
          ])
        : [undefined, undefined];
      if (!isPageStatusValue(page)) {
        // The content script did not answer: re-inject on the next refresh.
        this.contentReady = false;
        this.setRestricted();
        return;
      }
      this.target = { kind: "page", tab };
      this.pageStatus = page;
      this.subtitleStatus = isSubtitleStatusValue(subtitle)
        ? subtitle
        : undefined;
      this.page.observe(pageStatusKind(page));
      if (this.subtitleStatus) {
        this.subtitle.observe(
          subtitleStatusKind(this.subtitleStatus, this.subtitleContext()),
        );
      }
    } finally {
      this.refreshing = false;
      this.render();
    }
  }

  private setRestricted(): void {
    this.target = { kind: "restricted" };
    this.pageStatus = undefined;
    this.subtitleStatus = undefined;
  }

  private async loadUpdateStatus(): Promise<void> {
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "UPDATE_STATUS_GET",
      });
      if (isUpdateStatus(response)) this.update = response;
    } catch {
      // The notice is optional; a failed check simply shows nothing.
    }
  }

  private subtitleContext(): { featureEnabled: boolean } {
    return { featureEnabled: this.settings.subtitles.enabled };
  }

  pageView(): StatusView | undefined {
    if (!this.pageStatus) return undefined;
    return this.page.decorate(
      pageStatusView(this.pageStatus, this.page.context()),
    );
  }

  subtitleView(): StatusView | undefined {
    // A switched-off feature needs no detection result to be shown as off.
    const status =
      this.subtitleStatus ??
      (this.settings.subtitles.enabled
        ? undefined
        : { state: "disabled" as const, total: 0, completed: 0, failed: 0 });
    if (!status) return undefined;
    return this.subtitle.decorate(
      subtitleStatusView(status, {
        ...this.subtitleContext(),
        ...this.subtitle.context(),
      }),
    );
  }

  private tabId(): number | undefined {
    return this.target.kind === "page" ? this.target.tab.id : undefined;
  }

  private showNotice(key: NoticeKey): void {
    this.notice = key;
    this.render();
  }

  private async command(
    command: PopupTabCommand,
    prepare: boolean,
  ): Promise<void> {
    const tabId = this.tabId();
    if (tabId === undefined) throw new Error("popup_no_tab");
    // Commands that start work may need freshly injected frames.
    if (prepare && !(await ensureTabContent(tabId))) {
      throw new Error("popup_content_unavailable");
    }
    await sendTabCommand(tabId, command);
  }

  /**
   * Writes a field-level change with `SETTINGS_PATCH` (the popup is an
   * accepted extension-page sender). The background applies it to the
   * latest stored settings, so concurrent edits to other fields survive.
   */
  private async patchSettings(patch: SettingsPatch): Promise<void> {
    const response: unknown = await browser.runtime.sendMessage({
      type: "SETTINGS_PATCH",
      patch,
    });
    if (!isSettingsPatchResponse(response) || !response.ok) {
      throw new Error("settings_save_failed");
    }
    // The response omits credentials; the popup never shows them anyway.
    this.settings = mergeSettings({
      ...response.settings,
      provider: { ...this.settings.provider, ...response.settings.provider },
    });
  }

  async runPageAction(action: StatusAction): Promise<void> {
    const status = this.pageStatus;
    if (!status || action.disabled || action.busy) return;
    this.notice = undefined;
    const baseline = pageStatusKind(status);
    const run = (
      label: "starting" | "stopping" | "retrying" | "resuming" | undefined,
      request: () => Promise<void>,
    ) =>
      this.page.tracker.run(
        { id: action.id, ...(label ? { label } : {}), baseline },
        request,
      );
    let result: "done" | "failed" | "busy";
    switch (action.id) {
      case "translate":
        result = await run("starting", () =>
          this.command("PAGE_TRANSLATE", true),
        );
        break;
      case "resume":
        // "Continue" re-runs the page task; finished blocks stay translated.
        result = await run("resuming", () =>
          this.command("PAGE_TRANSLATE", true),
        );
        break;
      case "stop":
        result = await run("stopping", () =>
          this.command("PAGE_CANCEL", false),
        );
        break;
      case "retry":
        this.page.beginRetry(status.completed, status.failed);
        result = await run("retrying", () =>
          this.command("PAGE_RETRY_FAILED", true),
        );
        if (result === "failed") this.page.cancelRetry();
        break;
      case "restore":
        result = await run(undefined, () =>
          this.command("PAGE_RESTORE", false),
        );
        break;
      case "openProviderSettings":
        await this.openOptions("providers");
        return;
      default:
        return;
    }
    if (result === "failed") this.showNotice("pageActionFailed");
    void this.refresh();
  }

  async runSubtitleAction(action: StatusAction): Promise<void> {
    const status = this.subtitleStatus ?? {
      state: "disabled" as const,
      total: 0,
      completed: 0,
      failed: 0,
    };
    if (action.disabled || action.busy) return;
    this.notice = undefined;
    const baseline = subtitleStatusKind(status, this.subtitleContext());
    const run = (
      label: "starting" | "stopping" | "retrying" | "resuming" | undefined,
      request: () => Promise<void>,
    ) =>
      this.subtitle.tracker.run(
        { id: action.id, ...(label ? { label } : {}), baseline },
        request,
      );
    const setEnabled = (enabled: boolean) => () =>
      this.patchSettings({ subtitles: { enabled } });
    let result: "done" | "failed" | "busy";
    switch (action.id) {
      case "enable":
        result =
          baseline === "disabled"
            ? await run("starting", setEnabled(true))
            : // Idle, or a task-level error without failed cues: start again.
              await run("starting", () => this.command("SUBTITLE_START", true));
        break;
      case "rescan":
        // Discovery ended empty: ask the page to scan for subtitles again.
        result = await run(undefined, () =>
          this.command("SUBTITLE_START", true),
        );
        break;
      case "disable":
        result = await run(undefined, setEnabled(false));
        break;
      case "stop":
        result = await run("stopping", () =>
          this.command("SUBTITLE_CANCEL", false),
        );
        break;
      case "resume":
        // Translated cues come back from the cache.
        result = await run("resuming", () =>
          this.command("SUBTITLE_START", true),
        );
        break;
      case "retry":
        this.subtitle.beginRetry(status.completed, status.failed);
        result = await run("retrying", () =>
          this.command("SUBTITLE_RETRY_FAILED", true),
        );
        if (result === "failed") this.subtitle.cancelRetry();
        break;
      case "openProviderSettings":
        await this.openOptions("providers");
        return;
      default:
        return;
    }
    if (result === "failed") {
      const settingChange =
        action.id === "disable" ||
        (action.id === "enable" && baseline === "disabled");
      this.showNotice(
        settingChange ? "settingsSaveFailed" : "subtitleTaskActionFailed",
      );
    }
    void this.refresh();
  }

  async setSiteAutoTranslate(enabled: boolean): Promise<void> {
    const hostname =
      this.target.kind === "page" ? this.target.tab.hostname : undefined;
    const pattern = hostname
      ? autoTranslateSitePatternForHostname(hostname)
      : null;
    if (!pattern || this.siteBusy) return;
    this.notice = undefined;
    this.siteBusy = true;
    this.siteRequested = enabled;
    this.render();
    try {
      // The rule lists are one field each; derive them from fresh storage
      // so a rule added elsewhere since the popup opened is kept.
      const current = await loadSettings();
      await this.patchSettings({
        page: updateSiteAutoTranslateRules(current.page, pattern, enabled),
      });
      // Same as the floating control: enabling also starts this page now.
      if (enabled) {
        await this.command("PAGE_AUTO_TRANSLATE_CURRENT", true).catch(() =>
          this.showNotice("pageActionFailed"),
        );
      }
    } catch {
      this.showNotice("settingsSaveFailed");
    } finally {
      this.siteBusy = false;
      this.siteRequested = undefined;
      this.render();
    }
  }

  async setFloatingVisible(enabled: boolean): Promise<void> {
    if (this.floatingBusy) return;
    this.notice = undefined;
    this.floatingBusy = true;
    this.render();
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "FLOATING_BUTTON_SET",
        surface: "all",
        enabled,
      });
      if (!isSuccessfulAction(response)) {
        throw new Error("settings_save_failed");
      }
      this.settings = {
        ...this.settings,
        page: { ...this.settings.page, floatingButtonEnabled: enabled },
        subtitles: {
          ...this.settings.subtitles,
          floatingButtonEnabled: enabled,
        },
      };
      // Turning it on also brings back a control hidden on this page only.
      const tabId = this.tabId();
      if (enabled && tabId !== undefined) {
        await browser.tabs
          .sendMessage(tabId, { type: "FLOATING_SESSION_SHOW" }, { frameId: 0 })
          .catch(() => undefined);
      }
    } catch {
      this.showNotice("settingsSaveFailed");
    } finally {
      this.floatingBusy = false;
      this.render();
    }
  }

  async openOptions(section?: "providers"): Promise<void> {
    try {
      if (section) {
        await browser.tabs.create({
          url: browser.runtime.getURL(`/options.html#${section}`),
        });
      } else {
        await browser.runtime.openOptionsPage();
      }
    } catch {
      this.showNotice("openSettingsFailed");
    }
  }

  private async ignoreUpdate(version: string): Promise<void> {
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "UPDATE_IGNORE",
        version,
      });
      if (isUpdateStatus(response)) this.update = response;
    } catch {
      // Keep the notice; the user can ignore it again.
    }
    this.render();
  }

  render(): void {
    const loading = this.target.kind === "loading";
    this.root.setAttribute("aria-busy", String(loading));
    render(this.template(), this.root);
  }

  private template(): TemplateResult {
    return html`<header class="hd">
        <div class="ttl">
          <span class="logo" aria-hidden="true">${icon("translate")}</span>
          <h1>${message("extensionName")}</h1>
        </div>
        <nt-icon-button
          id="open-options"
          icon="settings"
          label=${message("openSettings")}
          @click=${() => void this.openOptions()}
        ></nt-icon-button>
      </header>
      <div class="body">${this.bodyTemplate()}</div>`;
  }

  private bodyTemplate(): TemplateResult {
    const notice = this.notice
      ? html`<p class="notice" role="alert">${message(this.notice)}</p>`
      : nothing;
    if (this.target.kind === "loading") {
      return html`<nt-status-card
          data-card="loading"
          state="scanning"
          heading=${message("statusLoading")}
          quiet
        ></nt-status-card
        >${this.updateTemplate()}`;
    }
    if (this.target.kind === "restricted") {
      const view = pageStatusView(RESTRICTED_PAGE_STATUS);
      return html`${this.cardTemplate("page", view)}${this.updateTemplate()}${notice}`;
    }
    return html`<section class="sec" aria-labelledby="page-heading">
        <div class="sec-hd">
          <h2 id="page-heading">${message("pageTranslation")}</h2>
          <button
            type="button"
            class="link"
            data-link="page-settings"
            @click=${() => void this.openOptions()}
          >
            ${message("popupPageSettingsLink")}
          </button>
        </div>
        ${this.taskCard("page")}
      </section>
      <section class="sec" aria-labelledby="video-heading">
        <div class="sec-hd">
          <h2 id="video-heading">${message("subtitleTranslation")}</h2>
          <button
            type="button"
            class="link"
            data-link="video-settings"
            @click=${() => void this.openOptions()}
          >
            ${message("popupVideoSettingsLink")}
          </button>
        </div>
        ${this.taskCard("subtitle")}
      </section>
      ${this.updateTemplate()}${notice}${this.switchesTemplate()}`;
  }

  private taskCard(task: "page" | "subtitle"): TemplateResult {
    const view = task === "page" ? this.pageView() : this.subtitleView();
    if (!view) {
      return html`<nt-status-card
        data-card=${task}
        state="unavailable"
        heading=${message("statusLoading")}
        quiet
      ></nt-status-card>`;
    }
    return this.cardTemplate(task, view);
  }

  private cardTemplate(
    task: "page" | "subtitle",
    view: StatusView,
  ): TemplateResult {
    const title = localize(view.title);
    const description = [view.reason, view.progressNote]
      .filter((text) => text !== undefined)
      .map((text) => localize(text));
    if (view.kind === "disabled" && task === "subtitle") {
      description.push(message("popupSubtitleDisabledHint"));
    }
    const details = view.diagnostics.details
      ?.trim()
      .slice(0, MAX_DETAILS_LENGTH);
    // A live track has no meaningful total, so its bar stays indeterminate.
    const progress =
      view.tracks.includes("stream") && !view.retrying
        ? null
        : progressValue(view);
    const run = (action: StatusAction): void => {
      void (task === "page"
        ? this.runPageAction(action)
        : this.runSubtitleAction(action));
    };
    const button = (action: StatusAction, primary: boolean) =>
      html`<nt-button
        slot="actions"
        data-action=${action.id}
        data-primary=${String(primary)}
        variant=${primary ? primaryVariant(action.id) : "ghost"}
        size=${primary ? "lg" : "md"}
        ?block=${primary}
        ?busy=${action.busy}
        ?disabled=${action.disabled}
        @click=${() => run(action)}
        >${localize(action.label)}</nt-button
      >`;
    return html`<nt-status-card
      data-card=${task}
      data-kind=${view.kind}
      state=${visualState(view)}
      heading=${title}
      description=${description.join(" ")}
      .progress=${progress}
      progress-label=${title}
      ?show-progress=${view.retrying}
      ?quiet=${view.kind === "translating"}
    >
      ${view.tracks.map((tag) => {
        const chip = TRACK_CHIPS[tag];
        return html`<nt-chip slot="meta" data-track=${tag} tone=${chip.tone}
          >${message(chip.key)}</nt-chip
        >`;
      })}
      ${view.primaryAction ? button(view.primaryAction, true) : nothing}
      ${view.secondaryActions.map((action) => button(action, false))}
      ${
        details
          ? html`<details slot="details" class="diag">
              <summary>${message("viewProviderDetails")}</summary>
              <pre aria-label=${message("providerDetailsLabel")}>
${details}</pre>
            </details>`
          : nothing
      }
    </nt-status-card>`;
  }

  private updateTemplate(): TemplateResult | typeof nothing {
    const status = this.update;
    if (
      status?.state !== "available" ||
      !status.latestVersion ||
      !status.releaseUrl
    ) {
      return nothing;
    }
    const { latestVersion, releaseUrl } = status;
    return html`<aside class="update" data-update=${latestVersion}>
      <span class="update-icon" aria-hidden="true">${icon("refresh")}</span>
      <strong class="update-title"
        >${message("updateAvailableTitle", latestVersion)}</strong
      >
      <span class="update-actions">
        <button
          type="button"
          class="link"
          data-update-action="view"
          @click=${() => void browser.tabs.create({ url: releaseUrl })}
        >
          ${message("updateViewRelease")}
        </button>
        <button
          type="button"
          class="link muted"
          data-update-action="ignore"
          @click=${() => void this.ignoreUpdate(latestVersion)}
        >
          ${message("updateIgnoreVersion")}
        </button>
      </span>
    </aside>`;
  }

  private switchesTemplate(): TemplateResult {
    const hostname =
      this.target.kind === "page" ? this.target.tab.hostname : undefined;
    const pattern = hostname
      ? autoTranslateSitePatternForHostname(hostname)
      : null;
    const floatingVisible =
      this.settings.page.floatingButtonEnabled ||
      this.settings.subtitles.floatingButtonEnabled;
    const checkedOf = (event: Event): boolean =>
      (event as CustomEvent<{ checked?: unknown }>).detail?.checked === true;
    return html`<div class="tile">
      ${
        hostname && pattern
          ? html`<nt-switch
              data-switch="auto-translate"
              label=${message("pageAutoTranslateCurrentSite")}
              description=${pattern}
              .checked=${live(
                this.siteRequested ??
                  isSiteAutoTranslateEnabled(this.settings.page, hostname),
              )}
              ?disabled=${this.siteBusy}
              @change=${(event: Event) =>
                void this.setSiteAutoTranslate(checkedOf(event))}
            ></nt-switch>`
          : nothing
      }
      <nt-switch
        data-switch="floating"
        label=${message("floatingControlEnabled")}
        description=${message("popupFloatingControlScope")}
        .checked=${live(floatingVisible)}
        ?disabled=${this.floatingBusy}
        @change=${(event: Event) =>
          void this.setFloatingVisible(checkedOf(event))}
      ></nt-switch>
    </div>`;
  }
}
