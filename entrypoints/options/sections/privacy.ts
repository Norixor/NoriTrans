import { html, nothing, type TemplateResult } from "lit";
import { message } from "@/src/shared/i18n";
import { feedback, groupCard, row, type SectionContext } from "./common";
import {
  endpointOrigin,
  fastProviderLabel,
  isLocalFastProvider,
  type Feedback,
} from "./services";

export interface PrivacySectionState {
  /** Optional localhost/127.0.0.1 access; null while unknown. */
  localPermission: boolean | null;
  cacheBusy: boolean;
  credentialsBusy: boolean;
  dataFeedback?: Feedback | undefined;
}

export interface PrivacySectionActions {
  clearCache(): void;
  clearCredentials(): void;
}

function destinations(context: SectionContext): TemplateResult {
  const provider = context.settings.provider;
  const fast = provider.fastProvider;
  return html`<ul class="facts" id="data-destinations">
    <li>
      <strong>${message("optDestinationAi")}</strong>
      <span>${endpointOrigin(provider.baseUrl)}</span>
    </li>
    <li>
      <strong>${message("optDestinationFast")}</strong>
      <span
        >${message(
          isLocalFastProvider(fast)
            ? "optFastStaysLocal"
            : "optFastSendsToCloud",
          fastProviderLabel(fast),
        )}</span
      >
    </li>
    <li>
      <strong>${message("optImageRecognition")}</strong>
      <span>${message("optRecognitionStaysLocal")}</span>
    </li>
  </ul>`;
}

export function privacySection(
  context: SectionContext,
  state: PrivacySectionState,
  actions: PrivacySectionActions,
): TemplateResult {
  return html`${groupCard("opt-privacy", message("optDataFlowTitle"), [
    row(
      message("optWhatIsSent"),
      undefined,
      html`<p class="help strong">${message("optWhatIsSentBody")}</p>`,
    ),
    row(message("optWhereItGoes"), undefined, destinations(context)),
    row(
      message("optHostPermission"),
      undefined,
      html`<nt-note icon="shield" id="host-permission-note"
        >${message("optHostPermissionBody", "https://*/*")}</nt-note
      >`,
    ),
    row(
      message("optLocalProviderPermission"),
      undefined,
      html`<p class="help strong" id="local-permission-status">
        ${
          state.localPermission === null
            ? nothing
            : message(
                state.localPermission
                  ? "optLocalPermissionGranted"
                  : "optLocalPermissionNotGranted",
              )
        }
      </p>`,
    ),
    row(
      message("optDataStorage"),
      undefined,
      html`<p class="help strong">${message("optDataStorageBody")}</p>`,
    ),
  ])}
  ${groupCard("opt-data", message("localData"), [
    html`<p class="r-note help">${message("localDataDescription")}</p>`,
    row(
      message("cacheTitle"),
      message("cacheDescription"),
      html`<div class="actions">
        <nt-button
          id="clear-cache"
          variant="secondary"
          ?busy=${state.cacheBusy}
          @click=${() => actions.clearCache()}
          >${message("clearCache")}</nt-button
        >
      </div>`,
    ),
    row(
      message("credentialsTitle"),
      message("credentialsDescription"),
      html`<div class="actions">
        <nt-button
          id="clear-credentials"
          variant="danger"
          ?busy=${state.credentialsBusy}
          @click=${() => actions.clearCredentials()}
          >${message("optClearCredentialsEllipsis")}</nt-button
        >
      </div>`,
    ),
    html`<div class="r r-full">
      ${feedback(
        state.dataFeedback ? message(state.dataFeedback.key) : "",
        state.dataFeedback?.tone ?? "",
        "data-message",
      )}
    </div>`,
  ])}`;
}
