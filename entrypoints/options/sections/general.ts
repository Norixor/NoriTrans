import { html, nothing, type TemplateResult } from "lit";
import { message } from "@/src/shared/i18n";
import type { UiLanguage } from "@/src/shared/settings";
import type { ExtensionUpdateStatus } from "@/src/update/checker";
import type { NtSelectOption } from "@/src/ui/components";
import {
  detailChecked,
  detailValue,
  feedback,
  groupCard,
  row,
  switchRow,
  type SectionContext,
} from "./common";
import type { Feedback } from "./services";

/** Third-party notices shipped with the bundled runtimes. */
export const THIRD_PARTY_NOTICE_PATHS = {
  translation: "/bergamot/THIRD_PARTY_NOTICES.txt",
  recognition: "/ocr/licenses/THIRD_PARTY_NOTICES.txt",
} as const;

export interface GeneralSectionState {
  version: string;
  /** Last update status from the background; undefined until loaded. */
  update?: ExtensionUpdateStatus | undefined;
  updateBusy: "" | "check" | "auto" | "ignore";
  /** Set when the last update request failed (status kept as before). */
  updateFailed: boolean;
  uiLanguageBusy: boolean;
  restoreBusy: boolean;
  restoreFeedback?: (Feedback & { count?: number }) | undefined;
  /** Resolved extension URLs for the notices (`runtime.getURL`). */
  noticeUrls: { translation: string; recognition: string };
}

export interface GeneralSectionActions {
  setUiLanguage(value: UiLanguage): void;
  setFloatingEnabled(enabled: boolean): void;
  restoreSessionFloating(): void;
  setAutoCheck(enabled: boolean): void;
  checkUpdates(): void;
  viewRelease(): void;
  ignoreVersion(): void;
}

function uiLanguageOptions(): NtSelectOption[] {
  return [
    { value: "auto", label: message("uiLanguageAuto") },
    { value: "en", label: message("uiLanguageEnglish") },
    { value: "zh-CN", label: message("uiLanguageChineseSimplified") },
  ];
}

/** The update line shown beside "Check now", by stored state. */
export function updateStatusText(state: GeneralSectionState): {
  text: string;
  tone: "" | "success" | "error";
} {
  if (state.updateBusy === "check") {
    return { text: message("updateChecking"), tone: "" };
  }
  const status = state.update;
  if (state.updateFailed || status?.state === "error") {
    return { text: message("updateCheckFailed"), tone: "error" };
  }
  if (!status || status.state === "never") {
    return { text: message("updateNeverChecked"), tone: "" };
  }
  const version = status.latestVersion ?? status.currentVersion;
  if (status.state === "available") {
    return { text: message("updateAvailableTitle", version), tone: "success" };
  }
  if (status.state === "ignored") {
    return { text: message("updateIgnored", version), tone: "" };
  }
  return { text: message("updateCurrent", status.currentVersion), tone: "" };
}

/** True when a newer release can be opened (banner and row actions). */
export function updateAvailable(status: ExtensionUpdateStatus | undefined) {
  return status?.state === "available" && Boolean(status.releaseUrl);
}

/** Banner at the top of the group while a newer release is available. */
function updateBanner(
  state: GeneralSectionState,
  actions: GeneralSectionActions,
): TemplateResult | typeof nothing {
  const status = state.update;
  if (!status || !updateAvailable(status)) return nothing;
  return html`<div class="opt-banner" id="update-banner" role="status">
    <div class="opt-banner-text">
      <strong
        >${message(
          "updateAvailableTitle",
          status.latestVersion ?? status.currentVersion,
        )}</strong
      >
      <span>${message("updateAvailableDescription")}</span>
    </div>
    <div class="actions">
      <nt-button
        id="update-banner-view"
        variant="primary"
        @click=${() => actions.viewRelease()}
        >${message("updateViewRelease")}</nt-button
      >
      <nt-button
        id="update-banner-ignore"
        variant="ghost"
        ?busy=${state.updateBusy === "ignore"}
        @click=${() => actions.ignoreVersion()}
        >${message("updateIgnoreVersion")}</nt-button
      >
    </div>
  </div>`;
}

export function generalSection(
  context: SectionContext,
  state: GeneralSectionState,
  actions: GeneralSectionActions,
): TemplateResult {
  const settings = context.settings;
  // The control is shown when either surface enables it; the switch writes
  // both, matching the floating control's own visibility rule.
  const floatingEnabled =
    settings.page.floatingButtonEnabled ||
    settings.subtitles.floatingButtonEnabled;
  const status = updateStatusText(state);
  const restore = state.restoreFeedback;
  return html`${updateBanner(state, actions)}
  ${groupCard("opt-interface", message("optInterfaceTitle"), [
    row(
      message("uiLanguage"),
      message("uiLanguageDescription"),
      html`<nt-select
        id="ui-language"
        label=${message("uiLanguage")}
        hide-label
        .options=${uiLanguageOptions()}
        .value=${settings.uiLanguage}
        ?disabled=${state.uiLanguageBusy}
        @change=${(event: Event) => {
          const value = detailValue<string>(event);
          actions.setUiLanguage(
            value === "en" || value === "zh-CN" ? value : "auto",
          );
        }}
      ></nt-select>`,
    ),
  ])}
  ${groupCard("opt-floating", message("floatingControl"), [
    switchRow(
      html`<nt-switch
        id="floating-control-enabled"
        label=${message("floatingControlEnabled")}
        description=${message("floatingControlDescription")}
        ?checked=${floatingEnabled}
        @change=${(event: Event) =>
          actions.setFloatingEnabled(detailChecked(event))}
      ></nt-switch>`,
    ),
    switchRow(
      html`<nt-switch
        id="floating-announcements"
        label=${message("optFloatingAnnouncements")}
        description=${message("optFloatingAnnouncementsHelp")}
        ?checked=${settings.floating.announcements}
        ?disabled=${!floatingEnabled}
        @change=${(event: Event) =>
          context.update({
            floating: { announcements: detailChecked(event) },
          })}
      ></nt-switch>`,
    ),
    row(
      message("floatingSessionRestoreTitle"),
      message("optFloatingSessionRestoreHelp"),
      html`<div class="actions">
          <nt-button
            id="restore-session-floating"
            variant="secondary"
            ?busy=${state.restoreBusy}
            @click=${() => actions.restoreSessionFloating()}
            >${message("floatingSessionRestore")}</nt-button
          >
        </div>
        ${feedback(
          restore ? message(restore.key, String(restore.count ?? 0)) : "",
          restore?.tone ?? "",
          "restore-session-floating-message",
        )}`,
    ),
  ])}
  ${groupCard("opt-updates", message("updateSettingsTitle"), [
    switchRow(
      html`<nt-switch
        id="update-auto-check"
        label=${message("updateAutoCheck")}
        description=${message("updateAutoCheckDescription")}
        ?checked=${state.update?.autoCheckEnabled ?? true}
        ?disabled=${state.update === undefined || state.updateBusy === "auto"}
        @change=${(event: Event) => actions.setAutoCheck(detailChecked(event))}
      ></nt-switch>`,
    ),
    row(
      message("optUpdateStatus"),
      message("updateSettingsDescription"),
      html`${feedback(status.text, status.tone, "update-status")}
        <div class="actions">
          <nt-button
            id="check-updates"
            variant="secondary"
            ?busy=${state.updateBusy === "check"}
            @click=${() => actions.checkUpdates()}
            >${message("updateCheckNow")}</nt-button
          >
          ${
            updateAvailable(state.update)
              ? html`<nt-button
                    id="view-update"
                    variant="secondary"
                    @click=${() => actions.viewRelease()}
                    >${message("updateViewRelease")}</nt-button
                  >
                  <nt-button
                    id="ignore-update"
                    variant="ghost"
                    ?busy=${state.updateBusy === "ignore"}
                    @click=${() => actions.ignoreVersion()}
                    >${message("updateIgnoreVersion")}</nt-button
                  >`
              : nothing
          }
        </div>
        <p class="help">${message("updateUnpackedInstallHint")}</p>`,
    ),
  ])}
  ${groupCard("opt-about", message("optAboutTitle"), [
    row(
      message("optVersion"),
      undefined,
      html`<p class="help strong" id="extension-version">${state.version}</p>`,
    ),
    row(
      message("optThirdPartyNotices"),
      message("optThirdPartyNoticesHelp"),
      html`<ul class="links" id="third-party-notices">
        <li>
          <a href=${state.noticeUrls.translation} target="_blank" rel="noopener"
            >${message("optNoticesTranslation")}</a
          >
        </li>
        <li>
          <a href=${state.noticeUrls.recognition} target="_blank" rel="noopener"
            >${message("optNoticesRecognition")}</a
          >
        </li>
      </ul>`,
    ),
  ])}`;
}
