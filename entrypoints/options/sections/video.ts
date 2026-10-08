import { html, nothing, type TemplateResult } from "lit";
import { message } from "@/src/shared/i18n";
import type {
  SubtitleDisplayMode,
  SubtitlePosition,
} from "@/src/shared/settings";
import type { TranslationMode } from "@/src/translation/types";
import {
  advanced,
  detailChecked,
  detailValue,
  feedback,
  groupCard,
  languageOptions,
  modeOptions,
  responseModeOptions,
  row,
  surfaceProvider,
  switchRow,
  type SectionContext,
} from "./common";
import type { Feedback } from "./services";

export interface VideoSectionState {
  /** Image recognition pack panel (rendered by `RuntimePanels`). */
  recognitionPanel?: unknown;
  ocrFeedback?: Feedback | undefined;
}

export interface VideoSectionActions {
  /** Turns OCR on or off; turning it on asks for the capture permission. */
  setOcrEnabled(enabled: boolean): void;
}

const percent = (value: number): string =>
  message("percentageValue", String(Math.round(value * 100)));

function subtitleGroup(context: SectionContext): TemplateResult {
  const subtitles = context.settings.subtitles;
  const provider = surfaceProvider(context.settings, subtitles.mode);
  return groupCard("opt-subtitles", message("subtitleTranslation"), [
    switchRow(
      html`<nt-switch
        id="subtitle-enabled"
        label=${message("subtitleEnabled")}
        description=${message("optSubtitleEnabledHelp")}
        ?checked=${subtitles.enabled}
        @change=${(event: Event) =>
          context.update({ subtitles: { enabled: detailChecked(event) } })}
      ></nt-switch>`,
    ),
    row(
      message("optLanguages"),
      undefined,
      html`<div class="grid2">
        <nt-select
          id="subtitle-source-language"
          label=${message("subtitleSourceLanguage")}
          .options=${languageOptions(
            "source",
            provider,
            context.capabilities,
            subtitles.sourceLanguage,
          )}
          .value=${subtitles.sourceLanguage}
          @change=${(event: Event) =>
            context.update({
              subtitles: { sourceLanguage: detailValue<string>(event) },
            })}
        ></nt-select>
        <nt-select
          id="subtitle-target-language"
          label=${message("subtitleTargetLanguage")}
          .options=${languageOptions(
            "target",
            provider,
            context.capabilities,
            subtitles.targetLanguage,
          )}
          .value=${subtitles.targetLanguage}
          @change=${(event: Event) =>
            context.update({
              subtitles: { targetLanguage: detailValue<string>(event) },
            })}
        ></nt-select>
      </div>`,
    ),
    row(
      message("subtitleTranslationMode"),
      undefined,
      html`<nt-segmented
          id="subtitle-mode"
          label=${message("subtitleTranslationMode")}
          .options=${modeOptions()}
          .value=${subtitles.mode}
          @change=${(event: Event) =>
            context.update({
              subtitles: { mode: detailValue<TranslationMode>(event) },
            })}
        ></nt-segmented>
        <nt-note icon="info">${message("optSubtitleAiFullOnly")}</nt-note>`,
    ),
    subtitles.mode === "ai"
      ? row(
          message("aiResponseMode"),
          undefined,
          html`<nt-segmented
            id="subtitle-response-mode"
            label=${message("aiResponseMode")}
            .options=${responseModeOptions()}
            .value=${subtitles.aiResponseMode}
            @change=${(event: Event) =>
              context.update({
                subtitles: {
                  aiResponseMode:
                    detailValue<string>(event) === "batch" ? "batch" : "stream",
                },
              })}
          ></nt-segmented>`,
        )
      : nothing,
  ]);
}

function displayGroup(
  context: SectionContext,
  state: VideoSectionState,
  actions: VideoSectionActions,
): TemplateResult {
  const subtitles = context.settings.subtitles;
  const ocr = context.settings.ocr;
  return groupCard(
    "opt-subtitle-display",
    message("subtitleSettings"),
    [
      row(
        message("subtitleDisplayMode"),
        undefined,
        html`<nt-segmented
          id="subtitle-display-mode"
          label=${message("subtitleDisplayMode")}
          .options=${[
            { value: "bilingual", label: message("displayBilingual") },
            { value: "translated", label: message("displayTranslated") },
            { value: "original", label: message("displayOriginal") },
          ]}
          .value=${subtitles.displayMode}
          @change=${(event: Event) =>
            context.update({
              subtitles: {
                displayMode: detailValue<SubtitleDisplayMode>(event),
              },
            })}
        ></nt-segmented>`,
      ),
      row(
        message("subtitlePosition"),
        message("subtitleDragHint"),
        html`<nt-segmented
          id="subtitle-position"
          label=${message("subtitlePosition")}
          .options=${[
            { value: "bottom", label: message("subtitlePositionBottom") },
            { value: "center", label: message("subtitlePositionCenter") },
            { value: "top", label: message("subtitlePositionTop") },
            { value: "custom", label: message("optSubtitlePositionCustom") },
          ]}
          .value=${subtitles.position}
          @change=${(event: Event) =>
            context.update({
              subtitles: { position: detailValue<SubtitlePosition>(event) },
            })}
        ></nt-segmented>`,
      ),
      row(
        message("subtitleFontSize"),
        undefined,
        html`<nt-stepper
          id="subtitle-font-scale"
          hide-label
          label=${message("subtitleFontSize")}
          .value=${subtitles.fontScale}
          min="0.75"
          max="1.8"
          step="0.05"
          scale="100"
          unit="%"
          decrement-label=${message("subtitleFontDecrease")}
          increment-label=${message("subtitleFontIncrease")}
          @change=${(event: Event) =>
            context.update({
              subtitles: { fontScale: detailValue<number>(event) },
            })}
        ></nt-stepper>`,
      ),
      row(
        message("subtitleBackground"),
        undefined,
        html`<nt-slider
          id="subtitle-background-opacity"
          label=${message("subtitleBackground")}
          .value=${subtitles.backgroundOpacity}
          min="0.3"
          max="0.95"
          step="0.05"
          .format=${percent}
          @change=${(event: Event) =>
            context.update({
              subtitles: { backgroundOpacity: detailValue<number>(event) },
            })}
        ></nt-slider>`,
      ),
      switchRow(
        html`<nt-switch
          id="subtitle-hide-native"
          label=${message("subtitleHideNative")}
          description=${message("optSubtitleHideNativeHelp")}
          ?checked=${subtitles.hideNativeSubtitles}
          @change=${(event: Event) =>
            context.update({
              subtitles: { hideNativeSubtitles: detailChecked(event) },
            })}
        ></nt-switch>`,
      ),
    ],
    {
      headerExtra: html`<span class="chip"
        >${message("optVideoQuickChip")}</span
      >`,
      advanced: advanced("image-recognition", message("optImageRecognition"), [
        switchRow(
          html`<nt-switch
            id="ocr-enabled"
            label=${message("optImageRecognitionEnabled")}
            description=${message("optImageRecognitionHelp")}
            ?checked=${ocr.enabled}
            @nt-before-change=${(event: Event) => {
              // The permission prompt decides; the switch follows the setting.
              event.preventDefault();
              actions.setOcrEnabled(
                (event as CustomEvent<{ checked: boolean }>).detail.checked,
              );
            }}
          ></nt-switch>`,
        ),
        state.ocrFeedback
          ? html`<div class="r r-full">
              ${feedback(
                message(state.ocrFeedback.key),
                state.ocrFeedback.tone,
              )}
            </div>`
          : nothing,
        row(
          message("optLanguages"),
          message("optRecognitionProviderLocalOnly"),
          html`<div class="grid2">
            <nt-select
              id="ocr-source-language"
              label=${message("optRecognitionLanguage")}
              .options=${languageOptions(
                "source",
                ocr.provider,
                context.capabilities,
                ocr.sourceLanguage,
              )}
              .value=${ocr.sourceLanguage}
              @change=${(event: Event) =>
                context.update({
                  ocr: { sourceLanguage: detailValue<string>(event) },
                })}
            ></nt-select>
            <nt-select
              id="ocr-target-language"
              label=${message("ocrTargetLanguage")}
              .options=${languageOptions(
                "target",
                ocr.provider,
                context.capabilities,
                ocr.targetLanguage,
              )}
              .value=${ocr.targetLanguage}
              @change=${(event: Event) =>
                context.update({
                  ocr: { targetLanguage: detailValue<string>(event) },
                })}
            ></nt-select>
          </div>`,
        ),
        row(
          message("ocrTranslationProvider"),
          undefined,
          html`<nt-segmented
            id="ocr-provider"
            label=${message("ocrTranslationProvider")}
            .options=${[
              { value: "chrome-local", label: message("providerChromeLocal") },
              {
                value: "bergamot-local",
                label: message("providerBergamotLocal"),
              },
            ]}
            .value=${ocr.provider}
            @change=${(event: Event) =>
              context.update({
                ocr: {
                  provider:
                    detailValue<string>(event) === "bergamot-local"
                      ? "bergamot-local"
                      : "chrome-local",
                },
              })}
          ></nt-segmented>`,
        ),
        html`<div class="r r-full">
          <nt-note icon="shield"
            >${message("optRecognitionPrivacyNote")}</nt-note
          >
        </div>`,
        html`<div class="r r-full">${state.recognitionPanel ?? nothing}</div>`,
      ]),
    },
  );
}

export function videoSection(
  context: SectionContext,
  state: VideoSectionState,
  actions: VideoSectionActions,
): TemplateResult {
  return html`${subtitleGroup(context)} ${displayGroup(context, state, actions)}`;
}
