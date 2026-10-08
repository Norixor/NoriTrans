import type { SubtitleStatus } from "@/src/messaging/protocol";
import { isOcrSourceLanguageSupported } from "@/src/ocr/languages";
import {
  OCR_REASON,
  type OcrStatus,
  type OcrStatusState,
} from "@/src/ocr/types";
import { message } from "@/src/shared/i18n";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "@/src/shared/languages";
import type { ContentSettings, OcrSettings } from "@/src/shared/settings";
import type { FloatingControlCallbacks } from "./callbacks";
import type { NtSelectOption } from "@/src/ui/components";
import type { StatusKind, StatusView } from "@/src/ui/status";
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { languageOptions, pairAvailable } from "./options";
import {
  isOcrRunning,
  OCR_PHASE_KEYS,
  ocrCardView,
  ocrOwnsCard,
  ocrPhase,
  ocrReasonText,
  ocrShellView,
  otherTrackAvailable,
  type OcrCardAction,
  type OcrPending,
  type OcrRuntimeReadiness,
  type OcrViewInput,
} from "./ocr-view";
import { PendingActionTracker, type PendingRunResult } from "./pending";
import { renderSectionHead, viewText } from "./section-view";
import type { FloatingPanelSection, FloatingTabContext } from "./tab";

export type OcrSectionCallbacks = Pick<
  FloatingControlCallbacks,
  "onOcrSettingsChange" | "onOcrEnabledChange" | "onOcrStart" | "onOcrStop"
>;

/**
 * Reports whether the recognition language pack needed for `sourceLanguage`
 * is installed. Read-only: the floating control never downloads packs
 * (AGENTS §7); downloads and deletion live on the options page.
 */
export type OcrRuntimeQuery = (sourceLanguage: string) => Promise<boolean>;

export interface OcrSectionOptions {
  callbacks: OcrSectionCallbacks;
  settings: ContentSettings;
  context: FloatingTabContext;
  /** Latest subtitle status of the host tab (the OCR track feeds it). */
  subtitle: () => SubtitleStatus;
  queryRuntime?: OcrRuntimeQuery | undefined;
}

/** Notice shown inside the section after a failed request. */
export type OcrSectionNotice =
  | "settingsSaveFailed"
  | "ocrCapturePermissionRequired"
  | "floatingOcrActionFailed";

interface SavingOcr {
  revision: number;
  patch: OcrSettings;
}

/** Diagnostics stay bounded like the other cards. */
const MAX_DETAILS_LENGTH = 4_000;

const KIND_OF_STATE: Readonly<Record<OcrStatusState, StatusKind>> = {
  disabled: "disabled",
  idle: "idle",
  selecting: "scanning",
  initializing: "translating",
  capturing: "translating",
  recognizing: "translating",
  active: "translating",
  cancelled: "cancelled",
  unavailable: "unavailable",
  error: "error",
};

const HEAD_SELECTOR = '[data-section="ocr"] .sec-head';

/**
 * "Image recognition (experimental)" block of the video tab.
 *
 * Collapsed by default to one header line with a state word. Expanded, it
 * says what stays on the device, whether the recognition pack is ready (and
 * links to the options page when not), and offers the opt-in switch, the
 * OCR languages, the local translator and "Select area and start".
 *
 * While OCR is turning on, running, or stopped on a problem the user has not
 * closed, its card stands in for the subtitle card (`renderStatusCard()`),
 * with "Stop" as the primary action and "Reselect area" next to it. A
 * non-OCR subtitle track always wins: OCR is then not offered (AGENTS §7).
 *
 * Settings apply immediately through `onOcrSettingsChange` (the full patch,
 * as before); a failure reverts and shows a notice. Turning OCR on lets the
 * host ask Chrome for the optional capture permission.
 */
export class OcrSection implements FloatingPanelSection {
  readonly id = "ocr";

  private status: OcrStatus;
  private settings: ContentSettings;
  private settingsRevision = 0;
  private saving: SavingOcr | undefined;
  private expanded = false;
  private dismissed = false;
  private notice: OcrSectionNotice | undefined;
  /** "Try image recognition" is turning OCR on before starting it. */
  private trying = false;
  private runtime: OcrRuntimeReadiness = "unknown";
  private runtimeLanguage: string | undefined;
  private runtimeRevision = 0;
  private disposed = false;
  private readonly tracker: PendingActionTracker;
  private readonly callbacks: OcrSectionCallbacks;
  private readonly context: FloatingTabContext;
  private readonly subtitle: () => SubtitleStatus;
  private readonly queryRuntime: OcrRuntimeQuery | undefined;

  constructor(options: OcrSectionOptions) {
    this.callbacks = options.callbacks;
    this.settings = options.settings;
    this.context = options.context;
    this.subtitle = options.subtitle;
    this.queryRuntime = options.queryRuntime;
    this.status = {
      state: options.settings.ocr.enabled ? "idle" : "disabled",
      recognized: 0,
    };
    this.tracker = new PendingActionTracker(() => this.context.requestRender());
  }

  /** Whether "Try image recognition" can lead anywhere on this host. */
  get canStart(): boolean {
    return this.callbacks.onOcrStart !== undefined;
  }

  /** Whether this host can switch OCR on or off from here. */
  get canToggle(): boolean {
    return (
      this.callbacks.onOcrSettingsChange !== undefined ||
      this.callbacks.onOcrEnabledChange !== undefined
    );
  }

  visible(): boolean {
    return this.canStart;
  }

  updateStatus(status: OcrStatus): void {
    const previous = this.status;
    this.status = status;
    if (
      previous.state !== status.state ||
      previous.reasonCode !== status.reasonCode
    ) {
      this.dismissed = false;
      this.notice = undefined;
    }
    if (
      status.reasonCode === OCR_REASON.runtimeMissing ||
      status.reasonCode === OCR_REASON.engineUnavailable
    ) {
      this.runtime = "missing";
    } else if (isOcrRunning(status) && status.state !== "selecting") {
      // Preparing or recognizing proves the pack loaded.
      this.runtime = "ready";
    }
    this.tracker.observe(this.kind());
    this.context.requestRender();
  }

  updateSettings(settings: ContentSettings): void {
    const previousLanguage = this.effectiveOcr().sourceLanguage;
    this.settingsRevision += 1;
    this.settings = settings;
    this.tracker.observe(this.kind());
    if (this.effectiveOcr().sourceLanguage !== previousLanguage) {
      this.runtime = "unknown";
      if (this.expanded) void this.refreshRuntime();
    }
    this.context.requestRender();
  }

  /** Overrides the shell view only while OCR owns the card. */
  statusView(): StatusView | undefined {
    return ocrShellView(this.viewInput());
  }

  renderStatusCard(): TemplateResult | undefined {
    const input = this.viewInput();
    if (!ocrOwnsCard(input)) return undefined;
    const view = ocrCardView(input);
    const title = viewText(view.title);
    const details = view.diagnostics?.slice(0, MAX_DETAILS_LENGTH);
    return html`<nt-status-card
      class="status"
      data-ocr-card=${this.status.state}
      state=${view.state}
      heading=${title}
      count=${view.count ? viewText(view.count) : ""}
      description=${view.description ? viewText(view.description) : ""}
      .progress=${view.progress}
      progress-label=${title}
      quiet
    >
      ${
        view.liveChips
          ? html`<nt-chip slot="meta" data-track="stream" tone="stream"
                >${message("statusTrackStream")}</nt-chip
              ><nt-chip
                slot="meta"
                data-track="experimental"
                tone="experimental"
                >${message("statusTrackExperimental")}</nt-chip
              >`
          : nothing
      }
      ${view.primary ? this.renderCardAction(view.primary, true) : nothing}
      ${view.secondary.map((item) => this.renderCardAction(item, false))}
      ${
        view.notes.length > 0
          ? html`<div slot="details" class="card-notes">
              ${view.notes.map(
                (note) =>
                  html`<nt-note
                    data-ocr-note=${note.tone}
                    tone=${note.tone}
                    icon=${note.tone === "warn" ? "warning" : "info"}
                    >${viewText(note.text)}</nt-note
                  >`,
              )}
            </div>`
          : nothing
      }
      ${
        details
          ? html`<details slot="details" class="diag">
              <summary>${message("floatingOcrDetails")}</summary>
              <pre aria-label=${message("floatingOcrDetails")}>${details}</pre>
            </details>`
          : nothing
      }
    </nt-status-card>`;
  }

  /**
   * The video tab's "Try image recognition" remedy: turns OCR on when it is
   * off (the host asks for the capture permission), then starts selection.
   */
  async tryOcr(): Promise<void> {
    if (this.trying || this.tracker.current || !this.canStart) return;
    if (otherTrackAvailable(this.subtitle())) return;
    this.expanded = true;
    this.dismissed = false;
    this.notice = undefined;
    this.trying = true;
    // The remedy button is replaced by the OCR card; keep focus in the tab.
    this.context.focus(HEAD_SELECTOR);
    void this.refreshRuntime();
    try {
      if (!this.effectiveOcr().enabled) {
        // Without an on/off callback the switch lives on the options page.
        if (!this.canToggle) {
          this.context.openSettings("ocr");
          return;
        }
        if (!(await this.changeEnabled(true))) return;
      }
      await this.start();
    } finally {
      this.trying = false;
      this.context.requestRender();
    }
  }

  /** Collapses the body; true when it was open. */
  handleEscape(): boolean {
    if (!this.expanded) return false;
    this.expanded = false;
    this.context.requestRender();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.tracker.dispose();
  }

  // --- state ----------------------------------------------------------------

  private effectiveOcr(): OcrSettings {
    return { ...this.settings.ocr, ...this.saving?.patch };
  }

  private kind(): StatusKind {
    return KIND_OF_STATE[this.status.state];
  }

  private pending(): OcrPending | undefined {
    if (this.trying && this.saving) return "enabling";
    const current = this.tracker.current;
    if (!current) return this.trying ? "starting" : undefined;
    return current.id === "stop" ? "stopping" : "starting";
  }

  private pairOk(): boolean {
    const ocr = this.effectiveOcr();
    return pairAvailable(
      ocr.provider,
      ocr.sourceLanguage,
      ocr.targetLanguage,
      this.context.capabilities(),
    );
  }

  private viewInput(): OcrViewInput {
    return {
      status: this.status,
      enabled: this.effectiveOcr().enabled,
      subtitle: this.subtitle(),
      pending: this.pending(),
      dismissed: this.dismissed,
      runtime: this.runtime,
      pairAvailable: this.pairOk(),
      canStart: this.canStart,
    };
  }

  private async refreshRuntime(): Promise<void> {
    const query = this.queryRuntime;
    if (!query) return;
    const language = this.effectiveOcr().sourceLanguage;
    if (this.runtime !== "unknown" && this.runtimeLanguage === language) return;
    const revision = ++this.runtimeRevision;
    this.runtimeLanguage = language;
    let readiness: OcrRuntimeReadiness = "unknown";
    try {
      readiness = (await query(language)) ? "ready" : "missing";
    } catch {
      // Unknown readiness hides the line; starting reports a missing pack.
    }
    if (this.disposed || revision !== this.runtimeRevision) return;
    this.runtime = readiness;
    this.context.requestRender();
  }

  // --- actions --------------------------------------------------------------

  private async start(): Promise<PendingRunResult | "ignored"> {
    const start = this.callbacks.onOcrStart;
    if (!start) return "ignored";
    this.notice = undefined;
    this.dismissed = false;
    // The selection overlay needs the video unobstructed (as before).
    this.context.collapse();
    const result = await this.tracker.run(
      { id: "enable", label: "starting", baseline: this.kind() },
      () => start(),
    );
    if (result === "failed") this.fail("floatingOcrActionFailed");
    return result;
  }

  private async stop(): Promise<PendingRunResult | "ignored"> {
    const stop = this.callbacks.onOcrStop;
    if (!stop) return "ignored";
    this.notice = undefined;
    const result = await this.tracker.run(
      { id: "stop", label: "stopping", baseline: this.kind() },
      () => stop(),
    );
    if (result === "failed") this.fail("floatingOcrActionFailed");
    return result;
  }

  /** Runs a card or body action; resolves with the request outcome. */
  async runAction(
    id: OcrCardAction["id"],
  ): Promise<PendingRunResult | "ignored"> {
    switch (id) {
      case "start":
      case "reselect":
        return this.start();
      case "stop":
        return this.stop();
      case "enable":
        return (await this.changeEnabled(true)) ? "done" : "failed";
      case "openSettings":
        this.context.openSettings("ocr");
        return "done";
      case "dismiss":
        this.dismissed = true;
        this.context.focus(HEAD_SELECTOR);
        return "done";
    }
  }

  private fail(notice: OcrSectionNotice): void {
    this.notice = notice;
    this.expanded = true;
    this.context.focus(HEAD_SELECTOR);
  }

  /**
   * Saves OCR settings. With `onOcrSettingsChange` the full patch is sent
   * (languages and translator included); a host that only offers
   * `onOcrEnabledChange` can switch OCR on or off and nothing else.
   */
  private async saveOcr(change: Partial<OcrSettings>): Promise<boolean> {
    if (this.saving) return false;
    const patch: OcrSettings = { ...this.effectiveOcr(), ...change };
    const saving: SavingOcr = { revision: this.settingsRevision, patch };
    this.saving = saving;
    this.notice = undefined;
    this.context.requestRender();
    let succeeded = false;
    try {
      if (this.callbacks.onOcrSettingsChange) {
        await this.callbacks.onOcrSettingsChange(patch);
      } else if (
        this.callbacks.onOcrEnabledChange &&
        change.enabled !== undefined
      ) {
        await this.callbacks.onOcrEnabledChange(change.enabled);
      } else {
        throw new Error("ocr-settings-unsupported");
      }
      succeeded = true;
    } catch {
      // Turning on fails while Chrome's capture permission is not granted;
      // the host opens a NoriTrans window to request it (as before).
      this.notice =
        change.enabled === true
          ? "ocrCapturePermissionRequired"
          : "settingsSaveFailed";
    }
    if (this.saving === saving) {
      // A newer `updateSettings()` already carries the saved values.
      if (succeeded && this.settingsRevision === saving.revision) {
        this.settings = { ...this.settings, ocr: saving.patch };
      }
      this.saving = undefined;
    }
    if (succeeded && change.enabled !== undefined) {
      // Hosts confirm through the OCR status; keep the switch and the state
      // consistent until it arrives (the previous control did the same).
      const resting =
        this.status.state === "idle" || this.status.state === "disabled";
      if (resting) {
        this.status = {
          state: change.enabled ? "idle" : "disabled",
          recognized: 0,
        };
      }
    }
    if (succeeded && change.sourceLanguage !== undefined) {
      this.runtime = "unknown";
      void this.refreshRuntime();
    }
    this.context.requestRender();
    return succeeded;
  }

  private changeEnabled(enabled: boolean): Promise<boolean> {
    if (enabled === this.effectiveOcr().enabled) return Promise.resolve(true);
    return this.saveOcr({ enabled });
  }

  private changeLanguage(role: "source" | "target", value: string): void {
    const list = role === "source" ? SOURCE_LANGUAGES : TARGET_LANGUAGES;
    if (!list.some((language) => language.code === value)) return;
    if (role === "source" && !isOcrSourceLanguageSupported(value)) return;
    const ocr = this.effectiveOcr();
    if (value === (role === "source" ? ocr.sourceLanguage : ocr.targetLanguage))
      return;
    void this.saveOcr(
      role === "source" ? { sourceLanguage: value } : { targetLanguage: value },
    );
  }

  private changeTranslator(value: string): void {
    if (value !== "chrome-local" && value !== "bergamot-local") return;
    if (value === this.effectiveOcr().provider) return;
    void this.saveOcr({ provider: value });
  }

  private toggle(): void {
    this.expanded = !this.expanded;
    if (this.expanded) void this.refreshRuntime();
    this.context.requestRender();
  }

  // --- rendering ------------------------------------------------------------

  private renderCardAction(
    item: OcrCardAction,
    primary: boolean,
  ): TemplateResult {
    return html`<nt-button
      slot="actions"
      data-action=${item.id}
      data-primary=${String(primary)}
      variant=${item.variant}
      size=${primary ? "lg" : "md"}
      ?block=${primary}
      ?busy=${item.busy}
      ?disabled=${item.disabled}
      @click=${() => void this.runAction(item.id)}
      >${viewText(item.label)}</nt-button
    >`;
  }

  render(): TemplateResult {
    const input = this.viewInput();
    const phase = ocrPhase(input);
    const owning = ocrOwnsCard(input);
    return html`${renderSectionHead({
        id: "nt-ocr-body",
        title: message("floatingOcrTitle"),
        state: message(OCR_PHASE_KEYS[phase]),
        phase,
        expanded: this.expanded,
        onToggle: () => this.toggle(),
      })}
      <div
        id="nt-ocr-body"
        class="sec-body"
        role="group"
        aria-label=${message("floatingOcrSettings")}
        ?hidden=${!this.expanded}
      >
        ${this.expanded ? this.renderBody(input, owning) : nothing}
      </div>`;
  }

  private renderBody(input: OcrViewInput, owning: boolean): TemplateResult {
    const ocr = this.effectiveOcr();
    const busy = this.saving !== undefined;
    const blocked = otherTrackAvailable(input.subtitle);
    const running = isOcrRunning(this.status);
    const problem =
      !owning &&
      !blocked &&
      (this.status.state === "error" || this.status.state === "unavailable")
        ? ocrReasonText(this.status)
        : undefined;
    const canEdit = this.callbacks.onOcrSettingsChange !== undefined;
    const canToggle = this.canToggle;
    const valueOf = (event: Event): string => {
      const value = (event as CustomEvent<{ value?: unknown }>).detail?.value;
      return typeof value === "string" ? value : "";
    };
    const snapshot = this.context.capabilities();
    const sourceOptions = languageOptions(
      "source",
      ocr.provider,
      ocr.sourceLanguage,
      snapshot,
    ).filter(
      (option) =>
        option.value === ocr.sourceLanguage ||
        isOcrSourceLanguageSupported(option.value),
    );
    const translatorOptions: NtSelectOption[] = [
      { value: "chrome-local", label: message("translationMethodChromeLocal") },
      {
        value: "bergamot-local",
        label: message("translationMethodBergamotLocal"),
      },
    ];
    const startDisabled =
      !ocr.enabled ||
      blocked ||
      busy ||
      !input.pairAvailable ||
      this.trying ||
      this.tracker.current !== undefined;
    return html`<nt-note icon="shield" data-ocr="privacy"
        >${message("floatingOcrPrivacy")}</nt-note
      >
      ${
        this.notice
          ? html`<nt-note
              class="notice"
              data-ocr="notice"
              tone="warn"
              icon="warning"
              >${message(this.notice)}</nt-note
            >`
          : nothing
      }
      ${
        blocked
          ? html`<nt-note data-ocr="blocked" tone="info" icon="info"
              >${message("floatingOcrTrackAvailable")}</nt-note
            >`
          : nothing
      }
      ${
        problem
          ? html`<nt-note data-ocr="problem" tone="warn" icon="warning"
              >${viewText(problem)}</nt-note
            >`
          : nothing
      }
      ${this.renderRuntime()}
      ${
        ocr.enabled && !input.pairAvailable
          ? html`<nt-note data-ocr="pair" tone="warn" icon="warning"
              >${message("floatingPairUnavailable")}</nt-note
            >`
          : nothing
      }
      ${
        canToggle
          ? html`<nt-switch
              compact
              data-field="ocr-enabled"
              label=${message("floatingOcrEnable")}
              description=${message("floatingOcrEnableHint")}
              .checked=${live(ocr.enabled)}
              ?disabled=${busy || this.trying || running}
              @change=${(event: Event) =>
                void this.changeEnabled(
                  Boolean(
                    (event as CustomEvent<{ checked?: unknown }>).detail
                      ?.checked,
                  ),
                )}
            ></nt-switch>`
          : nothing
      }
      ${
        ocr.enabled && canEdit
          ? html`<div class="row">
                <nt-select
                  compact
                  data-field="ocr-source"
                  label=${message("floatingOcrSourceLanguage")}
                  .options=${sourceOptions}
                  .value=${live(ocr.sourceLanguage)}
                  ?disabled=${busy}
                  @change=${(event: Event) =>
                    this.changeLanguage("source", valueOf(event))}
                ></nt-select>
                <nt-select
                  compact
                  data-field="ocr-target"
                  label=${message("targetLanguage")}
                  .options=${languageOptions("target", ocr.provider, ocr.targetLanguage, snapshot)}
                  .value=${live(ocr.targetLanguage)}
                  ?disabled=${busy}
                  @change=${(event: Event) =>
                    this.changeLanguage("target", valueOf(event))}
                ></nt-select>
              </div>
              <nt-select
                compact
                data-field="ocr-translator"
                label=${message("floatingOcrTranslator")}
                .options=${translatorOptions}
                .value=${live(ocr.provider)}
                ?disabled=${busy}
                @change=${(event: Event) =>
                  this.changeTranslator(valueOf(event))}
              ></nt-select>`
          : nothing
      }
      ${
        owning
          ? nothing
          : running
            ? html`<nt-button
                data-ocr-action="stop"
                variant="secondary"
                block
                ?busy=${this.pending() === "stopping"}
                ?disabled=${this.pending() === "stopping"}
                @click=${() => void this.stop()}
                >${message("statusActionStop")}</nt-button
              >`
            : ocr.enabled
              ? html`<nt-button
                  data-ocr-action="start"
                  variant="primary"
                  block
                  ?busy=${this.pending() === "starting"}
                  ?disabled=${startDisabled}
                  @click=${() => void this.start()}
                  >${message("ocrStart")}</nt-button
                >`
              : nothing
      }`;
  }

  private renderRuntime(): TemplateResult | typeof nothing {
    if (this.runtime === "unknown") return nothing;
    if (this.runtime === "ready") {
      return html`<p class="sec-line" data-ocr="runtime-ready">
        ${message("floatingOcrRuntimeReady")}
      </p>`;
    }
    return html`<div class="sec-callout" data-ocr="runtime-missing">
      <nt-note tone="warn" icon="warning"
        >${message("floatingOcrRuntimeMissing")}</nt-note
      >
      <nt-button
        data-ocr-action="open-settings"
        variant="ghost"
        size="sm"
        @click=${() => this.context.openSettings("ocr")}
        >${message("floatingOcrOpenSettings")}</nt-button
      >
    </div>`;
  }
}
