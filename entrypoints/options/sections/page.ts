import { html, nothing, type TemplateResult } from "lit";
import { message } from "@/src/shared/i18n";
import type { AppSettings, DisplayMode } from "@/src/shared/settings";
import type { TranslationMode } from "@/src/translation/types";
import { AUTOSAVE_TEXT_DEBOUNCE_MS } from "../settings-store";
import {
  advanced,
  detailChecked,
  detailValue,
  groupCard,
  languageOptions,
  modeOptions,
  responseModeOptions,
  row,
  surfaceProvider,
  switchRow,
  type SectionContext,
} from "./common";

export interface PageSectionState {
  /** True once the OCR runtime list is known; null while unknown. */
  ocrRuntimeInstalled: boolean | null;
}

export interface PageSectionActions {
  openOcrRuntimes(): void;
}

/** Language pair for a surface, filtered by its effective provider. */
function languagePair(
  context: SectionContext,
  ids: { source: string; target: string },
  values: { source: string; target: string },
  mode: TranslationMode,
  onChange: (field: "source" | "target", value: string) => void,
): TemplateResult {
  const provider = surfaceProvider(context.settings, mode);
  return html`<div class="grid2">
    <nt-select
      id=${ids.source}
      label=${message("sourceLanguage")}
      .options=${languageOptions(
        "source",
        provider,
        context.capabilities,
        values.source,
      )}
      .value=${values.source}
      @change=${(event: Event) =>
        onChange("source", detailValue<string>(event))}
    ></nt-select>
    <nt-select
      id=${ids.target}
      label=${message("targetLanguage")}
      .options=${languageOptions(
        "target",
        provider,
        context.capabilities,
        values.target,
      )}
      .value=${values.target}
      @change=${(event: Event) =>
        onChange("target", detailValue<string>(event))}
    ></nt-select>
  </div>`;
}

/** Autosaved free-text field with an editing guard against external sync. */
export function autosavedText(
  context: SectionContext,
  options: {
    id: string;
    label: string;
    path: string;
    value: string;
    placeholder?: string;
    description?: string;
    disabled?: boolean;
    onValue(value: string): void;
  },
): TemplateResult {
  return html`<nt-text-field
    id=${options.id}
    hide-label
    label=${options.label}
    maxlength="256"
    placeholder=${options.placeholder ?? ""}
    description=${options.description ?? ""}
    ?disabled=${options.disabled ?? false}
    .value=${options.value}
    @focusin=${() => context.beginEditing(options.path)}
    @focusout=${() => context.endEditing(options.path)}
    @nt-input=${(event: Event) => options.onValue(detailValue<string>(event))}
  ></nt-text-field>`;
}

function siteRules(context: SectionContext): TemplateResult {
  const page = context.settings.page;
  const entries = [
    ...page.autoTranslateSitePatterns.map((pattern) => ({
      pattern,
      kind: "included" as const,
    })),
    ...page.autoTranslateExcludedSitePatterns.map((pattern) => ({
      pattern,
      kind: "excluded" as const,
    })),
  ];
  const remove = (entry: (typeof entries)[number]): void => {
    context.update({
      page:
        entry.kind === "included"
          ? {
              autoTranslateSitePatterns: page.autoTranslateSitePatterns.filter(
                (candidate) => candidate !== entry.pattern,
              ),
            }
          : {
              autoTranslateExcludedSitePatterns:
                page.autoTranslateExcludedSitePatterns.filter(
                  (candidate) => candidate !== entry.pattern,
                ),
            },
    });
  };
  return row(
    message("autoTranslateSitesTitle"),
    message("autoTranslateSitesDescription"),
    html`${
        entries.length === 0
          ? html`<p class="help">${message("autoTranslateSitesEmpty")}</p>`
          : html`<ul
              class="site-rules"
              id="auto-translate-site-list"
              aria-label=${message("autoTranslateSitesTitle")}
            >
              ${entries.map(
                (entry) =>
                  html`<li class="site-rule" data-kind=${entry.kind}>
                    <code>${entry.pattern}</code>
                    <span class="site-rule-kind"
                      >${message(
                        entry.kind === "included"
                          ? "autoTranslateRuleEnabled"
                          : "autoTranslateRuleExcluded",
                      )}</span
                    >
                    <nt-button
                      size="sm"
                      variant="ghost"
                      label=${`${message("removeAutoTranslateRule")}: ${entry.pattern}`}
                      @click=${() => remove(entry)}
                      >${message("removeAutoTranslateRule")}</nt-button
                    >
                  </li>`,
              )}
            </ul>`
      }
      <p class="help">
        ${message("optSiteRulesHint")}
        <a href="#sites">${message("optOpenSites")}</a>
      </p>`,
  );
}

function displayOptions(
  translatedKey: string,
  bilingualKey: string,
): { value: DisplayMode; label: string }[] {
  return [
    { value: "bilingual", label: message(bilingualKey) },
    { value: "translated", label: message(translatedKey) },
  ];
}

/** In-page mark options ("skipped" marks are off by default). */
function marksAdvanced(context: SectionContext): TemplateResult {
  return advanced("page-marks", message("optPageMarksTitle"), [
    switchRow(
      html`<nt-switch
        id="page-show-skipped-marks"
        label=${message("optShowSkippedMarks")}
        description=${message("optShowSkippedMarksHelp")}
        ?checked=${context.settings.page.showSkippedMarks}
        @change=${(event: Event) =>
          context.update({
            page: { showSkippedMarks: detailChecked(event) },
          })}
      ></nt-switch>`,
    ),
  ]);
}

function selectionAdvanced(context: SectionContext): TemplateResult {
  const page = context.settings.page;
  const ai = page.selectionTranslationMode === "ai";
  return advanced(
    "selection-translation",
    message("selectionTranslationTitle"),
    [
      switchRow(
        html`<nt-switch
          id="selection-translation-enabled"
          label=${message("selectionTranslationEnabled")}
          description=${message("selectionTranslationDescription")}
          ?checked=${page.selectionTranslationEnabled}
          @change=${(event: Event) =>
            context.update({
              page: { selectionTranslationEnabled: detailChecked(event) },
            })}
        ></nt-switch>`,
      ),
      html`<p class="r-note help">
        ${message("selectionTranslationSettingsNote")}
      </p>`,
      row(
        message("optLanguages"),
        undefined,
        languagePair(
          context,
          {
            source: "selection-translation-source-language",
            target: "selection-translation-target-language",
          },
          {
            source: page.selectionTranslationSourceLanguage,
            target: page.selectionTranslationTargetLanguage,
          },
          page.selectionTranslationMode,
          (field, value) =>
            context.update({
              page:
                field === "source"
                  ? { selectionTranslationSourceLanguage: value }
                  : { selectionTranslationTargetLanguage: value },
            }),
        ),
      ),
      row(
        message("selectionTranslationMode"),
        undefined,
        html`<nt-segmented
          id="selection-translation-mode"
          label=${message("selectionTranslationMode")}
          .options=${modeOptions()}
          .value=${page.selectionTranslationMode}
          @change=${(event: Event) =>
            context.update({
              page: {
                selectionTranslationMode: detailValue<TranslationMode>(event),
              },
            })}
        ></nt-segmented>`,
      ),
      ai
        ? row(
            message("aiResponseMode"),
            undefined,
            html`<nt-segmented
              id="selection-translation-response-mode"
              label=${message("aiResponseMode")}
              .options=${responseModeOptions()}
              .value=${page.selectionTranslationAiResponseMode}
              @change=${(event: Event) =>
                context.update({
                  page: {
                    selectionTranslationAiResponseMode:
                      detailValue<string>(event) === "batch"
                        ? "batch"
                        : "stream",
                  },
                })}
            ></nt-segmented>`,
          )
        : nothing,
      ai
        ? row(
            message("imageModelOverride"),
            message("imageModelOverrideHelp"),
            autosavedText(context, {
              id: "selection-translation-model-override",
              label: message("imageModelOverride"),
              path: "page.selectionTranslationModelOverride",
              value: page.selectionTranslationModelOverride,
              placeholder: message("imageModelInherit"),
              onValue: (value) =>
                context.update(
                  { page: { selectionTranslationModelOverride: value.trim() } },
                  AUTOSAVE_TEXT_DEBOUNCE_MS,
                ),
            }),
          )
        : nothing,
      row(
        message("displayMode"),
        undefined,
        html`<nt-segmented
          id="selection-translation-display-mode"
          label=${message("displayMode")}
          .options=${displayOptions("displayTranslated", "displayBilingual")}
          .value=${page.selectionTranslationDisplayMode}
          @change=${(event: Event) =>
            context.update({
              page: {
                selectionTranslationDisplayMode:
                  detailValue<DisplayMode>(event),
              },
            })}
        ></nt-segmented>`,
      ),
    ],
  );
}

function imageAdvanced(
  context: SectionContext,
  state: PageSectionState,
  actions: PageSectionActions,
): TemplateResult {
  const image = context.settings.imageTranslation;
  return advanced("image-translation", message("optImageTranslationTitle"), [
    switchRow(
      html`<nt-switch
        id="image-translation-enabled"
        label=${message("imageTranslationEnabled")}
        description=${message("imageTranslationSettingsDescription")}
        ?checked=${image.enabled}
        @change=${(event: Event) =>
          context.update({
            imageTranslation: { enabled: detailChecked(event) },
          })}
      ></nt-switch>`,
    ),
    html`<div class="r r-full">
      <nt-note icon="shield">${message("imageTranslationPrivacy")}</nt-note>
      ${
        state.ocrRuntimeInstalled === false
          ? html`<nt-note tone="warn" icon="warning" id="image-runtime-warning"
              >${message("optImageRuntimeMissing")}
              <nt-button
                size="sm"
                variant="ghost"
                @click=${() => actions.openOcrRuntimes()}
                >${message("optOpenRecognitionPacks")}</nt-button
              ></nt-note
            >`
          : nothing
      }
    </div>`,
    row(
      message("optLanguages"),
      undefined,
      languagePair(
        context,
        { source: "image-source-language", target: "image-target-language" },
        { source: image.sourceLanguage, target: image.targetLanguage },
        image.mode,
        (field, value) =>
          context.update({
            imageTranslation:
              field === "source"
                ? { sourceLanguage: value }
                : { targetLanguage: value },
          }),
      ),
    ),
    row(
      message("translationMode"),
      undefined,
      html`<nt-segmented
        id="image-mode"
        label=${message("translationMode")}
        .options=${modeOptions()}
        .value=${image.mode}
        @change=${(event: Event) =>
          context.update({
            imageTranslation: { mode: detailValue<TranslationMode>(event) },
          })}
      ></nt-segmented>`,
    ),
    image.mode === "ai"
      ? row(
          message("imageModelOverride"),
          message("imageModelOverrideHelp"),
          autosavedText(context, {
            id: "image-model-override",
            label: message("imageModelOverride"),
            path: "imageTranslation.modelOverride",
            value: image.modelOverride,
            placeholder: message("imageModelInherit"),
            onValue: (value) =>
              context.update(
                { imageTranslation: { modelOverride: value.trim() } },
                AUTOSAVE_TEXT_DEBOUNCE_MS,
              ),
          }),
        )
      : nothing,
    row(
      message("displayMode"),
      undefined,
      html`<nt-segmented
        id="image-display-mode"
        label=${message("displayMode")}
        .options=${displayOptions("displayTranslated", "displayBilingual")}
        .value=${image.displayMode}
        @change=${(event: Event) =>
          context.update({
            imageTranslation: { displayMode: detailValue<DisplayMode>(event) },
          })}
      ></nt-segmented>`,
    ),
  ]);
}

export function pageSection(
  context: SectionContext,
  state: PageSectionState,
  actions: PageSectionActions,
): TemplateResult {
  const page: AppSettings["page"] = context.settings.page;
  return html`${groupCard("opt-page", message("optPageDefaults"), [
      row(
        message("optLanguages"),
        undefined,
        languagePair(
          context,
          { source: "page-source-language", target: "page-target-language" },
          { source: page.sourceLanguage, target: page.targetLanguage },
          page.mode,
          (field, value) =>
            context.update({
              page:
                field === "source"
                  ? { sourceLanguage: value }
                  : { targetLanguage: value },
            }),
        ),
      ),
      row(
        message("translationMode"),
        message("optPageModeHelp"),
        html`<nt-segmented
          id="page-mode"
          label=${message("translationMode")}
          .options=${modeOptions()}
          .value=${page.mode}
          @change=${(event: Event) =>
            context.update({
              page: { mode: detailValue<TranslationMode>(event) },
            })}
        ></nt-segmented>`,
      ),
      page.mode === "ai"
        ? row(
            message("aiResponseMode"),
            undefined,
            html`<nt-segmented
              id="page-response-mode"
              label=${message("aiResponseMode")}
              .options=${responseModeOptions()}
              .value=${page.aiResponseMode}
              @change=${(event: Event) =>
                context.update({
                  page: {
                    aiResponseMode:
                      detailValue<string>(event) === "batch"
                        ? "batch"
                        : "stream",
                  },
                })}
            ></nt-segmented>`,
          )
        : nothing,
      row(
        message("displayMode"),
        undefined,
        html`<nt-segmented
          id="page-display-mode"
          label=${message("displayMode")}
          .options=${displayOptions("pageDisplayReplace", "pageDisplayAppend")}
          .value=${page.displayMode}
          @change=${(event: Event) =>
            context.update({
              page: { displayMode: detailValue<DisplayMode>(event) },
            })}
        ></nt-segmented>`,
      ),
      switchRow(
        html`<nt-switch
          id="page-auto-translate"
          label=${message("pageAutoTranslate")}
          description=${message("pageAutoTranslateDescription")}
          ?checked=${page.autoTranslate}
          @change=${(event: Event) =>
            context.update({ page: { autoTranslate: detailChecked(event) } })}
        ></nt-switch>`,
      ),
      siteRules(context),
    ])}
    <section class="grp" aria-labelledby="opt-page-more-title">
      <header>
        <h2 id="opt-page-more-title">${message("optPageMore")}</h2>
      </header>
      ${selectionAdvanced(context)} ${imageAdvanced(context, state, actions)}
      ${marksAdvanced(context)}
    </section>`;
}
