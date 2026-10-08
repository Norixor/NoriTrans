import { html, nothing, type TemplateResult } from "lit";
import { message } from "@/src/shared/i18n";
import {
  FAST_PROVIDER_IDS,
  type AppSettings,
  type FastProviderId,
} from "@/src/shared/settings";
import type { AiProviderDraft, FastProviderDraft } from "../credentials";
import {
  advanced,
  detailValue,
  feedback,
  groupCard,
  row,
  type SectionContext,
} from "./common";

export type Feedback = { key: string; tone: "" | "success" | "error" };

export interface ServicesState {
  /** Offline translation pack panel (rendered by `RuntimePanels`). */
  offlinePanel?: unknown;
  aiDraft: AiProviderDraft;
  aiDirty: boolean;
  aiBusy: "" | "save" | "test";
  aiFeedback?: Feedback | undefined;
  /** Secret-free connection diagnostic from the last failed test. */
  aiDiagnostic?: string | undefined;
  fastDraft: FastProviderDraft;
  fastDirty: boolean;
  fastBusy: boolean;
  fastFeedback?: Feedback | undefined;
  fastProviderFeedback?: Feedback | undefined;
}

export interface ServicesActions {
  editAi(fields: Partial<AiProviderDraft>): void;
  saveAi(test: boolean): void;
  editFast(fields: Partial<FastProviderDraft>): void;
  saveFast(): void;
  selectFastProvider(provider: FastProviderId): void;
}

/** Endpoint presets; they only fill the form and are saved by the user. */
export const AI_PRESETS = [
  {
    id: "openai",
    labelKey: "optPresetOpenAi",
    aiProvider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    labelKey: "optPresetAnthropic",
    aiProvider: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  },
] as const;

export function aiPresetId(draft: AiProviderDraft): string {
  return (
    AI_PRESETS.find(
      (preset) =>
        preset.aiProvider === draft.aiProvider &&
        preset.baseUrl === draft.baseUrl.trim().replace(/\/$/u, ""),
    )?.id ?? "custom"
  );
}

const FAST_PROVIDER_LABEL: Record<FastProviderId, string> = {
  "chrome-local": "providerChromeLocal",
  "bergamot-local": "providerBergamotLocal",
  "google-translate": "providerGoogleTranslate",
  "microsoft-translator": "providerMicrosoftTranslator",
  deepl: "providerDeepL",
};

export function fastProviderLabel(provider: FastProviderId): string {
  return message(FAST_PROVIDER_LABEL[provider]);
}

export function isLocalFastProvider(provider: FastProviderId): boolean {
  return provider === "chrome-local" || provider === "bergamot-local";
}

/** Origin AI text is sent to, for the disclosure next to the form. */
export function endpointOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

function aiGroup(
  settings: AppSettings,
  state: ServicesState,
  actions: ServicesActions,
): TemplateResult {
  const draft = state.aiDraft;
  const busy = state.aiBusy !== "";
  const preset = aiPresetId(draft);
  const destination = endpointOrigin(settings.provider.baseUrl);
  return groupCard(
    "opt-ai",
    message("optAiServiceTitle"),
    [
      row(
        message("optPreset"),
        message("optPresetHelp"),
        html`<nt-select
          id="ai-preset"
          hide-label
          label=${message("optPreset")}
          .options=${[
            ...AI_PRESETS.map((item) => ({
              value: item.id,
              label: message(item.labelKey),
            })),
            { value: "custom", label: message("optPresetCustom") },
          ]}
          .value=${preset}
          @change=${(event: Event) => {
            const chosen = AI_PRESETS.find(
              (item) => item.id === detailValue<string>(event),
            );
            if (chosen) {
              actions.editAi({
                aiProvider: chosen.aiProvider,
                baseUrl: chosen.baseUrl,
              });
            }
          }}
        ></nt-select>`,
      ),
      row(
        message("baseUrl"),
        undefined,
        html`<nt-text-field
          id="base-url"
          hide-label
          label=${message("baseUrl")}
          type="url"
          inputmode="url"
          maxlength="2048"
          required
          placeholder=${message("baseUrlPlaceholder")}
          .value=${draft.baseUrl}
          @nt-input=${(event: Event) =>
            actions.editAi({ baseUrl: detailValue<string>(event) })}
        ></nt-text-field>`,
      ),
      row(
        message("apiKey"),
        message("optApiKeyLocalOnly"),
        html`<nt-text-field
          id="api-key"
          hide-label
          label=${message("apiKey")}
          type="password"
          maxlength="10000"
          placeholder=${message("apiKeyPlaceholder")}
          description=${message("apiKeyHelp")}
          .value=${draft.apiKey}
          @nt-input=${(event: Event) =>
            actions.editAi({ apiKey: detailValue<string>(event) })}
        ></nt-text-field>`,
      ),
      row(
        message("model"),
        undefined,
        html`<nt-text-field
          id="model"
          hide-label
          label=${message("model")}
          maxlength="256"
          required
          .value=${draft.model}
          @nt-input=${(event: Event) =>
            actions.editAi({ model: detailValue<string>(event) })}
        ></nt-text-field>`,
      ),
      row(
        message("optConnection"),
        message("optSendsTo", destination),
        html`<div class="actions">
            <nt-button
              id="test-connection"
              variant="primary"
              ?busy=${state.aiBusy === "test"}
              ?disabled=${busy}
              @click=${() => actions.saveAi(true)}
              >${message("optSaveAndTest")}</nt-button
            >
            <nt-button
              id="save-provider"
              variant="ghost"
              ?busy=${state.aiBusy === "save"}
              ?disabled=${busy}
              @click=${() => actions.saveAi(false)}
              >${message("optSaveOnly")}</nt-button
            >
          </div>
          ${feedback(
            state.aiFeedback
              ? message(state.aiFeedback.key)
              : state.aiDirty
                ? message("optUnsavedProvider")
                : "",
            state.aiFeedback?.tone ?? "",
            "test-message",
          )}
          ${
            state.aiDiagnostic
              ? html`<details id="connection-diagnostic" class="diagnostic">
                  <summary>${message("connectionDetails")}</summary>
                  <pre>${state.aiDiagnostic}</pre>
                </details>`
              : nothing
          }`,
      ),
    ],
    {
      advanced: advanced("ai-advanced", message("optAiAdvanced"), [
        row(
          message("aiProvider"),
          undefined,
          html`<nt-select
            id="ai-provider"
            hide-label
            label=${message("aiProvider")}
            .options=${[
              {
                value: "openai-compatible",
                label: message("providerOpenAiCompatible"),
              },
              {
                value: "anthropic-messages",
                label: message("providerAnthropicMessages"),
              },
            ]}
            .value=${draft.aiProvider}
            @change=${(event: Event) =>
              actions.editAi({
                aiProvider:
                  detailValue<string>(event) === "anthropic-messages"
                    ? "anthropic-messages"
                    : "openai-compatible",
              })}
          ></nt-select>`,
        ),
        row(
          message("timeoutSeconds"),
          undefined,
          html`<nt-stepper
            id="timeout"
            hide-label
            label=${message("timeoutSeconds")}
            .value=${Math.round(draft.timeoutMs / 1000)}
            min="5"
            max="180"
            step="5"
            unit=${message("optSecondsUnit")}
            decrement-label=${message("optDecrease")}
            increment-label=${message("optIncrease")}
            @nt-input=${(event: Event) =>
              actions.editAi({
                timeoutMs: detailValue<number>(event) * 1000,
              })}
          ></nt-stepper>`,
        ),
        row(
          message("systemPrompt"),
          message("optSystemPromptHelp"),
          html`<nt-text-field
            id="system-prompt"
            hide-label
            multiline
            label=${message("systemPrompt")}
            maxlength="20000"
            required
            .value=${draft.systemPrompt}
            @nt-input=${(event: Event) =>
              actions.editAi({ systemPrompt: detailValue<string>(event) })}
          ></nt-text-field>`,
        ),
      ]),
    },
  );
}

function fastKeyFields(
  provider: FastProviderId,
  state: ServicesState,
  actions: ServicesActions,
): TemplateResult | typeof nothing {
  const draft = state.fastDraft;
  const key = (
    id: string,
    label: string,
    value: string,
    field: keyof FastProviderDraft,
    help?: string,
  ) =>
    html`<nt-text-field
      id=${id}
      label=${label}
      type="password"
      maxlength="10000"
      placeholder=${message("providerKeyPlaceholder")}
      description=${help ?? ""}
      .value=${value}
      @nt-input=${(event: Event) =>
        actions.editFast({ [field]: detailValue<string>(event) })}
    ></nt-text-field>`;
  let fields: TemplateResult;
  switch (provider) {
    case "google-translate":
      fields = key(
        "google-api-key",
        message("googleApiKey"),
        draft.googleApiKey,
        "googleApiKey",
        message("googleApiKeyHelp"),
      );
      break;
    case "microsoft-translator":
      fields = html`<div class="grid2">
        ${key(
          "microsoft-api-key",
          message("microsoftApiKey"),
          draft.microsoftApiKey,
          "microsoftApiKey",
        )}
        <nt-text-field
          id="microsoft-region"
          label=${message("microsoftRegion")}
          maxlength="128"
          placeholder=${message("microsoftRegionPlaceholder")}
          description=${message("microsoftRegionHelp")}
          .value=${draft.microsoftRegion}
          @nt-input=${(event: Event) =>
            actions.editFast({ microsoftRegion: detailValue<string>(event) })}
        ></nt-text-field>
      </div>`;
      break;
    case "deepl":
      fields = html`<div class="grid2">
        ${key("deepl-api-key", message("deeplApiKey"), draft.deeplApiKey, "deeplApiKey")}
        <nt-select
          id="deepl-plan"
          label=${message("deeplPlan")}
          .options=${[
            { value: "free", label: message("deeplPlanFree") },
            { value: "pro", label: message("deeplPlanPro") },
          ]}
          .value=${draft.deeplPlan}
          @change=${(event: Event) =>
            actions.editFast({
              deeplPlan: detailValue<string>(event) === "pro" ? "pro" : "free",
            })}
        ></nt-select>
      </div>`;
      break;
    default:
      return nothing;
  }
  return row(
    message("optCloudKey"),
    message("optApiKeyLocalOnly"),
    html`${fields}
      <div class="actions">
        <nt-button
          id="save-fast-keys"
          variant="secondary"
          ?busy=${state.fastBusy}
          @click=${() => actions.saveFast()}
          >${message("optSaveKeys")}</nt-button
        >
      </div>
      ${feedback(
        state.fastFeedback
          ? message(state.fastFeedback.key)
          : state.fastDirty
            ? message("optUnsavedProvider")
            : "",
        state.fastFeedback?.tone ?? "",
      )}`,
  );
}

function fastGroup(
  settings: AppSettings,
  state: ServicesState,
  actions: ServicesActions,
): TemplateResult {
  const provider = settings.provider.fastProvider;
  return groupCard(
    "opt-fast",
    message("optFastTitle"),
    [
      row(
        message("optFastMethod"),
        message(
          isLocalFastProvider(provider)
            ? "optFastStaysLocal"
            : "optFastSendsToCloud",
          fastProviderLabel(provider),
        ),
        html`<nt-select
            id="fast-provider"
            hide-label
            label=${message("optFastMethod")}
            .options=${FAST_PROVIDER_IDS.map((id) => ({
              value: id,
              label: fastProviderLabel(id),
            }))}
            .value=${provider}
            @change=${(event: Event) =>
              actions.selectFastProvider(detailValue<FastProviderId>(event))}
          ></nt-select>
          ${
            state.fastProviderFeedback
              ? feedback(
                  message(state.fastProviderFeedback.key),
                  state.fastProviderFeedback.tone,
                )
              : nothing
          }`,
      ),
      fastKeyFields(provider, state, actions),
    ],
    {
      headerExtra: html`<span class="chip">${message("optFastChip")}</span>`,
      advanced: advanced(
        "offline-components",
        message("optOfflineComponents"),
        html`<div class="r r-full">${state.offlinePanel ?? nothing}</div>`,
      ),
    },
  );
}

export function servicesSection(
  context: SectionContext,
  state: ServicesState,
  actions: ServicesActions,
): TemplateResult {
  return html`${aiGroup(context.settings, state, actions)}
  ${fastGroup(context.settings, state, actions)}`;
}
