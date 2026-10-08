import type {
  ImageTranslationState,
  ImageTranslationStatus,
} from "@/src/image-translation/controller";
import { message } from "@/src/shared/i18n";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "@/src/shared/languages";
import type {
  ContentSettings,
  DisplayMode,
  FastProviderId,
  ImageTranslationSettings,
} from "@/src/shared/settings";
import {
  parseTranslationMethod,
  translationMethodValue,
} from "@/src/shared/translation-methods";
import type { FloatingControlCallbacks } from "./callbacks";
import type { NtSegmentOption } from "@/src/ui/components";
import type { StatusKind } from "@/src/ui/status";
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import {
  IMAGE_PHASE_KEYS,
  imageCardView,
  imagePhase,
  isImageRunning,
  type ImageActionId,
  type ImageCardAction,
  type ImagePending,
} from "./image-view";
import {
  languageOptions,
  methodOptions,
  pairAvailable,
  type LanguageProviderId,
} from "./options";
import { PendingActionTracker, type PendingRunResult } from "./pending";
import { renderSectionHead, viewText } from "./section-view";
import type { FloatingPanelSection, FloatingTabContext } from "./tab";

export type ImageSectionCallbacks = Pick<
  FloatingControlCallbacks,
  "onImageSettingsChange" | "onImageStart" | "onImageCancelOrClear"
>;

export type ImageSectionNotice =
  "settingsSaveFailed" | "floatingImageActionFailed";

interface SavingImage {
  revision: number;
  patch: ImageTranslationSettings;
  /** Fast provider chosen with the method; the host stores it globally. */
  fastProvider?: FastProviderId | undefined;
}

const MAX_DETAILS_LENGTH = 4_000;

const KIND_OF_STATE: Readonly<Record<ImageTranslationState, StatusKind>> = {
  disabled: "disabled",
  idle: "idle",
  available: "idle",
  capturing: "scanning",
  recognizing: "scanning",
  translating: "translating",
  ready: "ready",
  cancelled: "cancelled",
  unavailable: "unavailable",
  error: "error",
};

const HEAD_SELECTOR = '[data-section="image"] .sec-head';

/**
 * "Image translation (experimental)" block of the page tab: a page-level
 * capability (the previous control's third "Image" tab). Collapsed to a
 * header line with a state word; expanded it shows what is sent where, the
 * opt-in switch and, when on, a status card for the current image with one
 * primary action (translate / stop / clear) plus the image settings.
 *
 * Settings apply immediately through `onImageSettingsChange` with the full
 * patch, as before; the AI model override stays on the options page and is
 * re-sent unchanged. A failure reverts and shows a notice.
 */
export class ImageSection implements FloatingPanelSection {
  readonly id = "image";

  private status: ImageTranslationStatus;
  private settings: ContentSettings;
  private settingsRevision = 0;
  private saving: SavingImage | undefined;
  private expanded = false;
  private notice: ImageSectionNotice | undefined;
  private pendingClear = false;
  private readonly tracker: PendingActionTracker;

  constructor(
    private readonly callbacks: ImageSectionCallbacks,
    settings: ContentSettings,
    private readonly context: FloatingTabContext,
  ) {
    this.settings = settings;
    this.status = {
      state: settings.imageTranslation.enabled ? "idle" : "disabled",
      total: 0,
      completed: 0,
      hasCurrentImage: false,
    };
    this.tracker = new PendingActionTracker(() => this.context.requestRender());
  }

  visible(): boolean {
    return this.callbacks.onImageStart !== undefined;
  }

  updateStatus(status: ImageTranslationStatus): void {
    const previous = this.status.state;
    this.status = status;
    if (previous !== status.state) this.notice = undefined;
    this.tracker.observe(KIND_OF_STATE[status.state]);
    this.context.requestRender();
  }

  updateSettings(settings: ContentSettings): void {
    this.settingsRevision += 1;
    this.settings = settings;
    this.context.requestRender();
  }

  handleEscape(): boolean {
    if (!this.expanded) return false;
    this.expanded = false;
    this.context.requestRender();
    return true;
  }

  dispose(): void {
    this.tracker.dispose();
  }

  // --- state ----------------------------------------------------------------

  private effective(): ImageTranslationSettings {
    return { ...this.settings.imageTranslation, ...this.saving?.patch };
  }

  private fastProvider(): FastProviderId {
    return this.saving?.fastProvider ?? this.settings.provider.fastProvider;
  }

  private provider(image = this.effective()): LanguageProviderId {
    return image.mode === "ai"
      ? this.settings.provider.aiProvider
      : this.fastProvider();
  }

  private pairOk(): boolean {
    const image = this.effective();
    return pairAvailable(
      this.provider(image),
      image.sourceLanguage,
      image.targetLanguage,
      this.context.capabilities(),
    );
  }

  private pending(): ImagePending | undefined {
    const current = this.tracker.current;
    if (!current) return undefined;
    if (current.id === "stop")
      return this.pendingClear ? "clearing" : "stopping";
    return "starting";
  }

  // --- actions --------------------------------------------------------------

  /** Runs a card action; resolves with the request outcome. */
  async runAction(id: ImageActionId): Promise<PendingRunResult | "ignored"> {
    const baseline = KIND_OF_STATE[this.status.state];
    const cb = this.callbacks;
    let result: PendingRunResult;
    switch (id) {
      case "translate": {
        const start = cb.onImageStart;
        if (!start) return "ignored";
        this.notice = undefined;
        result = await this.tracker.run(
          { id: "translate", label: "starting", baseline },
          () => start(),
        );
        break;
      }
      case "stop":
      case "clear": {
        const cancel = cb.onImageCancelOrClear;
        if (!cancel) return "ignored";
        this.notice = undefined;
        this.pendingClear = id === "clear";
        result = await this.tracker.run(
          {
            id: "stop",
            ...(id === "stop" ? { label: "stopping" as const } : {}),
            baseline,
          },
          () => cancel(),
        );
        break;
      }
      case "openSettings":
        this.context.openSettings("ocr");
        return "done";
      case "openProviderSettings":
        this.context.openSettings("providers");
        return "done";
    }
    if (result === "failed") {
      this.notice = "floatingImageActionFailed";
      this.context.focus(HEAD_SELECTOR);
      this.context.requestRender();
    }
    return result;
  }

  private async save(
    change: Partial<ImageTranslationSettings>,
    fastProvider?: FastProviderId,
  ): Promise<boolean> {
    const onChange = this.callbacks.onImageSettingsChange;
    if (this.saving || !onChange) return false;
    const patch: ImageTranslationSettings = { ...this.effective(), ...change };
    const saving: SavingImage = {
      revision: this.settingsRevision,
      patch,
      ...(fastProvider ? { fastProvider } : {}),
    };
    this.saving = saving;
    this.notice = undefined;
    this.context.requestRender();
    let succeeded = false;
    try {
      await (fastProvider ? onChange(patch, fastProvider) : onChange(patch));
      succeeded = true;
    } catch {
      this.notice = "settingsSaveFailed";
    }
    if (this.saving === saving) {
      if (succeeded && this.settingsRevision === saving.revision) {
        this.settings = {
          ...this.settings,
          provider: fastProvider
            ? { ...this.settings.provider, fastProvider }
            : this.settings.provider,
          imageTranslation: patch,
        };
      }
      this.saving = undefined;
    }
    this.context.requestRender();
    return succeeded;
  }

  private changeLanguage(role: "source" | "target", value: string): void {
    const list = role === "source" ? SOURCE_LANGUAGES : TARGET_LANGUAGES;
    if (!list.some((language) => language.code === value)) return;
    const image = this.effective();
    if (
      value ===
      (role === "source" ? image.sourceLanguage : image.targetLanguage)
    )
      return;
    void this.save(
      role === "source" ? { sourceLanguage: value } : { targetLanguage: value },
    );
  }

  private changeMethod(value: string): void {
    const method = parseTranslationMethod(value);
    if (!method) return;
    const image = this.effective();
    if (
      value === translationMethodValue(image.mode, this.fastProvider()) ||
      (method.mode === "ai" && image.mode === "ai")
    )
      return;
    void this.save({ mode: method.mode }, method.fastProvider);
  }

  private changeDisplay(value: string): void {
    if (value !== "bilingual" && value !== "translated") return;
    const mode: DisplayMode = value;
    if (mode === this.effective().displayMode) return;
    void this.save({ displayMode: mode });
  }

  private toggle(): void {
    this.expanded = !this.expanded;
    this.context.requestRender();
  }

  // --- rendering ------------------------------------------------------------

  render(): TemplateResult {
    const image = this.effective();
    const phase = imagePhase(this.status, image.enabled);
    return html`${renderSectionHead({
        id: "nt-image-body",
        title: message("floatingImageTitle"),
        state: message(IMAGE_PHASE_KEYS[phase]),
        phase,
        expanded: this.expanded,
        onToggle: () => this.toggle(),
      })}
      <div
        id="nt-image-body"
        class="sec-body"
        role="group"
        aria-label=${message("floatingImageSettings")}
        ?hidden=${!this.expanded}
      >
        ${this.expanded ? this.renderBody() : nothing}
      </div>`;
  }

  private renderBody(): TemplateResult {
    const image = this.effective();
    const busy = this.saving !== undefined;
    const canEdit = this.callbacks.onImageSettingsChange !== undefined;
    const pairOk = this.pairOk();
    const valueOf = (event: Event): string => {
      const value = (event as CustomEvent<{ value?: unknown }>).detail?.value;
      return typeof value === "string" ? value : "";
    };
    const provider = this.provider(image);
    const snapshot = this.context.capabilities();
    const displayOptions: NtSegmentOption[] = [
      { value: "bilingual", label: message("displayBilingual") },
      { value: "translated", label: message("displayTranslated") },
    ];
    const enabledShown = image.enabled && this.status.state !== "disabled";
    return html`<nt-note icon="shield" data-image="privacy"
        >${message("imageTranslationPrivacy")}</nt-note
      >
      ${
        this.notice
          ? html`<nt-note
              class="notice"
              data-image="notice"
              tone="warn"
              icon="warning"
              >${message(this.notice)}</nt-note
            >`
          : nothing
      }
      ${
        canEdit
          ? html`<nt-switch
              compact
              data-field="image-enabled"
              label=${message("imageTranslationEnabled")}
              .checked=${live(image.enabled)}
              ?disabled=${busy || isImageRunning(this.status)}
              @change=${(event: Event) =>
                void this.save({
                  enabled: Boolean(
                    (event as CustomEvent<{ checked?: unknown }>).detail
                      ?.checked,
                  ),
                })}
            ></nt-switch>`
          : nothing
      }
      ${image.enabled ? this.renderCard(enabledShown, pairOk) : nothing}
      ${
        image.enabled && !pairOk
          ? html`<nt-note data-image="pair" tone="warn" icon="warning"
              >${message("floatingPairUnavailable")}</nt-note
            >`
          : nothing
      }
      ${
        image.enabled && canEdit
          ? html`<div class="row">
                <nt-select
                  compact
                  data-field="image-source"
                  label=${message("sourceLanguage")}
                  .options=${languageOptions("source", provider, image.sourceLanguage, snapshot)}
                  .value=${live(image.sourceLanguage)}
                  ?disabled=${busy}
                  @change=${(event: Event) =>
                    this.changeLanguage("source", valueOf(event))}
                ></nt-select>
                <nt-select
                  compact
                  data-field="image-target"
                  label=${message("targetLanguage")}
                  .options=${languageOptions("target", provider, image.targetLanguage, snapshot)}
                  .value=${live(image.targetLanguage)}
                  ?disabled=${busy}
                  @change=${(event: Event) =>
                    this.changeLanguage("target", valueOf(event))}
                ></nt-select>
              </div>
              <nt-select
                compact
                data-field="image-method"
                label=${message("translationMode")}
                .options=${methodOptions()}
                .value=${live(translationMethodValue(image.mode, this.fastProvider()))}
                ?disabled=${busy}
                @change=${(event: Event) => this.changeMethod(valueOf(event))}
              ></nt-select>
              <nt-segmented
                data-field="image-display"
                label=${message("displayMode")}
                .options=${displayOptions}
                .value=${live(image.displayMode)}
                ?disabled=${busy}
                @change=${(event: Event) => this.changeDisplay(valueOf(event))}
              ></nt-segmented>`
          : nothing
      }`;
  }

  private renderCard(enabled: boolean, pairOk: boolean): TemplateResult {
    // Settings say "on" before the controller confirms; show the idle card.
    const status: ImageTranslationStatus = enabled
      ? this.status
      : { ...this.status, state: "idle" };
    const view = imageCardView({
      status,
      pending: this.pending(),
      pairAvailable: pairOk,
    });
    const title = viewText(view.title);
    const details = view.diagnostics?.slice(0, MAX_DETAILS_LENGTH);
    return html`<nt-status-card
      class="status"
      data-image-card=${status.state}
      state=${view.state}
      heading=${title}
      count=${view.count ? viewText(view.count) : ""}
      description=${view.description ? viewText(view.description) : ""}
      .progress=${view.progress}
      progress-label=${title}
      ?quiet=${status.state === "translating"}
    >
      ${view.primary ? this.renderAction(view.primary, true) : nothing}
      ${view.secondary.map((item) => this.renderAction(item, false))}
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
    item: ImageCardAction,
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
}
