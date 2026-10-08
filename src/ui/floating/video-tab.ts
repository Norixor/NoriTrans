import type { SubtitleStatus } from "@/src/messaging/protocol";
import { message } from "@/src/shared/i18n";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "@/src/shared/languages";
import type {
  ContentSettings,
  FastProviderId,
  SubtitleDisplayMode,
  SubtitlePosition,
  SubtitleSettings,
} from "@/src/shared/settings";
import {
  parseTranslationMethod,
  translationMethodValue,
} from "@/src/shared/translation-methods";
import type {
  SubtitleSettingsPatch,
  FloatingControlCallbacks,
} from "./callbacks";
import type { TranslationResponseMode } from "@/src/translation/types";
import type {
  NtChipTone,
  NtSegmentOption,
  NtSelectOption,
} from "@/src/ui/components";
import {
  resolveReason,
  subtitleStatusKind,
  subtitleStatusView,
  type StatusAction,
  type StatusKind,
  type StatusView,
  type StatusViewContext,
  type SubtitleTrackTag,
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

/** Presets the floating control can pick; `custom` is set by dragging. */
export type SubtitlePositionPreset = Exclude<SubtitlePosition, "custom">;

/**
 * Subtitle callbacks the previous control did not have. All optional: when a
 * host leaves one out, the matching control is hidden (or falls back as
 * documented) instead of offering an action that cannot work.
 */
export interface VideoTabExtraCallbacks {
  /** Re-queues only failed cues; falls back to `onSubtitleStart`. */
  onSubtitleRetryFailed?(): Promise<void> | void;
  /**
   * Switches subtitle translation on or off (`subtitles.enabled`). Without
   * it the tab shows no switch, "Turn on" opens the options page and the
   * "Turn off subtitle translation" actions are not offered.
   */
  onSubtitleEnabledChange?(enabled: boolean): Promise<void> | void;
  /** Saves a subtitle position preset; without it the field is hidden. */
  onSubtitlePositionChange?(
    position: SubtitlePositionPreset,
  ): Promise<void> | void;
}

export type VideoTabCallbacks = Pick<
  FloatingControlCallbacks,
  | "onSubtitleSettingsChange"
  | "onSubtitleStart"
  | "onSubtitleCancel"
  | "onCreateProfile"
> &
  VideoTabExtraCallbacks;

/** Notice shown under the status card after a failed request. */
export type VideoTabNotice =
  "subtitleTaskActionFailed" | "settingsSaveFailed" | "floatingPairUnavailable";

type AppearanceField = "fontScale" | "backgroundOpacity";

/** Fields `onSubtitleSettingsChange` carries, plus the local fast override. */
type SubtitleChange = Partial<
  SubtitleSettingsPatch & Pick<SubtitleSettings, "fastProviderOverride">
>;

interface SavingSettings {
  revision: number;
  patch: SubtitleChange;
}

interface QueuedSettings {
  change: SubtitleChange;
  /** True when every queued change is a font/opacity step. */
  appearanceOnly: boolean;
}

/** Diagnostics stay bounded like the previous control. */
const MAX_DETAILS_LENGTH = 4_000;

/** Same bounds and step as the options page and settings normalization. */
const APPEARANCE_RANGE: Readonly<
  Record<AppearanceField, { min: number; max: number; step: number }>
> = {
  fontScale: { min: 0.75, max: 1.8, step: 0.05 },
  backgroundOpacity: { min: 0.3, max: 0.95, step: 0.05 },
};

const TRACK_CHIPS: Readonly<
  Record<SubtitleTrackTag, { tone: NtChipTone; key: string }>
> = {
  full: { tone: "full", key: "statusTrackFull" },
  stream: { tone: "stream", key: "statusTrackStream" },
  experimental: { tone: "experimental", key: "statusTrackExperimental" },
};

/**
 * Video tab: subtitle status card with the single primary action and track
 * chips, a one-line settings summary and, behind "Change", the inline
 * subtitle settings. Image recognition (OCR) is appended as a section through
 * `addSection()`; while a section owns the task (`renderStatusCard()`), its
 * card stands in for the subtitle card and its view drives the shell.
 *
 * Settings apply immediately through `onSubtitleSettingsChange` with the
 * full `SubtitleSettingsPatch`, as the previous control did. Changes made
 * while a save is in flight are merged and sent once it settles, so stepping
 * the font size quickly never drops a step; a failure reverts to the last
 * confirmed settings and shows a notice.
 *
 * AGENTS §8: when the track is live (stream or OCR) only fast translation
 * runs, whatever mode is selected; the summary and the editor say so, and
 * nothing here suggests AI pre-translation is running.
 */
export class VideoTab implements FloatingTab {
  readonly id = "video" as const;

  private subtitleStatus: SubtitleStatus = {
    state: "unavailable",
    total: 0,
    completed: 0,
    failed: 0,
  };
  private settings: ContentSettings;
  private settingsRevision = 0;
  private saving: SavingSettings | undefined;
  private queued: QueuedSettings | undefined;
  /** Stepper values shown while the user is still stepping. */
  private draft: Partial<Record<AppearanceField, number>> = {};
  /** Requested on/off value until settings confirm it (or the call fails). */
  private enabledRequested: boolean | undefined;
  private positionBusy = false;
  private positionRequested: SubtitlePositionPreset | undefined;
  private editing = false;
  private notice: VideoTabNotice | undefined;
  private retry: StatusViewContext["retry"];
  private retrySawTranslating = false;
  private tryOcrHandler: (() => void) | undefined;
  private readonly tracker: PendingActionTracker;
  private readonly sections: FloatingPanelSection[] = [];

  constructor(
    private readonly callbacks: VideoTabCallbacks,
    settings: ContentSettings,
    private readonly context: FloatingTabContext,
  ) {
    this.settings = settings;
    this.tracker = new PendingActionTracker(() => context.requestRender());
  }

  label(): string {
    return message("videoTranslationTab");
  }

  /** True while the settings editor is expanded (for tests and the shell). */
  get settingsExpanded(): boolean {
    return this.editing;
  }

  /** Latest subtitle status (sections read it for mutual exclusion). */
  get subtitle(): SubtitleStatus {
    return this.subtitleStatus;
  }

  updateSettings(settings: ContentSettings): void {
    this.settingsRevision += 1;
    this.settings = settings;
    // Turning the feature on or off is confirmed by the settings, not a status.
    this.tracker.observe(this.kind());
    if (!this.tracker.current) this.enabledRequested = undefined;
    if (!this.positionBusy) this.positionRequested = undefined;
    for (const section of this.sections) section.updateSettings?.(settings);
    this.context.requestRender();
  }

  updateSubtitleStatus(status: SubtitleStatus): void {
    const previousKind = this.kind();
    this.subtitleStatus = status;
    const kind = this.kind();
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

  /** Registers a block rendered after the tab's own content. */
  addSection(section: FloatingPanelSection): void {
    this.sections.push(section);
    this.context.requestRender();
  }

  /**
   * Handler for the "Try image recognition" remedy offered when a video has
   * no readable subtitles. The remedy is only shown while one is registered
   * (3b-3 registers the OCR entry here).
   */
  setTryOcrHandler(handler: (() => void) | undefined): void {
    this.tryOcrHandler = handler;
    this.context.requestRender();
  }

  /** What the shell shows: a section's view while it owns the task. */
  statusView(): StatusView {
    for (const section of this.sections) {
      if (!section.visible()) continue;
      const view = section.statusView?.();
      if (view) return view;
    }
    return this.subtitleView();
  }

  /** The subtitle card's own view (actions run against this one). */
  subtitleView(): StatusView {
    const pending = this.tracker.current;
    let view = subtitleStatusView(this.subtitleStatus, {
      featureEnabled: this.settings.subtitles.enabled,
      ocrAvailable: this.tryOcrHandler !== undefined,
      ...(pending?.label ? { pending: pending.label } : {}),
      ...(this.retry ? { retry: this.retry } : {}),
    });
    if (pending && !pending.label) view = withLocalPending(view, pending.id);
    return this.adaptActions(view);
  }

  /** Runs a status-card action; resolves with the request outcome. */
  async runAction(action: StatusAction): Promise<PendingRunResult | "ignored"> {
    if (action.disabled || action.busy) return "ignored";
    const baseline = this.kind();
    const cb = this.callbacks;
    let result: PendingRunResult;
    switch (action.id) {
      case "enable":
        if (baseline === "disabled") return this.changeEnabled(true);
        // Idle, or a task-level error without failed cues: start again.
        result = await this.tracker.run(
          { id: "enable", label: "starting", baseline },
          () => cb.onSubtitleStart(),
        );
        break;
      case "disable":
        return this.changeEnabled(false);
      case "stop":
        result = await this.tracker.run(
          { id: "stop", label: "stopping", baseline },
          () => cb.onSubtitleCancel(),
        );
        break;
      case "rescan":
        // Discovery ended empty: re-activate the controller scan. No
        // transitional label exists, so the card freezes the action in place.
        result = await this.tracker.run({ id: "rescan", baseline }, () =>
          cb.onSubtitleStart(),
        );
        break;
      case "resume":
        // "Continue" restarts the task; translated cues come from the cache.
        result = await this.tracker.run(
          { id: "resume", label: "resuming", baseline },
          () => cb.onSubtitleStart(),
        );
        break;
      case "retry": {
        if (this.subtitleStatus.failed > 0) {
          this.retry = {
            completedAtStart: this.subtitleStatus.completed,
            count: this.subtitleStatus.failed,
          };
          this.retrySawTranslating = false;
        }
        result = await this.tracker.run(
          { id: "retry", label: "retrying", baseline },
          () => (cb.onSubtitleRetryFailed ?? cb.onSubtitleStart)(),
        );
        if (result === "failed") this.retry = undefined;
        break;
      }
      case "switchDisplay": {
        const current = this.effectiveSubtitles().displayMode;
        const next: SubtitleDisplayMode =
          current === "bilingual" ? "translated" : "bilingual";
        this.changeSubtitles({ displayMode: next }, false);
        return "done";
      }
      case "useAutoDetect":
        this.changeSubtitles({ sourceLanguage: "auto" }, false);
        return "done";
      case "openProviderSettings":
        this.context.openSettings("providers");
        return "done";
      case "tryOcr":
        if (!this.tryOcrHandler) return "ignored";
        this.tryOcrHandler();
        return "done";
      default:
        return "ignored";
    }
    if (result === "failed") {
      this.notice = "subtitleTaskActionFailed";
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

  // --- status ---------------------------------------------------------------

  private kind(): StatusKind {
    return subtitleStatusKind(this.subtitleStatus, {
      featureEnabled: this.settings.subtitles.enabled,
    });
  }

  /** Live tracks only ever use fast translation (AGENTS §8). */
  private liveTrack(view: StatusView): "stream" | "ocr" | undefined {
    if (!view.tracks.includes("stream")) return undefined;
    return view.tracks.includes("experimental") ? "ocr" : "stream";
  }

  /**
   * Fits the model's actions to what this host can do: drops "turn off"
   * without an on/off callback, offers the provider settings for a partial
   * result whose reason needs them, and blocks starting work while the
   * method cannot translate the language pair.
   */
  private adaptActions(view: StatusView): StatusView {
    const canToggle = this.callbacks.onSubtitleEnabledChange !== undefined;
    const pairOk = this.currentPairAvailable(view);
    const needsPair = (action: StatusAction): boolean =>
      action.id === "resume" ||
      action.id === "retry" ||
      (action.id === "enable" && view.kind !== "disabled");
    const fit = (action: StatusAction): StatusAction | undefined => {
      if (action.id === "disable" && !canToggle) return undefined;
      if (!pairOk && needsPair(action)) return { ...action, disabled: true };
      return action;
    };
    const primary = view.primaryAction ? fit(view.primaryAction) : undefined;
    const secondary = view.secondaryActions
      .map(fit)
      .filter((action): action is StatusAction => action !== undefined);
    const ids = [primary, ...secondary].map((action) => action?.id);
    if (
      view.kind === "partial" &&
      resolveReason(view.diagnostics.reasonCode).remedy === "settings" &&
      !ids.includes("openProviderSettings")
    ) {
      secondary.push({
        id: "openProviderSettings",
        label: { key: "statusActionOpenProviderSettings", substitutions: [] },
        disabled: this.tracker.current !== undefined,
        busy: false,
      });
    }
    const result: StatusView = { ...view, secondaryActions: secondary };
    if (primary) result.primaryAction = primary;
    else delete result.primaryAction;
    return result;
  }

  // --- settings -------------------------------------------------------------

  private effectiveSubtitles(): SubtitleSettings {
    return {
      ...this.settings.subtitles,
      ...this.saving?.patch,
      ...this.queued?.change,
      ...this.draft,
    };
  }

  private fastProvider(subtitles = this.effectiveSubtitles()): FastProviderId {
    return (
      subtitles.fastProviderOverride ?? this.settings.provider.fastProvider
    );
  }

  /**
   * Provider whose language support matters: the fast provider whenever the
   * track is live (it is the one actually used), else the selected method.
   */
  private provider(
    subtitles = this.effectiveSubtitles(),
    live = false,
  ): LanguageProviderId {
    return subtitles.mode === "ai" && !live
      ? this.settings.provider.aiProvider
      : this.fastProvider(subtitles);
  }

  private currentPairAvailable(view?: StatusView): boolean {
    const subtitles = this.effectiveSubtitles();
    const live = view ? this.liveTrack(view) !== undefined : false;
    return pairAvailable(
      this.provider(subtitles, live),
      subtitles.sourceLanguage,
      subtitles.targetLanguage,
      this.context.capabilities(),
    );
  }

  /**
   * Requests a subtitle settings change. While a save is in flight the
   * change is merged into one follow-up save instead of being dropped.
   */
  private changeSubtitles(
    change: SubtitleChange,
    appearanceOnly: boolean,
  ): void {
    this.notice = undefined;
    if (this.saving) {
      this.queued = {
        change: { ...this.queued?.change, ...change },
        appearanceOnly: (this.queued?.appearanceOnly ?? true) && appearanceOnly,
      };
      this.context.requestRender();
      return;
    }
    void this.saveSubtitles(change, appearanceOnly);
  }

  /**
   * Sends the full patch like the previous control: language, method and
   * display changes re-send the selected fast provider when the mode is
   * fast; font and opacity steps send the patch alone.
   */
  private async saveSubtitles(
    change: SubtitleChange,
    appearanceOnly: boolean,
  ): Promise<void> {
    const next: SubtitleSettings = { ...this.effectiveSubtitles(), ...change };
    const patch: SubtitleSettingsPatch = {
      sourceLanguage: next.sourceLanguage,
      targetLanguage: next.targetLanguage,
      mode: next.mode,
      aiResponseMode: next.aiResponseMode,
      displayMode: next.displayMode,
      hideNativeSubtitles: next.hideNativeSubtitles,
      fontScale: next.fontScale,
      backgroundOpacity: next.backgroundOpacity,
    };
    const fastProvider =
      !appearanceOnly && next.mode === "fast"
        ? this.fastProvider(next)
        : undefined;
    const saving: SavingSettings = {
      revision: this.settingsRevision,
      patch: {
        ...patch,
        ...(change.fastProviderOverride
          ? { fastProviderOverride: change.fastProviderOverride }
          : {}),
      },
    };
    this.saving = saving;
    this.context.requestRender();
    let succeeded = false;
    try {
      await (fastProvider
        ? this.callbacks.onSubtitleSettingsChange(patch, fastProvider)
        : this.callbacks.onSubtitleSettingsChange(patch));
      succeeded = true;
    } catch {
      this.notice = "settingsSaveFailed";
    }
    if (this.saving !== saving) return;
    // A newer `updateSettings()` already carries the saved values.
    if (succeeded && this.settingsRevision === saving.revision) {
      this.settings = {
        ...this.settings,
        subtitles: { ...this.settings.subtitles, ...saving.patch },
      };
    }
    this.saving = undefined;
    const queued = this.queued;
    this.queued = undefined;
    // After a failure the queued changes were built on the rejected values.
    if (succeeded && queued) {
      void this.saveSubtitles(queued.change, queued.appearanceOnly);
      return;
    }
    this.context.requestRender();
  }

  private changeLanguage(role: "source" | "target", value: string): void {
    const list = role === "source" ? SOURCE_LANGUAGES : TARGET_LANGUAGES;
    if (!list.some((language) => language.code === value)) return;
    const subtitles = this.effectiveSubtitles();
    if (
      value ===
      (role === "source" ? subtitles.sourceLanguage : subtitles.targetLanguage)
    ) {
      return;
    }
    this.changeSubtitles(
      role === "source" ? { sourceLanguage: value } : { targetLanguage: value },
      false,
    );
  }

  private changeMethod(value: string): void {
    const method = parseTranslationMethod(value);
    if (!method) return;
    this.changeSubtitles(
      {
        mode: method.mode,
        ...(method.fastProvider
          ? { fastProviderOverride: method.fastProvider }
          : {}),
      },
      false,
    );
  }

  private changeResponseMode(value: string): void {
    if (value !== "stream" && value !== "batch") return;
    if (this.effectiveSubtitles().mode !== "ai") return;
    const mode: TranslationResponseMode = value;
    this.changeSubtitles({ aiResponseMode: mode }, false);
  }

  private changeDisplay(value: string): void {
    if (value !== "bilingual" && value !== "translated" && value !== "original")
      return;
    if (value === this.effectiveSubtitles().displayMode) return;
    this.changeSubtitles({ displayMode: value }, false);
  }

  private changeHideNative(hide: boolean): void {
    if (hide === this.effectiveSubtitles().hideNativeSubtitles) return;
    this.changeSubtitles({ hideNativeSubtitles: hide }, false);
  }

  private previewAppearance(field: AppearanceField, value: number): void {
    if (!Number.isFinite(value)) return;
    this.draft = { ...this.draft, [field]: value };
    this.context.requestRender();
  }

  private commitAppearance(field: AppearanceField, value: number): void {
    const draft = { ...this.draft };
    delete draft[field];
    this.draft = draft;
    const { min, max } = APPEARANCE_RANGE[field];
    if (!Number.isFinite(value) || value < min || value > max) {
      this.context.requestRender();
      return;
    }
    const confirmed = {
      ...this.settings.subtitles,
      ...this.saving?.patch,
      ...this.queued?.change,
    }[field];
    if (value === confirmed) {
      this.context.requestRender();
      return;
    }
    this.changeSubtitles({ [field]: value }, true);
  }

  /**
   * Turns subtitle translation on or off. The status card ("Turn on" /
   * "Turn off subtitle translation") and the editor switch share this path,
   * so only one request is ever in flight. Without the callback, "on" opens
   * the options page where the setting lives.
   */
  private async changeEnabled(
    enabled: boolean,
  ): Promise<PendingRunResult | "ignored"> {
    if (!this.callbacks.onSubtitleEnabledChange) {
      if (!enabled) return "ignored";
      this.context.openSettings();
      return "done";
    }
    if (this.tracker.current) return "busy";
    this.enabledRequested = enabled;
    this.notice = undefined;
    const result = await this.tracker.run(
      {
        id: enabled ? "enable" : "disable",
        ...(enabled ? { label: "starting" as const } : {}),
        baseline: this.kind(),
      },
      () => this.callbacks.onSubtitleEnabledChange?.(enabled),
    );
    if (result === "failed") {
      this.enabledRequested = undefined;
      this.notice = "settingsSaveFailed";
    }
    this.context.requestRender();
    return result;
  }

  private async changePosition(value: string): Promise<void> {
    if (!this.callbacks.onSubtitlePositionChange || this.positionBusy) return;
    if (value !== "top" && value !== "center" && value !== "bottom") return;
    if (value === this.settings.subtitles.position) return;
    this.positionBusy = true;
    this.positionRequested = value;
    this.notice = undefined;
    this.context.requestRender();
    try {
      await this.callbacks.onSubtitlePositionChange(value);
    } catch {
      this.positionRequested = undefined;
      this.notice = "settingsSaveFailed";
    } finally {
      this.positionBusy = false;
      this.context.requestRender();
    }
  }

  private createProfile(): void {
    this.context.collapse();
    void Promise.resolve()
      .then(() => this.callbacks.onCreateProfile())
      .catch(() => {
        this.notice = "subtitleTaskActionFailed";
        this.context.requestRender();
      });
  }

  // --- rendering ------------------------------------------------------------

  render(): TemplateResult {
    const view = this.subtitleView();
    const sectionCard = this.sections
      .filter((section) => section.visible())
      .map((section) => section.renderStatusCard?.())
      .find((card) => card !== undefined);
    // The subtitle pair warning does not apply while a section owns the card.
    const notice =
      this.notice ??
      (sectionCard || this.currentPairAvailable(view)
        ? undefined
        : "floatingPairUnavailable");
    return html`<div class="tab-body" data-tab="video">
      ${sectionCard ?? this.renderCard(view)}
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
        >${this.renderSummary(view)}</nt-quick-line
      >
      ${this.editing ? this.renderEditor(view) : nothing}
      ${this.sections.map((section) =>
        section.visible()
          ? html`<div class="section" data-section=${section.id}>
              ${section.render()}
            </div>`
          : nothing,
      )}
    </div>`;
  }

  private cardDescription(view: StatusView): string {
    if (view.kind === "disabled") {
      // Off means nothing was detected; say how to turn it on instead.
      return message(
        this.callbacks.onSubtitleEnabledChange
          ? "floatingVideoDisabledHint"
          : "floatingVideoDisabledSettingsHint",
      );
    }
    return [view.reason, view.progressNote]
      .filter((text) => text !== undefined)
      .map((text) => localize(text))
      .join(" ");
  }

  private renderCard(view: StatusView): TemplateResult {
    const title = localize(view.title);
    const details = view.diagnostics.details
      ?.trim()
      .slice(0, MAX_DETAILS_LENGTH);
    // A live track has no meaningful total, so its bar stays indeterminate.
    const progress =
      this.liveTrack(view) && !view.retrying ? null : progressValue(view);
    return html`<nt-status-card
      class="status"
      state=${visualState(view)}
      heading=${title}
      description=${this.cardDescription(view)}
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
      ${
        view.primaryAction
          ? this.renderAction(
              view,
              view.primaryAction,
              primaryVariant(view.primaryAction.id),
              true,
            )
          : nothing
      }
      ${view.secondaryActions.map((action) =>
        this.renderAction(view, action, "ghost", false),
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
    view: StatusView,
    action: StatusAction,
    variant: string,
    primary: boolean,
  ): TemplateResult {
    // Without an on/off callback "Turn on" can only lead to the options page.
    const label =
      action.id === "enable" &&
      view.kind === "disabled" &&
      !action.busy &&
      !this.callbacks.onSubtitleEnabledChange
        ? message("floatingVideoOpenSubtitleSettings")
        : localize(action.label);
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
      >${label}</nt-button
    >`;
  }

  private renderSummary(view: StatusView): TemplateResult {
    const subtitles = this.effectiveSubtitles();
    const method = methodLabel(subtitles.mode, this.fastProvider(subtitles));
    const fallback = subtitles.mode === "ai" && this.liveTrack(view);
    const displayKey: Record<SubtitleDisplayMode, string> = {
      bilingual: "displayBilingual",
      translated: "displayTranslated",
      original: "displayOriginal",
    };
    return html`<span class="summary-text"
      >${languageLabel(subtitles.sourceLanguage)} →
      <b>${languageLabel(subtitles.targetLanguage)}</b> · <b>${method}</b>${
        fallback
          ? html`<span data-fallback=""
              >${message("floatingVideoFastFallbackSummary")}</span
            >`
          : nothing
      }
      · ${message(displayKey[subtitles.displayMode])}</span
    >`;
  }

  private renderEditor(view: StatusView): TemplateResult {
    const subtitles = this.effectiveSubtitles();
    const liveTrack = this.liveTrack(view);
    const provider = this.provider(subtitles, liveTrack !== undefined);
    const snapshot = this.context.capabilities();
    const busy = this.saving !== undefined;
    const valueOf = (event: Event): string => {
      const value = (event as CustomEvent<{ value?: unknown }>).detail?.value;
      return typeof value === "string" ? value : "";
    };
    const numberOf = (event: Event): number => {
      const value = (event as CustomEvent<{ value?: unknown }>).detail?.value;
      return typeof value === "number" ? value : Number.NaN;
    };
    const checkedOf = (event: Event): boolean =>
      Boolean((event as CustomEvent<{ checked?: unknown }>).detail?.checked);
    const responseOptions: NtSelectOption[] = [
      { value: "stream", label: message("responseModeStream") },
      { value: "batch", label: message("responseModeBatch") },
    ];
    const displayOptions: NtSegmentOption[] = [
      { value: "bilingual", label: message("displayBilingual") },
      { value: "translated", label: message("displayTranslated") },
      { value: "original", label: message("displayOriginal") },
    ];
    const percent = (value: number): string =>
      message("percentageValue", String(Math.round(value * 100)));
    // The requested value only stands while its request is unconfirmed.
    const enabledChecked = this.tracker.current
      ? (this.enabledRequested ?? this.settings.subtitles.enabled)
      : this.settings.subtitles.enabled;
    return html`<div
      class="editor"
      role="group"
      aria-label=${message("floatingVideoSettings")}
    >
      ${
        this.callbacks.onSubtitleEnabledChange
          ? html`<nt-switch
              compact
              data-field="enabled"
              label=${message("subtitleEnabled")}
              .checked=${live(enabledChecked)}
              ?disabled=${this.tracker.current !== undefined}
              @change=${(event: Event) =>
                void this.changeEnabled(checkedOf(event))}
            ></nt-switch>`
          : nothing
      }
      <div class="row">
        <nt-select
          compact
          data-field="source"
          label=${message("sourceLanguage")}
          .options=${languageOptions("source", provider, subtitles.sourceLanguage, snapshot)}
          .value=${live(subtitles.sourceLanguage)}
          ?disabled=${busy}
          @change=${(event: Event) =>
            this.changeLanguage("source", valueOf(event))}
        ></nt-select>
        <nt-select
          compact
          data-field="target"
          label=${message("targetLanguage")}
          .options=${languageOptions("target", provider, subtitles.targetLanguage, snapshot)}
          .value=${live(subtitles.targetLanguage)}
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
          translationMethodValue(subtitles.mode, this.fastProvider(subtitles)),
        )}
        ?disabled=${busy}
        @change=${(event: Event) => this.changeMethod(valueOf(event))}
      ></nt-select>
      ${
        subtitles.mode === "ai" && liveTrack
          ? html`<nt-note class="fallback-note" tone="info" icon="info"
              >${message(
                liveTrack === "ocr"
                  ? "floatingVideoOcrFastNote"
                  : "floatingVideoStreamFastNote",
              )}</nt-note
            >`
          : nothing
      }
      ${
        subtitles.mode === "ai"
          ? html`<nt-select
              compact
              data-field="response"
              label=${message("aiResponseMode")}
              .options=${responseOptions}
              .value=${live(subtitles.aiResponseMode)}
              ?disabled=${busy}
              @change=${(event: Event) =>
                this.changeResponseMode(valueOf(event))}
            ></nt-select>`
          : nothing
      }
      <nt-segmented
        data-field="display"
        label=${message("subtitleDisplayMode")}
        .options=${displayOptions}
        .value=${live(subtitles.displayMode)}
        ?disabled=${busy}
        @change=${(event: Event) => this.changeDisplay(valueOf(event))}
      ></nt-segmented>
      <nt-switch
        compact
        data-field="hide-native"
        label=${message("hideNativeSubtitles")}
        .checked=${live(subtitles.hideNativeSubtitles)}
        ?disabled=${busy}
        @change=${(event: Event) => this.changeHideNative(checkedOf(event))}
      ></nt-switch>
      ${this.renderPosition()}
      <div class="row">
        <nt-stepper
          data-field="font"
          label=${message("subtitleFontSize")}
          .value=${live(subtitles.fontScale)}
          .min=${APPEARANCE_RANGE.fontScale.min}
          .max=${APPEARANCE_RANGE.fontScale.max}
          .step=${APPEARANCE_RANGE.fontScale.step}
          .format=${percent}
          decrement-label=${message("subtitleFontDecrease")}
          increment-label=${message("subtitleFontIncrease")}
          @nt-input=${(event: Event) =>
            this.previewAppearance("fontScale", numberOf(event))}
          @change=${(event: Event) =>
            this.commitAppearance("fontScale", numberOf(event))}
        ></nt-stepper>
        <nt-stepper
          data-field="opacity"
          label=${message("subtitleBackground")}
          .value=${live(subtitles.backgroundOpacity)}
          .min=${APPEARANCE_RANGE.backgroundOpacity.min}
          .max=${APPEARANCE_RANGE.backgroundOpacity.max}
          .step=${APPEARANCE_RANGE.backgroundOpacity.step}
          .format=${percent}
          decrement-label=${message("floatingVideoOpacityDecrease")}
          increment-label=${message("floatingVideoOpacityIncrease")}
          @nt-input=${(event: Event) =>
            this.previewAppearance("backgroundOpacity", numberOf(event))}
          @change=${(event: Event) =>
            this.commitAppearance("backgroundOpacity", numberOf(event))}
        ></nt-stepper>
      </div>
      <div class="editor-foot">
        <nt-button
          data-field="profile"
          variant="ghost"
          size="sm"
          @click=${() => this.createProfile()}
          >${message("createSiteProfile")}</nt-button
        >
      </div>
    </div>`;
  }

  private renderPosition(): TemplateResult | typeof nothing {
    if (!this.callbacks.onSubtitlePositionChange) return nothing;
    const current: SubtitlePosition =
      this.positionRequested ?? this.settings.subtitles.position;
    const options: NtSelectOption[] = [
      { value: "top", label: message("subtitlePositionTop") },
      { value: "center", label: message("subtitlePositionCenter") },
      { value: "bottom", label: message("subtitlePositionBottom") },
    ];
    // A dragged position is shown as such; it is changed by dragging again.
    if (current === "custom") {
      options.push({
        value: "custom",
        label: message("subtitlePositionCustom"),
        disabled: true,
      });
    }
    return html`<nt-select
      compact
      data-field="position"
      label=${message("subtitlePosition")}
      .options=${options}
      .value=${live(current)}
      ?disabled=${this.positionBusy}
      @change=${(event: Event) => {
        const value = (event as CustomEvent<{ value?: unknown }>).detail?.value;
        void this.changePosition(typeof value === "string" ? value : "");
      }}
    ></nt-select>`;
  }
}
