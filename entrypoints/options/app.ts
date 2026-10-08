import { html, render, type TemplateResult } from "lit";
import { browser } from "wxt/browser";
import type { LocalTranslationRuntimeInfo } from "@/src/messaging/protocol";
import { message } from "@/src/shared/i18n";
import {
  loadSettings,
  type AppSettings,
  type FastProviderId,
} from "@/src/shared/settings";
import {
  fastProviderOrigins,
  LOCAL_PROVIDER_ORIGINS,
  normalizeAiDraft,
  normalizeFastDraft,
  providerPermissionOrigins,
  requestOcrCapturePermission,
  requestOrigins,
  saveProviderFields,
  testProviderConnection,
  validateAiDraft,
  type AiProviderDraft,
  type CredentialDeps,
  type CredentialSaveCode,
  type FastProviderDraft,
} from "./credentials";
import type { SettingsStore, SettingsStoreEvent } from "./settings-store";
import type { LanguageCapabilities, SectionContext } from "./sections/common";
import { pageSection, type PageSectionState } from "./sections/page";
import { privacySection, type PrivacySectionState } from "./sections/privacy";
import {
  servicesSection,
  type Feedback,
  type ServicesState,
} from "./sections/services";
import { videoSection, type VideoSectionState } from "./sections/video";
import {
  generalSection,
  THIRD_PARTY_NOTICE_PATHS,
  type GeneralSectionState,
} from "./sections/general";
import type { ExtensionUpdateStatus } from "@/src/update/checker";
import { sitesSection } from "./sections/sites";
import { SiteProfilesController } from "./site-profiles";
import { RuntimePanels } from "./sections/runtimes";

export interface OptionsAppRoots {
  services: HTMLElement;
  page: HTMLElement;
  video: HTMLElement;
  privacy: HTMLElement;
  sites: HTMLElement;
  general: HTMLElement;
  /** Polite live region for autosave state. */
  status: HTMLElement;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}

export interface OptionsAppDeps {
  sendMessage(message: unknown): Promise<unknown>;
  loadSettings(): Promise<AppSettings>;
  requestOrigins(origins: string[]): Promise<boolean>;
  requestOcrCapturePermission(): Promise<boolean>;
  hasOrigins(origins: string[]): Promise<boolean>;
  confirm(request: ConfirmRequest): Promise<boolean>;
  navigate(hash: string): void;
  reload(): void;
  openTab(url: string): void;
  extensionVersion(): string;
  extensionUrl(path: string): string;
  copyText(text: string): Promise<void>;
  /** Offers `text` as a downloaded file (user-initiated export). */
  download(fileName: string, text: string): void;
}

export function defaultOptionsAppDeps(
  confirm: OptionsAppDeps["confirm"],
  navigate: OptionsAppDeps["navigate"],
): OptionsAppDeps {
  return {
    sendMessage: (value) => browser.runtime.sendMessage(value),
    loadSettings,
    requestOrigins,
    requestOcrCapturePermission,
    hasOrigins: async (origins) => {
      try {
        return await browser.permissions.contains({ origins });
      } catch {
        return false;
      }
    },
    confirm,
    navigate,
    reload: () => window.location.reload(),
    openTab: (url) => void browser.tabs.create({ url }),
    extensionVersion: () => browser.runtime.getManifest().version,
    extensionUrl: (path) => browser.runtime.getURL(path as "/"),
    copyText: (text) => navigator.clipboard.writeText(text),
    download: (fileName, text) => {
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  };
}

type AutosaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "failed" };

const CREDENTIAL_MESSAGES: Record<CredentialSaveCode, string> = {
  provider_saved: "optProviderSaved",
  provider_url_invalid: "providerUrlInvalid",
  provider_model_missing: "optProviderModelMissing",
  provider_timeout_invalid: "optProviderTimeoutInvalid",
  provider_prompt_missing: "optProviderPromptMissing",
  provider_permission_denied: "providerPermissionDenied",
  provider_save_failed: "settingsSaveFailed",
};

function aiDraftFrom(settings: AppSettings): AiProviderDraft {
  const { aiProvider, baseUrl, apiKey, model, systemPrompt, timeoutMs } =
    settings.provider;
  return { aiProvider, baseUrl, apiKey, model, systemPrompt, timeoutMs };
}

function fastDraftFrom(settings: AppSettings): FastProviderDraft {
  const {
    googleApiKey,
    microsoftApiKey,
    microsoftRegion,
    deeplApiKey,
    deeplPlan,
  } = settings.provider;
  return {
    googleApiKey,
    microsoftApiKey,
    microsoftRegion,
    deeplApiKey,
    deeplPlan,
  };
}

/**
 * Renders the four migrated settings groups and owns their local state:
 * credential drafts (never autosaved), action feedback and the language
 * capabilities used to filter language lists. Persisted settings live in
 * `SettingsStore`.
 */
export class OptionsApp {
  private capabilities: LanguageCapabilities = {
    chromePairs: [],
    chromeLoaded: false,
    localRuntimes: [],
    localLoaded: false,
  };
  private readonly services: ServicesState;
  private readonly pageState: PageSectionState = {
    ocrRuntimeInstalled: null,
  };
  private readonly videoState: VideoSectionState = {};
  private readonly privacyState: PrivacySectionState = {
    localPermission: null,
    cacheBusy: false,
    credentialsBusy: false,
  };
  private readonly generalState: GeneralSectionState;
  readonly sites: SiteProfilesController;
  readonly runtimes: RuntimePanels;
  private autosave: AutosaveStatus = { kind: "idle" };
  private renderQueued = false;
  private readonly disposers: (() => void)[] = [];

  constructor(
    private readonly roots: OptionsAppRoots,
    private readonly store: SettingsStore,
    private readonly deps: OptionsAppDeps,
  ) {
    const stored = store.storedValue;
    this.services = {
      aiDraft: aiDraftFrom(stored),
      aiDirty: false,
      aiBusy: "",
      fastDraft: fastDraftFrom(stored),
      fastDirty: false,
      fastBusy: false,
    };
    this.generalState = {
      version: deps.extensionVersion(),
      updateBusy: "",
      updateFailed: false,
      uiLanguageBusy: false,
      restoreBusy: false,
      noticeUrls: {
        translation: deps.extensionUrl(THIRD_PARTY_NOTICE_PATHS.translation),
        recognition: deps.extensionUrl(THIRD_PARTY_NOTICE_PATHS.recognition),
      },
    };
    this.sites = new SiteProfilesController({
      sendMessage: (value) => deps.sendMessage(value),
      confirm: (request) => deps.confirm(request),
      requestRender: () => this.requestRender(),
      settings: () => this.store.value,
      copyText: (text) => deps.copyText(text),
      download: (fileName, text) => deps.download(fileName, text),
      message,
    });
    this.runtimes = new RuntimePanels({
      sendMessage: (value) => deps.sendMessage(value),
      requestOrigins: (origins) => deps.requestOrigins(origins),
      confirm: (request) => deps.confirm(request),
      requestRender: () => this.requestRender(),
      onOcrRuntimes: (runtimes) =>
        this.setOcrRuntimeInstalled(
          runtimes.some((runtime) => runtime.state === "installed"),
        ),
      onLocalTranslationRuntimes: (runtimes) => this.setLocalRuntimes(runtimes),
    });
    this.disposers.push(store.subscribe((event) => this.onStoreEvent(event)));
    this.disposers.push(() => this.runtimes.dispose());
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  /** Adopts settings written elsewhere (storage change). */
  applyExternal(stored: unknown): void {
    this.store.applyExternal(stored);
    const next = this.store.storedValue;
    // Credential drafts follow storage unless the user has unsaved edits.
    if (!this.services.aiDirty) this.services.aiDraft = aiDraftFrom(next);
    if (!this.services.fastDirty) {
      this.services.fastDraft = fastDraftFrom(next);
    }
    this.requestRender();
  }

  setChromePairs(pairs: string[]): void {
    this.capabilities = {
      ...this.capabilities,
      chromePairs: pairs,
      chromeLoaded: true,
    };
    this.requestRender();
  }

  setLocalRuntimes(runtimes: LocalTranslationRuntimeInfo[]): void {
    this.capabilities = {
      ...this.capabilities,
      localRuntimes: runtimes,
      localLoaded: true,
    };
    this.requestRender();
  }

  setOcrRuntimeInstalled(installed: boolean): void {
    this.pageState.ocrRuntimeInstalled = installed;
    this.requestRender();
  }

  async refreshLocalPermission(): Promise<void> {
    this.privacyState.localPermission = await this.deps.hasOrigins([
      ...LOCAL_PROVIDER_ORIGINS,
    ]);
    this.requestRender();
  }

  private onStoreEvent(event: SettingsStoreEvent): void {
    switch (event.kind) {
      case "saving":
        this.autosave = { kind: "saving" };
        break;
      case "saved":
        this.autosave = { kind: "saved" };
        break;
      case "failed":
        this.autosave = { kind: "failed" };
        break;
      case "change":
        break;
    }
    this.requestRender();
  }

  private context(): SectionContext {
    return {
      settings: this.store.value,
      capabilities: this.capabilities,
      update: (patch, debounceMs) => this.store.update(patch, debounceMs),
      beginEditing: (path) => this.store.beginEditing(path),
      endEditing: (path) => this.store.endEditing(path),
    };
  }

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  render(): void {
    const context = this.context();
    this.services.offlinePanel =
      this.runtimes.localTranslationTemplate(context);
    this.videoState.recognitionPanel = this.runtimes.ocrTemplate(context);
    render(
      servicesSection(context, this.services, {
        editAi: (fields) => this.editAi(fields),
        saveAi: (test) => void this.saveAi(test),
        editFast: (fields) => this.editFast(fields),
        saveFast: () => void this.saveFast(),
        selectFastProvider: (provider) =>
          void this.selectFastProvider(provider),
      }),
      this.roots.services,
    );
    render(
      pageSection(context, this.pageState, {
        openOcrRuntimes: () => this.deps.navigate("#ocr"),
      }),
      this.roots.page,
    );
    render(
      videoSection(context, this.videoState, {
        setOcrEnabled: (enabled) => void this.setOcrEnabled(enabled),
      }),
      this.roots.video,
    );
    render(
      privacySection(context, this.privacyState, {
        clearCache: () => void this.clearCache(),
        clearCredentials: () => void this.clearCredentials(),
      }),
      this.roots.privacy,
    );
    render(
      generalSection(context, this.generalState, {
        setUiLanguage: (value) => void this.setUiLanguage(value),
        setFloatingEnabled: (enabled) => void this.setFloatingEnabled(enabled),
        restoreSessionFloating: () => void this.restoreSessionFloating(),
        setAutoCheck: (enabled) => void this.setAutoCheck(enabled),
        checkUpdates: () => void this.refreshUpdateStatus(true),
        viewRelease: () => this.viewRelease(),
        ignoreVersion: () => void this.ignoreVersion(),
      }),
      this.roots.general,
    );
    render(sitesSection(context, this.sites), this.roots.sites);
    render(this.statusTemplate(), this.roots.status);
    this.applySitesFocus();
  }

  private statusTemplate(): TemplateResult {
    const key =
      this.autosave.kind === "saving"
        ? "optAutosaveSaving"
        : this.autosave.kind === "saved"
          ? "optAutosaveSaved"
          : this.autosave.kind === "failed"
            ? "optAutosaveFailed"
            : "optAutosaveHint";
    return html`<span
      class="autosave"
      data-state=${this.autosave.kind}
      id="autosave-status"
      >${message(key)}</span
    >`;
  }

  // Provider (explicit save) ------------------------------------------------

  private credentialDeps(): CredentialDeps {
    return {
      flushAutosave: () => this.store.flush(),
      loadSettings: () => this.deps.loadSettings(),
      requestPermission: (settings) =>
        this.deps.requestOrigins(providerPermissionOrigins(settings)),
      sendMessage: (value) => this.deps.sendMessage(value),
    };
  }

  private editAi(fields: Partial<AiProviderDraft>): void {
    this.services.aiDraft = { ...this.services.aiDraft, ...fields };
    this.services.aiDirty = true;
    this.services.aiFeedback = undefined;
    this.requestRender();
  }

  private editFast(fields: Partial<FastProviderDraft>): void {
    this.services.fastDraft = { ...this.services.fastDraft, ...fields };
    this.services.fastDirty = true;
    this.services.fastFeedback = undefined;
    this.requestRender();
  }

  private setAiFeedback(feedback: Feedback | undefined): void {
    this.services.aiFeedback = feedback;
    this.requestRender();
  }

  async saveAi(test: boolean): Promise<void> {
    if (this.services.aiBusy) return;
    const draft = normalizeAiDraft(this.services.aiDraft);
    const invalid = validateAiDraft(draft);
    this.services.aiDiagnostic = undefined;
    if (invalid) {
      this.setAiFeedback({ key: CREDENTIAL_MESSAGES[invalid], tone: "error" });
      return;
    }
    this.services.aiBusy = test ? "test" : "save";
    this.setAiFeedback(
      test ? { key: "connectionTesting", tone: "" } : undefined,
    );
    try {
      const saved = await saveProviderFields(draft, this.credentialDeps());
      if (!saved.ok) {
        this.setAiFeedback({
          key: CREDENTIAL_MESSAGES[saved.code],
          tone: "error",
        });
        return;
      }
      this.services.aiDraft = aiDraftFrom(saved.settings);
      this.services.aiDirty = false;
      this.store.applyExternal(saved.settings);
      if (!test) {
        this.setAiFeedback({ key: "optProviderSaved", tone: "success" });
        return;
      }
      const result = await testProviderConnection(this.credentialDeps());
      if (result.ok) {
        this.setAiFeedback({ key: "connectionSucceeded", tone: "success" });
      } else {
        this.services.aiDiagnostic = result.diagnostic;
        this.setAiFeedback({ key: "connectionFailed", tone: "error" });
      }
    } finally {
      this.services.aiBusy = "";
      this.requestRender();
    }
  }

  async saveFast(): Promise<void> {
    if (this.services.fastBusy) return;
    this.services.fastBusy = true;
    this.services.fastFeedback = undefined;
    this.requestRender();
    try {
      const saved = await saveProviderFields(
        normalizeFastDraft(this.services.fastDraft),
        this.credentialDeps(),
      );
      if (!saved.ok) {
        this.services.fastFeedback = {
          key: CREDENTIAL_MESSAGES[saved.code],
          tone: "error",
        };
        return;
      }
      this.services.fastDraft = fastDraftFrom(saved.settings);
      this.services.fastDirty = false;
      this.store.applyExternal(saved.settings);
      this.services.fastFeedback = { key: "optProviderSaved", tone: "success" };
    } finally {
      this.services.fastBusy = false;
      this.requestRender();
    }
  }

  /**
   * Fast provider choice autosaves, but a cloud provider first needs its
   * API host permission (requested inside the user gesture).
   */
  async selectFastProvider(provider: FastProviderId): Promise<void> {
    this.services.fastProviderFeedback = undefined;
    const origins = fastProviderOrigins(
      provider,
      this.services.fastDraft.deeplPlan,
    );
    if (!(await this.deps.requestOrigins(origins))) {
      this.services.fastProviderFeedback = {
        key: "providerPermissionDenied",
        tone: "error",
      };
      this.requestRender();
      return;
    }
    const outcome = await this.store.commit({
      provider: { fastProvider: provider },
    });
    if (!outcome.ok) {
      this.services.fastProviderFeedback = {
        key: "settingsSaveFailed",
        tone: "error",
      };
    }
    this.requestRender();
  }

  // Video ------------------------------------------------------------------

  async setOcrEnabled(enabled: boolean): Promise<void> {
    this.videoState.ocrFeedback = undefined;
    if (enabled && !(await this.deps.requestOcrCapturePermission())) {
      this.videoState.ocrFeedback = {
        key: "ocrPermissionDenied",
        tone: "error",
      };
      this.requestRender();
      return;
    }
    const outcome = await this.store.commit({ ocr: { enabled } });
    if (!outcome.ok) {
      this.videoState.ocrFeedback = {
        key: "settingsSaveFailed",
        tone: "error",
      };
    }
    this.requestRender();
  }

  // Privacy ----------------------------------------------------------------

  async clearCache(): Promise<void> {
    if (this.privacyState.cacheBusy) return;
    const confirmed = await this.deps.confirm({
      title: message("optClearCacheTitle"),
      body: message("optClearCacheImpact"),
      confirmLabel: message("clearCache"),
    });
    if (!confirmed) return;
    this.privacyState.cacheBusy = true;
    this.privacyState.dataFeedback = undefined;
    this.requestRender();
    try {
      const response = await this.deps.sendMessage({ type: "CACHE_CLEAR" });
      this.privacyState.dataFeedback = isOk(response)
        ? { key: "cacheCleared", tone: "success" }
        : { key: "cacheClearFailed", tone: "error" };
    } catch {
      this.privacyState.dataFeedback = {
        key: "cacheClearFailed",
        tone: "error",
      };
    } finally {
      this.privacyState.cacheBusy = false;
      this.requestRender();
    }
  }

  async clearCredentials(): Promise<void> {
    if (this.privacyState.credentialsBusy) return;
    const confirmed = await this.deps.confirm({
      title: message("optClearCredentialsTitle"),
      body: message("optClearCredentialsImpact"),
      confirmLabel: message("clearCredentials"),
      danger: true,
    });
    if (!confirmed) return;
    this.privacyState.credentialsBusy = true;
    this.privacyState.dataFeedback = undefined;
    this.requestRender();
    try {
      const response = await this.deps.sendMessage({
        type: "CREDENTIALS_CLEAR",
      });
      if (!isOk(response)) throw new Error("credentials_clear_failed");
      const cleared = {
        apiKey: "",
        googleApiKey: "",
        microsoftApiKey: "",
        deeplApiKey: "",
      };
      this.services.aiDraft = { ...this.services.aiDraft, apiKey: "" };
      this.services.fastDraft = { ...this.services.fastDraft, ...cleared };
      this.privacyState.dataFeedback = {
        key: "credentialsCleared",
        tone: "success",
      };
    } catch {
      this.privacyState.dataFeedback = {
        key: "credentialsClearFailed",
        tone: "error",
      };
    } finally {
      this.privacyState.credentialsBusy = false;
      this.requestRender();
    }
  }

  /** Moves focus between the site list and detail after a view switch. */
  private applySitesFocus(): void {
    const id = this.sites.focusTarget;
    if (!id) return;
    this.sites.focusTarget = undefined;
    const target = this.roots.sites.querySelector<HTMLElement>(`#${id}`);
    if (!target) return;
    // Headings are not focusable by default; make them programmatic targets.
    if (target.tagName === "H2") target.tabIndex = -1;
    target.focus();
  }

  // General -----------------------------------------------------------------

  /** Interface language applies on reload, so it is written right away. */
  async setUiLanguage(value: AppSettings["uiLanguage"]): Promise<void> {
    if (this.generalState.uiLanguageBusy) return;
    if (value === this.store.value.uiLanguage) return;
    this.generalState.uiLanguageBusy = true;
    this.requestRender();
    const outcome = await this.store.commit({ uiLanguage: value });
    this.generalState.uiLanguageBusy = false;
    if (outcome.ok) this.deps.reload();
    else this.requestRender();
  }

  /** One switch for both surfaces (the control shows if either is on). */
  async setFloatingEnabled(enabled: boolean): Promise<void> {
    await this.store.commit({
      page: { floatingButtonEnabled: enabled },
      subtitles: { floatingButtonEnabled: enabled },
    });
    this.requestRender();
  }

  async restoreSessionFloating(): Promise<void> {
    if (this.generalState.restoreBusy) return;
    this.generalState.restoreBusy = true;
    this.generalState.restoreFeedback = undefined;
    this.requestRender();
    try {
      const response = await this.deps.sendMessage({
        type: "FLOATING_SESSION_RESTORE",
      });
      if (!isFloatingRestoreResponse(response)) {
        throw new Error("floating_session_restore_failed");
      }
      this.generalState.restoreFeedback = {
        key: "floatingSessionRestored",
        tone: "success",
        count: response.restored,
      };
    } catch {
      this.generalState.restoreFeedback = {
        key: "floatingSessionRestoreFailed",
        tone: "error",
      };
    } finally {
      this.generalState.restoreBusy = false;
      this.requestRender();
    }
  }

  /** Loads (or, with `force`, re-checks) the extension update status. */
  async refreshUpdateStatus(force: boolean): Promise<void> {
    if (this.generalState.updateBusy) return;
    if (force) this.generalState.updateBusy = "check";
    this.requestRender();
    await this.updateRequest({
      type: force ? "UPDATE_CHECK" : "UPDATE_STATUS_GET",
    });
  }

  async setAutoCheck(enabled: boolean): Promise<void> {
    if (this.generalState.updateBusy) return;
    this.generalState.updateBusy = "auto";
    this.requestRender();
    await this.updateRequest({ type: "UPDATE_AUTO_CHECK_SET", enabled });
  }

  async ignoreVersion(): Promise<void> {
    const version = this.generalState.update?.latestVersion;
    if (!version || this.generalState.updateBusy) return;
    this.generalState.updateBusy = "ignore";
    this.requestRender();
    await this.updateRequest({ type: "UPDATE_IGNORE", version });
  }

  viewRelease(): void {
    const url = this.generalState.update?.releaseUrl;
    if (url) this.deps.openTab(url);
  }

  private async updateRequest(request: unknown): Promise<void> {
    try {
      const response = await this.deps.sendMessage(request);
      if (!isUpdateStatus(response)) throw new Error("invalid_update_status");
      this.generalState.update = response;
      this.generalState.updateFailed = false;
    } catch {
      // Keep the last known status; the line reports the failure.
      this.generalState.updateFailed = true;
    } finally {
      this.generalState.updateBusy = "";
      this.requestRender();
    }
  }

  /** True while credential forms or a site profile hold unsaved edits. */
  get hasUnsavedChanges(): boolean {
    return this.services.aiDirty || this.services.fastDirty || this.sites.dirty;
  }
}

function isOk(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
}

function isUpdateStatus(value: unknown): value is ExtensionUpdateStatus {
  if (!isOk(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.state === "string" &&
    ["never", "current", "available", "ignored", "error"].includes(
      record.state,
    ) &&
    typeof record.currentVersion === "string" &&
    typeof record.autoCheckEnabled === "boolean" &&
    (record.releaseUrl === undefined ||
      (typeof record.releaseUrl === "string" &&
        record.releaseUrl.startsWith("https://")))
  );
}

function isFloatingRestoreResponse(
  value: unknown,
): value is { ok: true; restored: number } {
  if (!isOk(value)) return false;
  const restored = (value as Record<string, unknown>).restored;
  return (
    typeof restored === "number" && Number.isInteger(restored) && restored >= 0
  );
}
