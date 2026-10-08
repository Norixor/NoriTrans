import type { PageStatus } from "@/src/messaging/protocol";
import {
  isSiteAutoTranslateEnabled,
  autoTranslateSitePatternForHostname,
} from "@/src/shared/auto-translate-sites";
import { message } from "@/src/shared/i18n";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "@/src/shared/languages";
import type {
  ContentSettings,
  DisplayMode,
  FastProviderId,
  PageSettings,
} from "@/src/shared/settings";
import {
  parseTranslationMethod,
  translationMethodValue,
} from "@/src/shared/translation-methods";
import type { PageSettingsPatch, FloatingControlCallbacks } from "./callbacks";
import type { TranslationResponseMode } from "@/src/translation/types";
import type { NtSegmentOption, NtSelectOption } from "@/src/ui/components";
import {
  pageStatusKind,
  pageStatusView,
  type StatusAction,
  type StatusView,
  type StatusViewContext,
} from "@/src/ui/status";
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import {
  languageLabel,
  languageOptions,
  methodLabel,
  methodOptions,
  pairAvailable,
  type LanguageProviderId,
} from "./options";
import { PendingActionTracker, type PendingRunResult } from "./pending";
import type {
  FloatingPanelSection,
  FloatingTab,
  FloatingTabContext,
} from "./tab";
import {
  localize,
  primaryVariant,
  progressValue,
  visualState,
  withLocalPending,
} from "./view";

export type PageTabCallbacks = Pick<
  FloatingControlCallbacks,
  | "onPageTranslate"
  | "onPageRetryFailed"
  | "onPageCancel"
  | "onPageRestore"
  | "onAutoTranslateChange"
  | "onPageSettingsChange"
  | "onPageModeChange"
  | "onPageResponseModeChange"
>;

/** Notice shown under the status card after a failed request. */
export type PageTabNotice =
  "pageActionFailed" | "settingsSaveFailed" | "floatingPairUnavailable";

interface PendingSettings {
  revision: number;
  patch: Partial<PageSettings>;
}

/** Diagnostics stay bounded like the previous control. */
const MAX_DETAILS_LENGTH = 4_000;

const ACTIONS_NEEDING_PAIR = new Set<StatusAction["id"]>([
  "translate",
  "resume",
  "retry",
]);

/**
 * Web page tab: status card with the single primary action, a one-line
 * settings summary and, behind "Change", the inline page settings. Settings
 * apply immediately through the existing `on*Change` callbacks; while one is
 * in flight the controls are disabled and show the requested value, and a
 * failure reverts them and shows a notice. Page-level blocks such as image
 * translation are appended through `addSection()`.
 */
export class PageTab implements FloatingTab {
  readonly id = "page" as const;

  private status: PageStatus = {
    state: "idle",
    total: 0,
    completed: 0,
    failed: 0,
  };
  private settings: ContentSettings;
  private settingsRevision = 0;
  private pendingSettings: PendingSettings | undefined;
  private autoTranslateBusy = false;
  /** Requested switch value until settings confirm it (or the call fails). */
  private autoTranslateRequested: boolean | undefined;
  private editing = false;
  private notice: PageTabNotice | undefined;
  private retry: StatusViewContext["retry"];
  private retrySawTranslating = false;
  private readonly tracker: PendingActionTracker;
  private readonly sections: FloatingPanelSection[] = [];

  constructor(
    private readonly callbacks: PageTabCallbacks,
    settings: ContentSettings,
    private readonly context: FloatingTabContext,
  ) {
    this.settings = settings;
    this.tracker = new PendingActionTracker(() => context.requestRender());
  }

  label(): string {
    return message("pageTranslationTab");
  }

  /** True while the settings editor is expanded (for tests and the shell). */
  get settingsExpanded(): boolean {
    return this.editing;
  }

  updateSettings(settings: ContentSettings): void {
    this.settingsRevision += 1;
    this.settings = settings;
    if (!this.autoTranslateBusy) this.autoTranslateRequested = undefined;
    for (const section of this.sections) section.updateSettings?.(settings);
    this.context.requestRender();
  }

  /** Registers a block rendered after the tab's own content. */
  addSection(section: FloatingPanelSection): void {
    this.sections.push(section);
    this.context.requestRender();
  }

  updateStatus(status: PageStatus): void {
    const previousKind = pageStatusKind(this.status);
    this.status = status;
    const kind = pageStatusKind(status);
    if (kind !== previousKind) this.notice = undefined;
    this.tracker.observe(kind);
    if (this.retry) {
      if (kind === "translating") this.retrySawTranslating = true;
      else if (this.retrySawTranslating || !this.tracker.current) {
        this.retry = undefined;
        this.retrySawTranslating = false;
      }
    }
    this.context.requestRender();
  }

  statusView(): StatusView {
    const pending = this.tracker.current;
    let view = pageStatusView(this.status, {
      ...(pending?.label ? { pending: pending.label } : {}),
      ...(this.retry ? { retry: this.retry } : {}),
    });
    if (pending && !pending.label) view = withLocalPending(view, pending.id);
    if (!this.currentPairAvailable()) {
      const block = (action: StatusAction): StatusAction =>
        ACTIONS_NEEDING_PAIR.has(action.id)
          ? { ...action, disabled: true }
          : action;
      view = {
        ...view,
        ...(view.primaryAction
          ? { primaryAction: block(view.primaryAction) }
          : {}),
        secondaryActions: view.secondaryActions.map(block),
      };
    }
    return view;
  }

  /** Runs a status-card action; resolves with the request outcome. */
  async runAction(action: StatusAction): Promise<PendingRunResult | "ignored"> {
    if (action.disabled || action.busy) return "ignored";
    const baseline = pageStatusKind(this.status);
    const cb = this.callbacks;
    let result: PendingRunResult;
    switch (action.id) {
      case "translate":
        result = await this.tracker.run(
          { id: "translate", label: "starting", baseline },
          () => cb.onPageTranslate(),
        );
        break;
      case "resume":
        // "Continue" re-runs the page task; finished blocks stay translated.
        result = await this.tracker.run(
          { id: "resume", label: "resuming", baseline },
          () => cb.onPageTranslate(),
        );
        break;
      case "stop":
        result = await this.tracker.run(
          { id: "stop", label: "stopping", baseline },
          () => (cb.onPageCancel ?? cb.onPageRestore)(),
        );
        break;
      case "retry": {
        if (this.status.failed > 0) {
          this.retry = {
            completedAtStart: this.status.completed,
            count: this.status.failed,
          };
          this.retrySawTranslating = false;
        }
        result = await this.tracker.run(
          { id: "retry", label: "retrying", baseline },
          () => (cb.onPageRetryFailed ?? cb.onPageTranslate)(),
        );
        if (result === "failed") this.retry = undefined;
        break;
      }
      case "restore":
        result = await this.tracker.run({ id: "restore", baseline }, () =>
          cb.onPageRestore(),
        );
        break;
      case "switchDisplay": {
        const next: DisplayMode =
          this.effectivePage().displayMode === "bilingual"
            ? "translated"
            : "bilingual";
        await this.changePageSettings({ displayMode: next });
        return "done";
      }
      case "openProviderSettings":
        this.context.openSettings("providers");
        return "done";
      default:
        return "ignored";
    }
    if (result === "failed") {
      this.notice = "pageActionFailed";
      this.context.requestRender();
    }
    return result;
  }

  toggleEditing(): void {
    this.editing = !this.editing;
    this.context.requestRender();
  }

  /** Closes the inline editor, else lets a section close; true if consumed. */
  handleEscape(): boolean {
    if (!this.editing) {
      return this.sections.some(
        (section) => section.visible() && section.handleEscape?.() === true,
      );
    }
    this.editing = false;
    this.context.requestRender();
    return true;
  }

  dispose(): void {
    this.tracker.dispose();
    for (const section of this.sections) section.dispose?.();
  }

  // --- settings -----------------------------------------------------------

  private effectivePage(): PageSettings {
    return { ...this.settings.page, ...this.pendingSettings?.patch };
  }

  private fastProvider(page = this.effectivePage()): FastProviderId {
    return page.fastProviderOverride ?? this.settings.provider.fastProvider;
  }

  private provider(page = this.effectivePage()): LanguageProviderId {
    return page.mode === "ai"
      ? this.settings.provider.aiProvider
      : this.fastProvider(page);
  }

  private currentPairAvailable(): boolean {
    const page = this.effectivePage();
    return pairAvailable(
      this.provider(page),
      page.sourceLanguage,
      page.targetLanguage,
      this.context.capabilities(),
    );
  }

  /** Applies `patch` optimistically while `request` runs. */
  private async applySettings(
    patch: Partial<PageSettings>,
    request: () => Promise<void> | void,
  ): Promise<boolean> {
    if (this.pendingSettings) return false;
    const pending: PendingSettings = { revision: this.settingsRevision, patch };
    this.pendingSettings = pending;
    this.notice = undefined;
    this.context.requestRender();
    let succeeded = false;
    try {
      await request();
      succeeded = true;
    } catch {
      this.notice = "settingsSaveFailed";
    }
    if (this.pendingSettings === pending) {
      // A newer `updateSettings()` already carries the saved values.
      if (succeeded && this.settingsRevision === pending.revision) {
        this.settings = {
          ...this.settings,
          page: { ...this.settings.page, ...pending.patch },
        };
      }
      this.pendingSettings = undefined;
    }
    this.context.requestRender();
    return succeeded;
  }

  /** Languages and display go through `onPageSettingsChange` as one patch. */
  private changePageSettings(
    change: Partial<
      Pick<
        PageSettingsPatch,
        "sourceLanguage" | "targetLanguage" | "displayMode"
      >
    >,
  ): Promise<boolean> {
    const page = this.effectivePage();
    const patch: PageSettingsPatch = {
      sourceLanguage: page.sourceLanguage,
      targetLanguage: page.targetLanguage,
      displayMode: page.displayMode,
      // Selection translation is edited on the options page; keep it as is.
      selectionTranslationEnabled: page.selectionTranslationEnabled,
      selectionTranslationMode: page.selectionTranslationMode,
      ...change,
    };
    // Re-send the page's own fast provider only; never change it from here.
    const fastProvider =
      page.mode === "fast" ? this.fastProvider(page) : undefined;
    return this.applySettings(patch, () =>
      fastProvider
        ? this.callbacks.onPageSettingsChange(patch, fastProvider)
        : this.callbacks.onPageSettingsChange(patch),
    );
  }

  private changeLanguage(role: "source" | "target", value: string): void {
    const list = role === "source" ? SOURCE_LANGUAGES : TARGET_LANGUAGES;
    if (!list.some((language) => language.code === value)) return;
    void this.changePageSettings(
      role === "source" ? { sourceLanguage: value } : { targetLanguage: value },
    );
  }

  private changeDisplay(value: string): void {
    if (value !== "translated" && value !== "bilingual") return;
    if (value === this.effectivePage().displayMode) return;
    void this.changePageSettings({ displayMode: value });
  }

  private changeMethod(value: string): void {
    const method = parseTranslationMethod(value);
    if (!method) return;
    const patch: Partial<PageSettings> = {
      mode: method.mode,
      ...(method.fastProvider
        ? { fastProviderOverride: method.fastProvider }
        : {}),
    };
    void this.applySettings(patch, () =>
      method.fastProvider
        ? this.callbacks.onPageModeChange(method.mode, method.fastProvider)
        : this.callbacks.onPageModeChange(method.mode),
    );
  }

  private changeResponseMode(value: string): void {
    if (value !== "stream" && value !== "batch") return;
    if (this.effectivePage().mode !== "ai") return;
    const mode: TranslationResponseMode = value;
    void this.applySettings({ aiResponseMode: mode }, () =>
      this.callbacks.onPageResponseModeChange(mode),
    );
  }

  private async changeAutoTranslate(enabled: boolean): Promise<void> {
    if (this.autoTranslateBusy) return;
    this.autoTranslateBusy = true;
    this.autoTranslateRequested = enabled;
    this.notice = undefined;
    this.context.requestRender();
    try {
      await this.callbacks.onAutoTranslateChange(enabled);
    } catch {
      this.autoTranslateRequested = undefined;
      this.notice = "settingsSaveFailed";
    } finally {
      this.autoTranslateBusy = false;
      this.context.requestRender();
    }
  }

  // --- rendering ----------------------------------------------------------

  render(): TemplateResult {
    const view = this.statusView();
    const notice =
      this.notice ??
      (this.currentPairAvailable() ? undefined : "floatingPairUnavailable");
    return html`<div class="tab-body" data-tab="page">
      ${this.renderCard(view)}
      ${
        notice
          ? html`<nt-note class="notice" tone="warn" icon="warning"
              >${message(notice)}</nt-note
            >`
          : nothing
      }
      <nt-quick-line
        class="summary"
        action-label=${message(
          this.editing ? "floatingSettingsDone" : "floatingSettingsChange",
        )}
        expanded=${String(this.editing)}
        @nt-action=${() => this.toggleEditing()}
        >${this.renderSummary()}</nt-quick-line
      >
      ${this.editing ? this.renderEditor() : nothing}
      ${this.sections.map((section) =>
        section.visible()
          ? html`<div class="section" data-section=${section.id}>
              ${section.render()}
            </div>`
          : nothing,
      )}
    </div>`;
  }

  private renderCard(view: StatusView): TemplateResult {
    const title = localize(view.title);
    const description = [view.reason, view.progressNote]
      .filter((text) => text !== undefined)
      .map((text) => localize(text))
      .join(" ");
    const details = view.diagnostics.details
      ?.trim()
      .slice(0, MAX_DETAILS_LENGTH);
    return html`<nt-status-card
      class="status"
      state=${visualState(view)}
      heading=${title}
      description=${description}
      .progress=${progressValue(view)}
      progress-label=${title}
      ?show-progress=${view.retrying}
      ?quiet=${view.kind === "translating"}
    >
      ${
        view.primaryAction
          ? this.renderAction(
              view.primaryAction,
              primaryVariant(view.primaryAction.id),
              true,
            )
          : nothing
      }
      ${view.secondaryActions.map((action) =>
        this.renderAction(action, "ghost", false),
      )}
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

  private renderAction(
    action: StatusAction,
    variant: string,
    primary: boolean,
  ): TemplateResult {
    return html`<nt-button
      slot="actions"
      data-action=${action.id}
      data-primary=${String(primary)}
      variant=${variant}
      size=${primary ? "lg" : "md"}
      ?block=${primary}
      ?busy=${action.busy}
      ?disabled=${action.disabled}
      @click=${() => void this.runAction(action)}
      >${localize(action.label)}</nt-button
    >`;
  }

  private renderSummary(): TemplateResult {
    const page = this.effectivePage();
    return html`<span class="summary-text"
      >${languageLabel(page.sourceLanguage)} →
      <b>${languageLabel(page.targetLanguage)}</b> ·
      <b>${methodLabel(page.mode, this.fastProvider(page))}</b> ·
      ${message(
        page.displayMode === "bilingual"
          ? "pageDisplayAppend"
          : "pageDisplayReplace",
      )}</span
    >`;
  }

  private renderEditor(): TemplateResult {
    const page = this.effectivePage();
    const provider = this.provider(page);
    const snapshot = this.context.capabilities();
    const busy = this.pendingSettings !== undefined;
    const responseOptions: NtSelectOption[] = [
      { value: "stream", label: message("responseModeStream") },
      { value: "batch", label: message("responseModeBatch") },
    ];
    const displayOptions: NtSegmentOption[] = [
      { value: "bilingual", label: message("pageDisplayAppend") },
      { value: "translated", label: message("pageDisplayReplace") },
    ];
    const hostname = this.context.hostname();
    const pattern = autoTranslateSitePatternForHostname(hostname) ?? hostname;
    const valueOf = (event: Event): string => {
      const value = (event as CustomEvent<{ value?: unknown }>).detail?.value;
      return typeof value === "string" ? value : "";
    };
    return html`<div
      class="editor"
      role="group"
      aria-label=${message("floatingPageSettings")}
    >
      <div class="row">
        <nt-select
          compact
          data-field="source"
          label=${message("sourceLanguage")}
          .options=${languageOptions("source", provider, page.sourceLanguage, snapshot)}
          .value=${live(page.sourceLanguage)}
          ?disabled=${busy}
          @change=${(event: Event) =>
            this.changeLanguage("source", valueOf(event))}
        ></nt-select>
        <nt-select
          compact
          data-field="target"
          label=${message("targetLanguage")}
          .options=${languageOptions("target", provider, page.targetLanguage, snapshot)}
          .value=${live(page.targetLanguage)}
          ?disabled=${busy}
          @change=${(event: Event) =>
            this.changeLanguage("target", valueOf(event))}
        ></nt-select>
      </div>
      <nt-select
        compact
        data-field="method"
        label=${message("translationMode")}
        .options=${methodOptions()}
        .value=${live(
          translationMethodValue(page.mode, this.fastProvider(page)),
        )}
        ?disabled=${busy}
        @change=${(event: Event) => this.changeMethod(valueOf(event))}
      ></nt-select>
      ${
        page.mode === "ai"
          ? html`<nt-select
              compact
              data-field="response"
              label=${message("aiResponseMode")}
              .options=${responseOptions}
              .value=${live(page.aiResponseMode)}
              ?disabled=${busy}
              @change=${(event: Event) =>
                this.changeResponseMode(valueOf(event))}
            ></nt-select>`
          : nothing
      }
      <nt-segmented
        data-field="display"
        label=${message("displayMode")}
        .options=${displayOptions}
        .value=${live(page.displayMode)}
        ?disabled=${busy}
        @change=${(event: Event) => this.changeDisplay(valueOf(event))}
      ></nt-segmented>
      <nt-switch
        compact
        data-field="auto"
        label=${message("pageAutoTranslateCurrentSite")}
        description=${pattern}
        .checked=${live(
          this.autoTranslateRequested ??
            isSiteAutoTranslateEnabled(page, hostname),
        )}
        ?disabled=${busy || this.autoTranslateBusy}
        @change=${(event: Event) =>
          void this.changeAutoTranslate(
            Boolean(
              (event as CustomEvent<{ checked?: unknown }>).detail?.checked,
            ),
          )}
      ></nt-switch>
    </div>`;
  }
}
