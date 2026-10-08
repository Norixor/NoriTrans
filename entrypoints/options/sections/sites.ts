import { html, nothing, type TemplateResult } from "lit";
import { message } from "@/src/shared/i18n";
import type { SiteProfileDocument } from "@/src/site-profiles/document";
import type {
  SitePageTranslationOverride,
  SiteSelectionTranslationOverride,
  SiteSubtitleTranslationOverride,
  SiteSurfaceTranslationOverride,
} from "@/src/site-profiles/types";
import {
  parseTranslationMethod,
  TRANSLATION_METHODS,
  translationMethodValue,
} from "@/src/shared/translation-methods";
import { SITE_PROFILE_PARSER_ALLOWLIST } from "@/src/subtitles/profiles/registry";
import type { NtSegmentOption, NtSelectOption } from "@/src/ui/components";
import {
  advanced,
  detailChecked,
  detailValue,
  feedback,
  groupCard,
  languageOptions,
  responseModeOptions,
  row,
  switchRow,
  type SectionContext,
} from "./common";
import {
  siteProfileTemplate,
  splitLines,
  type SiteFeedback,
  type SiteProfileEntry,
  type SiteProfileKind,
  type SiteProfilesController,
  type SiteSurface,
} from "../site-profiles";

const KIND_LABEL: Record<SiteProfileKind, string> = {
  builtin: "profileKindBuiltin",
  override: "profileKindOverride",
  user: "profileKindUser",
  site: "profileKindUser",
  new: "profileUnsaved",
};

const KIND_NOTE: Record<SiteProfileKind, string> = {
  builtin: "profileBuiltinEditNote",
  override: "profileOverrideEditNote",
  user: "profileUserEditNote",
  site: "profileUserEditNote",
  new: "profileNewEditNote",
};

const SURFACE_TITLE: Record<SiteSurface, string> = {
  page: "profilePageTitle",
  selection: "profileSelectionTitle",
  subtitles: "profileSubtitleTitle",
};

const SURFACE_HELP: Record<SiteSurface, string> = {
  page: "profilePageDescription",
  selection: "profileSelectionDescription",
  subtitles: "profileSubtitleDescription",
};

function feedbackLine(value: SiteFeedback | undefined, id: string) {
  return feedback(
    value ? message(value.key, value.subs ?? []) : "",
    value?.tone ?? "",
    id,
  );
}

function methodOptions(): NtSelectOption[] {
  return TRANSLATION_METHODS.map((method) => ({
    value: method.value,
    label: message(method.labelKey),
  }));
}

function displayOptions(surface: SiteSurface): NtSegmentOption[] {
  if (surface === "page") {
    return [
      { value: "bilingual", label: message("pageDisplayAppend") },
      { value: "translated", label: message("pageDisplayReplace") },
    ];
  }
  const options: NtSegmentOption[] = [
    { value: "bilingual", label: message("displayBilingual") },
    { value: "translated", label: message("displayTranslated") },
  ];
  if (surface === "subtitles") {
    options.push({ value: "original", label: message("displayOriginal") });
  }
  return options;
}

function positionOptions(): NtSegmentOption[] {
  return [
    { value: "top", label: message("subtitlePositionTop") },
    { value: "center", label: message("subtitlePositionCenter") },
    { value: "bottom", label: message("subtitlePositionBottom") },
    { value: "custom", label: message("subtitlePositionCustom") },
  ];
}

// List ----------------------------------------------------------------------

function entryButton(
  entry: SiteProfileEntry,
  sites: SiteProfilesController,
): TemplateResult {
  return html`<li>
    <button
      type="button"
      class="site-entry"
      id=${`site-entry-${entry.id}`}
      data-kind=${entry.kind}
      @click=${() => sites.open(entry)}
    >
      <span class="site-entry-main">
        <strong>${entry.name}</strong>
        <span class="site-entry-hosts">${entry.hostnames.join(", ")}</span>
      </span>
      <span class="site-entry-meta">
        ${
          entry.surfaces.length > 0
            ? entry.surfaces.map(
                (surface) =>
                  html`<nt-chip>${message(SURFACE_TITLE[surface])}</nt-chip>`,
              )
            : html`<span class="help"
                >${message("profileInheritsGlobal")}</span
              >`
        }
        <nt-chip>${message(KIND_LABEL[entry.kind])}</nt-chip>
      </span>
      <svg class="chev" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M10 8l4 4-4 4"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </li>`;
}

function entryList(
  id: string,
  title: string,
  entries: SiteProfileEntry[],
  sites: SiteProfilesController,
): TemplateResult {
  return html`<div class="site-list-group">
    <h3 id=${`${id}-title`}>
      ${title} <span class="count">${entries.length}</span>
    </h3>
    ${
      entries.length > 0
        ? html`<ul class="site-list" id=${id} aria-labelledby=${`${id}-title`}>
            ${entries.map((entry) => entryButton(entry, sites))}
          </ul>`
        : html`<p class="help">${message("profileCatalogGroupEmpty")}</p>`
    }
  </div>`;
}

function listView(sites: SiteProfilesController): TemplateResult {
  const { builtIn, custom } = sites.entries();
  const body =
    sites.status === "loading"
      ? html`<p class="help" role="status">${message("profileLoading")}</p>`
      : html`${entryList(
          "site-list-custom",
          message("customProfiles"),
          custom,
          sites,
        )}
        ${entryList(
          "site-list-builtin",
          message("builtInProfiles"),
          builtIn,
          sites,
        )}`;
  return groupCard(
    "opt-sites",
    message("siteProfiles"),
    [
      html`<p class="r-note help">
        ${message("siteProfilesEditorDescription")}
      </p>`,
      html`<div
        class="r r-full site-catalog"
        aria-busy=${sites.status === "loading" ? "true" : "false"}
      >
        ${body} ${feedbackLine(sites.feedback, "site-profiles-message")}
      </div>`,
    ],
    {
      headerExtra: html`<nt-button
        id="site-profile-new"
        variant="primary"
        @click=${() => sites.openNew()}
        >${message("profileNew")}</nt-button
      >`,
    },
  );
}

// Detail --------------------------------------------------------------------

type SurfaceValue =
  | SitePageTranslationOverride
  | SiteSelectionTranslationOverride
  | SiteSubtitleTranslationOverride;

function surfaceFields(
  context: SectionContext,
  sites: SiteProfilesController,
  surface: SiteSurface,
  value: SurfaceValue,
): unknown[] {
  const id = (name: string) => `site-${surface}-${name}`;
  const patch = (fields: Partial<SurfaceValue>) =>
    sites.patchSurface(surface, fields);
  const ai = value.mode === "ai";
  const displayLabel =
    surface === "subtitles" ? "subtitleDisplayMode" : "displayMode";
  const provider = ai
    ? context.settings.provider.aiProvider
    : value.fastProvider;
  const fields: unknown[] = [
    row(
      message("optLanguages"),
      undefined,
      html`<div class="grid2">
        <nt-select
          id=${id("source-language")}
          label=${message("sourceLanguage")}
          .options=${languageOptions(
            "source",
            provider,
            context.capabilities,
            value.sourceLanguage,
          )}
          .value=${value.sourceLanguage}
          @change=${(event: Event) =>
            patch({ sourceLanguage: detailValue<string>(event) })}
        ></nt-select>
        <nt-select
          id=${id("target-language")}
          label=${message("targetLanguage")}
          .options=${languageOptions(
            "target",
            provider,
            context.capabilities,
            value.targetLanguage,
          )}
          .value=${value.targetLanguage}
          @change=${(event: Event) =>
            patch({ targetLanguage: detailValue<string>(event) })}
        ></nt-select>
      </div>`,
    ),
    row(
      message("profileTranslationMethod"),
      undefined,
      html`<nt-select
        id=${id("method")}
        label=${message("profileTranslationMethod")}
        hide-label
        .options=${methodOptions()}
        .value=${translationMethodValue(value.mode, value.fastProvider)}
        @change=${(event: Event) => {
          const method = parseTranslationMethod(detailValue<string>(event));
          if (!method) return;
          const next: Partial<SiteSurfaceTranslationOverride> = {
            mode: method.mode,
          };
          if (method.fastProvider) next.fastProvider = method.fastProvider;
          patch(next);
        }}
      ></nt-select>`,
    ),
  ];
  if (ai) {
    fields.push(
      row(
        message("model"),
        undefined,
        html`<nt-text-field
          id=${id("model")}
          label=${message("model")}
          hide-label
          placeholder=${message("profileModelPlaceholder")}
          .value=${value.modelOverride}
          @change=${(event: Event) =>
            patch({ modelOverride: detailValue<string>(event).trim() })}
        ></nt-text-field>`,
      ),
      row(
        message("aiResponseMode"),
        undefined,
        html`<nt-segmented
          id=${id("response-mode")}
          label=${message("aiResponseMode")}
          .options=${responseModeOptions()}
          .value=${value.aiResponseMode ?? "stream"}
          @change=${(event: Event) =>
            patch({
              aiResponseMode:
                detailValue<string>(event) === "batch" ? "batch" : "stream",
            })}
        ></nt-segmented>`,
      ),
    );
  }
  fields.push(
    row(
      message(displayLabel),
      undefined,
      html`<nt-segmented
        id=${id("display-mode")}
        label=${message(displayLabel)}
        .options=${displayOptions(surface)}
        .value=${value.displayMode ?? (surface === "page" ? "translated" : "bilingual")}
        @change=${(event: Event) =>
          patch({ displayMode: detailValue<string>(event) } as never)}
      ></nt-segmented>`,
    ),
  );
  const toggle = (name: string, label: string, checked: boolean, key: string) =>
    switchRow(
      html`<nt-switch
        id=${id(name)}
        label=${message(label)}
        ?checked=${checked}
        @change=${(event: Event) => patch({ [key]: detailChecked(event) })}
      ></nt-switch>`,
    );
  if (surface === "page") {
    const page = value as SitePageTranslationOverride;
    fields.push(
      toggle(
        "auto-translate",
        "profileAutoTranslate",
        page.autoTranslate ?? false,
        "autoTranslate",
      ),
      toggle(
        "floating-button",
        "profileFloatingButton",
        page.floatingButtonEnabled ?? true,
        "floatingButtonEnabled",
      ),
    );
  } else if (surface === "selection") {
    const selection = value as SiteSelectionTranslationOverride;
    fields.push(
      toggle(
        "enabled",
        "profileSelectionEnabled",
        selection.enabled ?? true,
        "enabled",
      ),
    );
  } else {
    fields.push(...subtitleFields(sites, value));
  }
  return fields;
}

function subtitleFields(
  sites: SiteProfilesController,
  value: SiteSubtitleTranslationOverride,
): unknown[] {
  const patch = (fields: Partial<SiteSubtitleTranslationOverride>) =>
    sites.patchSurface("subtitles", fields);
  const position = value.position ?? "bottom";
  const custom = value.customPosition ?? { x: 0.5, y: 0.82 };
  const coordinate = (axis: "x" | "y", label: string) =>
    html`<nt-text-field
      id=${`site-subtitles-custom-${axis}`}
      label=${message(label)}
      type="number"
      min="0"
      max="1"
      inputmode="decimal"
      .value=${String(custom[axis])}
      @change=${(event: Event) => {
        const number = Number(detailValue<string>(event));
        if (!Number.isFinite(number)) return;
        patch({
          customPosition: {
            ...custom,
            [axis]: Math.min(1, Math.max(0, number)),
          },
        });
      }}
    ></nt-text-field>`;
  return [
    row(
      message("subtitlePosition"),
      undefined,
      html`<nt-segmented
          id="site-subtitles-position"
          label=${message("subtitlePosition")}
          .options=${positionOptions()}
          .value=${position}
          @change=${(event: Event) =>
            patch({ position: detailValue<string>(event) } as never)}
        ></nt-segmented>
        ${
          position === "custom"
            ? html`<div class="grid2">
                ${coordinate("x", "profileCustomPositionX")}
                ${coordinate("y", "profileCustomPositionY")}
              </div>`
            : nothing
        }`,
    ),
    row(
      message("subtitleFontSize"),
      undefined,
      html`<nt-stepper
        id="site-subtitles-font-scale"
        hide-label
        label=${message("subtitleFontSize")}
        .value=${value.fontScale ?? 1.2}
        min="0.75"
        max="1.8"
        step="0.05"
        scale="100"
        unit="%"
        decrement-label=${message("subtitleFontDecrease")}
        increment-label=${message("subtitleFontIncrease")}
        @change=${(event: Event) =>
          patch({ fontScale: detailValue<number>(event) })}
      ></nt-stepper>`,
    ),
    row(
      message("subtitleBackground"),
      undefined,
      html`<nt-slider
        id="site-subtitles-background-opacity"
        label=${message("subtitleBackground")}
        .value=${value.backgroundOpacity ?? 0.5}
        min="0.3"
        max="0.95"
        step="0.05"
        .format=${(number: number) => `${Math.round(number * 100)}%`}
        @change=${(event: Event) =>
          patch({ backgroundOpacity: detailValue<number>(event) })}
      ></nt-slider>`,
    ),
    ...(
      [
        ["enabled", "profileSubtitleEnabled", value.enabled ?? true],
        [
          "floatingButtonEnabled",
          "profileFloatingButton",
          value.floatingButtonEnabled ?? true,
        ],
        [
          "hideNativeSubtitles",
          "profileHideNative",
          value.hideNativeSubtitles ?? false,
        ],
      ] as const
    ).map(([key, label, checked]) =>
      switchRow(
        html`<nt-switch
          id=${`site-subtitles-${key}`}
          label=${message(label)}
          ?checked=${checked}
          @change=${(event: Event) => patch({ [key]: detailChecked(event) })}
        ></nt-switch>`,
      ),
    ),
  ];
}

function surfaceCard(
  context: SectionContext,
  sites: SiteProfilesController,
  surface: SiteSurface,
): TemplateResult {
  const value = sites.doc.overrides[surface];
  return html`<section
    class="site-surface"
    aria-label=${message(SURFACE_TITLE[surface])}
    data-overridden=${value ? "true" : "false"}
  >
    <div class="r sw-row">
      <nt-switch
        id=${`site-${surface}-override`}
        label=${message(SURFACE_TITLE[surface])}
        description=${
          value
            ? message(SURFACE_HELP[surface])
            : message("profileInheritsGlobal")
        }
        ?checked=${Boolean(value)}
        @change=${(event: Event) =>
          sites.setSurfaceOverride(surface, detailChecked(event))}
      ></nt-switch>
    </div>
    ${value ? surfaceFields(context, sites, surface, value) : nothing}
  </section>`;
}

function captureFields(sites: SiteProfilesController): unknown[] {
  const capture = sites.doc.subtitleCapture;
  const locked = !capture.customized;
  const lines = (
    id: string,
    label: string,
    value: string[],
    apply: (lines: string[]) => void,
  ) =>
    row(
      message(label),
      message("profileOnePerLine"),
      html`<nt-text-field
        id=${id}
        label=${message(label)}
        hide-label
        multiline
        rows="3"
        ?disabled=${locked}
        .value=${value.join("\n")}
        @change=${(event: Event) => apply(splitLines(detailValue<string>(event)))}
      ></nt-text-field>`,
    );
  return [
    switchRow(
      html`<nt-switch
        id="site-capture-customized"
        label=${message("profileCaptureOverrideToggle")}
        description=${message(
          capture.customized ? "optSiteCaptureHelp" : "profileCaptureBuiltin",
        )}
        ?checked=${capture.customized}
        @change=${(event: Event) =>
          sites.setCaptureCustomized(detailChecked(event))}
      ></nt-switch>`,
    ),
    html`<div class="r r-full">
      <nt-note icon="shield">${message("profileCaptureNarrowOnly")}</nt-note>
    </div>`,
    row(
      message("profileCaptureParser"),
      message("profileFieldParser", SITE_PROFILE_PARSER_ALLOWLIST.join(", ")),
      html`<nt-select
        id="site-capture-parser"
        label=${message("profileCaptureParser")}
        hide-label
        ?disabled=${locked}
        .options=${SITE_PROFILE_PARSER_ALLOWLIST.map((parser) => ({
          value: parser,
          label: parser,
        }))}
        .value=${capture.parser}
        @change=${(event: Event) =>
          sites.patchCapture({
            parser:
              detailValue<(typeof SITE_PROFILE_PARSER_ALLOWLIST)[number]>(
                event,
              ),
          })}
      ></nt-select>`,
    ),
    row(
      message("profileCapturePriority"),
      undefined,
      html`<nt-text-field
        id="site-capture-priority"
        label=${message("profileCapturePriority")}
        hide-label
        type="number"
        inputmode="numeric"
        ?disabled=${locked}
        .value=${String(capture.priority)}
        @change=${(event: Event) => {
          const priority = Number(detailValue<string>(event));
          if (Number.isFinite(priority)) sites.patchCapture({ priority });
        }}
      ></nt-text-field>`,
    ),
    row(
      message("profileCaptureFormats"),
      undefined,
      html`<div class="checks" role="group" id="site-capture-formats">
        ${(["vtt", "ttml", "json3"] as const).map(
          (format) =>
            html`<label class="check">
              <input
                type="checkbox"
                value=${format}
                ?disabled=${locked}
                .checked=${capture.capture.formats.includes(format)}
                @change=${(event: Event) => {
                  const on = (event.currentTarget as HTMLInputElement).checked;
                  const formats = capture.capture.formats.filter(
                    (item) => item !== format,
                  );
                  if (on) formats.push(format);
                  sites.patchCapture({ capture: { formats } });
                }}
              />
              <span>${format.toUpperCase()}</span>
            </label>`,
        )}
      </div>`,
    ),
    row(
      message("profileCaptureVideoSelector"),
      undefined,
      html`<nt-text-field
        id="site-capture-video-selector"
        label=${message("profileCaptureVideoSelector")}
        hide-label
        ?disabled=${locked}
        .value=${capture.selectors.video}
        @change=${(event: Event) =>
          sites.patchCapture({
            selectors: { video: detailValue<string>(event).trim() },
          })}
      ></nt-text-field>`,
    ),
    lines(
      "site-capture-caption-selectors",
      "profileCaptureCaptionSelectors",
      capture.selectors.captions,
      (captions) => sites.patchCapture({ selectors: { captions } }),
    ),
    lines(
      "site-capture-native-selectors",
      "profileCaptureNativeSelectors",
      capture.selectors.nativeCaptions,
      (nativeCaptions) => sites.patchCapture({ selectors: { nativeCaptions } }),
    ),
    lines(
      "site-capture-hostnames",
      "profileCaptureHostnames",
      capture.capture.allowedHostnameSuffixes,
      (allowedHostnameSuffixes) =>
        sites.patchCapture({ capture: { allowedHostnameSuffixes } }),
    ),
    lines(
      "site-capture-url-patterns",
      "profileCaptureUrlPatterns",
      capture.capture.urlPatterns,
      (urlPatterns) => sites.patchCapture({ capture: { urlPatterns } }),
    ),
    lines(
      "site-capture-complete-patterns",
      "profileCaptureCompletePatterns",
      capture.capture.completeFilePatterns ?? [],
      (completeFilePatterns) =>
        sites.patchCapture({ capture: { completeFilePatterns } }),
    ),
  ];
}

const FIELD_REFERENCE: readonly [string, string][] = [
  ["id / version / name", "profileFieldIdentity"],
  ["overrides", "profileFieldOverrides"],
  ["subtitleCapture.customized", "profileFieldCaptureCustomized"],
  ["match", "profileFieldMatch"],
  ["subtitleCapture.selectors / capture", "profileFieldCapture"],
];

function developerFields(sites: SiteProfilesController): unknown[] {
  const template = siteProfileTemplate();
  return [
    html`<p class="r-note help">${message("profileAdvancedDescription")}</p>`,
    html`<div class="r r-full">
      <nt-text-field
        id="site-profile-json"
        label=${message("profileJsonLabel")}
        description=${message("profileJsonEditorDescription")}
        multiline
        rows="14"
        spellcheck="false"
        ?invalid=${Boolean(sites.jsonError)}
        error=${
          sites.jsonError
            ? message(sites.jsonError.key, sites.jsonError.subs ?? [])
            : ""
        }
        .value=${sites.jsonText}
        @change=${(event: Event) => sites.applyJson(detailValue<string>(event))}
      ></nt-text-field>
    </div>`,
    html`<div class="r r-full">
      <div class="actions">
        <nt-button
          id="site-profile-format"
          variant="secondary"
          @click=${() => sites.applyJson(sites.jsonText, { reformat: true })}
          >${message("profileFormatJson")}</nt-button
        >
        <nt-button
          id="site-profile-copy"
          variant="secondary"
          @click=${() => void sites.copy(sites.jsonText)}
          >${message("profileCopyJson")}</nt-button
        >
        <nt-button
          id="site-profile-import"
          variant="secondary"
          @click=${(event: Event) =>
            (event.currentTarget as HTMLElement)
              .closest(".actions")
              ?.querySelector<HTMLInputElement>("input[type=file]")
              ?.click()}
          >${message("profileFileImport")}</nt-button
        >
        <input
          id="site-profile-file"
          type="file"
          accept="application/json,.json"
          hidden
          @change=${(event: Event) => {
            const input = event.currentTarget as HTMLInputElement;
            const file = input.files?.[0];
            input.value = "";
            void sites.importFile(file);
          }}
        />
        <nt-button
          id="site-profile-export"
          variant="secondary"
          @click=${() => sites.exportFile()}
          >${message("profileFileExport")}</nt-button
        >
      </div>
    </div>`,
    html`<div class="r r-full site-reference">
      <h4>${message("profileTemplateAndFields")}</h4>
      <p class="help">${message("profileTemplateDescription")}</p>
      <pre id="site-profile-template" tabindex="0">${template}</pre>
      <div class="actions">
        <nt-button
          id="site-profile-copy-template"
          variant="ghost"
          @click=${() => void sites.copy(template)}
          >${message("profileCopyTemplate")}</nt-button
        >
      </div>
      <dl class="site-fields">
        ${FIELD_REFERENCE.map(
          ([term, key]) =>
            html`<dt><code>${term}</code></dt>
              <dd>${message(key)}</dd>`,
        )}
        <dt><code>subtitleCapture.parser / priority</code></dt>
        <dd>
          ${message("profileFieldParser", SITE_PROFILE_PARSER_ALLOWLIST.join(", "))}
        </dd>
      </dl>
    </div>`,
  ];
}

function detailView(
  context: SectionContext,
  sites: SiteProfilesController,
): TemplateResult {
  const doc: SiteProfileDocument = sites.doc;
  const busy = sites.busy;
  return html`<div class="site-detail">
    <div class="site-detail-nav">
      <nt-button
        id="site-profile-back"
        variant="ghost"
        @click=${() => void sites.back()}
        >${message("optSiteBack")}</nt-button
      >
    </div>
    ${groupCard(
      "site-detail",
      doc.name || message("profileNew"),
      [
        html`<p class="r-note help">${message(KIND_NOTE[sites.kind])}</p>`,
        row(
          message("profileName"),
          undefined,
          html`<nt-text-field
            id="site-profile-name"
            label=${message("profileName")}
            hide-label
            placeholder=${message("profileNamePlaceholder")}
            .value=${doc.name}
            @change=${(event: Event) => sites.setName(detailValue<string>(event))}
          ></nt-text-field>`,
        ),
        row(
          message("profileHostname"),
          message("profileHostnameHelp"),
          html`<nt-text-field
            id="site-profile-hostname"
            label=${message("profileHostname")}
            hide-label
            placeholder=${message("profileHostnamePlaceholder")}
            .value=${doc.match.hostnameSuffixes[0] ?? ""}
            @change=${(event: Event) =>
              sites.setHostname(detailValue<string>(event))}
          ></nt-text-field>`,
        ),
        html`<div class="r r-full">
          <nt-note>${message("profileDefaultsDescription")}</nt-note>
        </div>`,
      ],
      {
        headerExtra: html`<nt-chip data-kind=${sites.kind}
          >${message(KIND_LABEL[sites.kind])}</nt-chip
        >`,
      },
    )}
    <section class="grp" aria-labelledby="site-overrides-title">
      <header>
        <h2 id="site-overrides-title">${message("profileDefaultsTitle")}</h2>
      </header>
      <div class="rows">
        ${(["page", "selection", "subtitles"] as const).map((surface) =>
          surfaceCard(context, sites, surface),
        )}
      </div>
      ${advanced(
        "site-capture",
        message("profileCaptureTitle"),
        captureFields(sites),
      )}
      ${advanced(
        "site-developer",
        message("profileFileOpen"),
        developerFields(sites),
      )}
    </section>
    <div
      class="site-savebar"
      role="group"
      aria-label=${message("profileEditor")}
    >
      ${feedbackLine(sites.feedback, "site-profile-message")}
      <span class="help"
        >${message(sites.dirty ? "optSiteUnsaved" : "optSiteSaveHint")}</span
      >
      <div class="actions">
        ${
          sites.kind === "override"
            ? html`<nt-button
                id="site-profile-restore"
                variant="ghost"
                ?busy=${busy === "restore"}
                @click=${() => void sites.restoreBuiltIn()}
                >${message("profileRestoreBuiltin")}</nt-button
              >`
            : nothing
        }
        ${
          sites.deletable
            ? html`<nt-button
                id="site-profile-delete"
                variant="danger"
                ?busy=${busy === "delete"}
                @click=${() => void sites.remove()}
                >${message("deleteProfile")}</nt-button
              >`
            : nothing
        }
        <nt-button
          id="site-profile-cancel"
          variant="secondary"
          ?disabled=${!sites.dirty}
          @click=${() => sites.cancel()}
          >${message("cancel")}</nt-button
        >
        <nt-button
          id="site-profile-save"
          variant="primary"
          ?busy=${busy === "save"}
          @click=${() => void sites.save()}
          >${message(
            sites.kind === "builtin" ? "profileSaveOverride" : "profileSave",
          )}</nt-button
        >
      </div>
    </div>
  </div>`;
}

export function sitesSection(
  context: SectionContext,
  sites: SiteProfilesController,
): TemplateResult {
  return sites.view === "detail" ? detailView(context, sites) : listView(sites);
}
