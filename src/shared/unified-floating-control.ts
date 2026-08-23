import type { PageStatus, SubtitleStatus } from "@/src/messaging/protocol";
import type { ExtensionUpdateStatus } from "@/src/update/checker";
import type { OcrStatus } from "@/src/ocr/types";
import type { ImageTranslationStatus } from "@/src/image-translation/controller";
import {
  displayLanguageName,
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
  type LanguageOption,
} from "@/src/shared/languages";
import type {
  ContentSettings,
  ImageTranslationSettings,
  PageSettings,
  SubtitleSettings,
} from "@/src/shared/settings";
import {
  autoTranslateSitePatternForHostname,
  isSiteAutoTranslateEnabled,
} from "@/src/shared/auto-translate-sites";
import {
  LAUNCHER_SIZE,
  UNIFIED_FLOATING_CONTROL_STYLE,
  VIEWPORT_PADDING,
} from "@/src/shared/unified-floating-control-style";
import { browser } from "wxt/browser";

export type PageSettingsPatch = Pick<
  PageSettings,
  | "sourceLanguage"
  | "targetLanguage"
  | "displayMode"
  | "selectionTranslationEnabled"
  | "selectionTranslationMode"
>;

export type SubtitleSettingsPatch = Pick<
  SubtitleSettings,
  | "sourceLanguage"
  | "targetLanguage"
  | "mode"
  | "aiResponseMode"
  | "displayMode"
  | "hideNativeSubtitles"
  | "fontScale"
  | "backgroundOpacity"
>;

export type ImageSettingsPatch = ImageTranslationSettings;

export interface FloatingControlPosition {
  x: number;
  y: number;
}

export interface UnifiedFloatingControlOptions {
  settings: ContentSettings;
  onPageTranslate(): Promise<void> | void;
  onPageRestore(): Promise<void> | void;
  onAutoTranslateChange(enabled: boolean): Promise<void> | void;
  onPageSettingsChange(settings: PageSettingsPatch): Promise<void> | void;
  onPageModeChange(mode: "fast" | "ai"): Promise<void> | void;
  onPageResponseModeChange(mode: "stream" | "batch"): Promise<void> | void;
  onSubtitleSettingsChange(
    settings: SubtitleSettingsPatch,
  ): Promise<void> | void;
  onSubtitleStart(): Promise<void> | void;
  onSubtitleCancel(): Promise<void> | void;
  onCreateProfile(): Promise<void> | void;
  onOcrEnabledChange?(enabled: boolean): Promise<void> | void;
  onOcrStart?(): Promise<void> | void;
  onOcrStop?(): Promise<void> | void;
  onImageSettingsChange?(settings: ImageSettingsPatch): Promise<void> | void;
  onImageStart?(): Promise<void> | void;
  onImageCancelOrClear?(): Promise<void> | void;
  loadPosition?(): Promise<FloatingControlPosition | undefined>;
  onPositionChange?(position: FloatingControlPosition): Promise<void> | void;
  onHideCurrent(): Promise<void> | void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  hostLeft: number;
  hostTop: number;
  moved: boolean;
  styleLeft: string;
  styleTop: string;
  styleRight: string;
  styleBottom: string;
  dockedEdge?: DockedEdge;
  edgeHidden?: string;
}

type DockedEdge = "left" | "right" | "top" | "bottom";
type FloatingTaskTarget = "page" | "video" | "image";

interface FullscreenPositionSnapshot {
  left: string;
  top: string;
  right: string;
  bottom: string;
  dockedEdge?: DockedEdge;
}

interface PendingSettingsPatch<T extends object> {
  revision: number;
  patch: Partial<T>;
}

const DRAG_THRESHOLD = 6;
const KEYBOARD_MOVE_STEP = 8;
const KEYBOARD_MOVE_LARGE_STEP = 32;
const EDGE_DOCK_THRESHOLD = 28;
const EDGE_HIDE_DELAY_MS = 450;

function contentViewportWidth(): number {
  const candidates = [
    window.innerWidth,
    document.documentElement?.clientWidth,
    window.visualViewport?.width,
  ].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return Math.max(1, Math.min(...candidates));
}

function contentViewportHeight(): number {
  const candidates = [
    window.innerHeight,
    document.documentElement?.clientHeight,
    window.visualViewport?.height,
  ].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return Math.max(1, Math.min(...candidates));
}

function message(key: string, substitutions?: string | string[]): string {
  return browser.i18n.getMessage(key as never, substitutions) || key;
}

function pageStateMessage(state: PageStatus["state"]): string {
  switch (state) {
    case "idle":
      return message("pageStatusIdle");
    case "scanning":
      return message("pageStatusScanning");
    case "translating":
      return message("pageStatusTranslating");
    case "translated":
      return message("pageStatusTranslated");
    case "partial":
      return message("pageStatusPartial");
    case "error":
      return message("pageStatusError");
  }
}

function subtitleStateMessage(state: SubtitleStatus["state"]): string {
  switch (state) {
    case "unavailable":
      return message("videoUnavailable");
    case "waiting":
      return message("subtitleStatusWaiting");
    case "translating":
      return message("subtitleStatusTranslating");
    case "ready":
      return message("subtitleStatusReady");
    case "partial":
      return message("subtitleStatusPartial");
    case "cancelled":
      return message("subtitleStatusCancelled");
    case "error":
      return message("subtitleStatusError");
  }
}

function subtitleStatusMessage(
  status: SubtitleStatus,
  displayState: SubtitleStatus["state"],
): string {
  const stateMessage = status.message ?? subtitleStateMessage(displayState);
  if (!status.completeness) return stateMessage;
  const trackKind = message(
    status.completeness === "full"
      ? "subtitleTrackFull"
      : "subtitleTrackStream",
  );
  return `${stateMessage} · ${trackKind}`;
}

function ocrStateMessage(state: OcrStatus["state"]): string {
  switch (state) {
    case "disabled":
      return message("ocrStatusDisabled");
    case "idle":
      return message("ocrStatusIdle");
    case "selecting":
      return message("ocrStatusSelecting");
    case "initializing":
      return message("ocrStatusInitializing");
    case "capturing":
      return message("ocrStatusCapturing");
    case "recognizing":
      return message("ocrStatusRecognizing");
    case "active":
      return message("ocrStatusActive");
    case "cancelled":
      return message("ocrStatusCancelled");
    case "unavailable":
      return message("ocrStatusUnavailable");
    case "error":
      return message("ocrStatusError");
  }
}

export function stableSubtitleDisplayState(
  status: SubtitleStatus,
): SubtitleStatus["state"] {
  if (status.state === "cancelled") return "cancelled";
  if (status.failed > 0) return status.completed > 0 ? "partial" : "error";
  return status.state;
}

function createOption(value: string, messageKey: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = message(messageKey);
  return option;
}

function createLanguageOption(
  language: LanguageOption,
  locale: string,
): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = language.code;
  option.textContent =
    language.code === "auto"
      ? message("languageAuto")
      : displayLanguageName(language.code, locale);
  return option;
}

function isUpdateStatus(value: unknown): value is ExtensionUpdateStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true &&
    "state" in value &&
    typeof value.state === "string" &&
    ["never", "current", "available", "ignored", "error"].includes(
      value.state,
    ) &&
    "currentVersion" in value &&
    typeof value.currentVersion === "string"
  );
}

export class UnifiedFloatingControl {
  private readonly host = document.createElement("norixor-floating-control");
  private readonly fullscreenPortal = document.createElement("div");
  private readonly panel = document.createElement("section");
  private readonly panelMenu = document.createElement("details");
  private readonly updateBanner = document.createElement("aside");
  private readonly updateTitle = document.createElement("span");
  private readonly updateLink = document.createElement("a");
  private readonly ignoreUpdateButton = document.createElement("button");
  private readonly launcher = document.createElement("button");
  private readonly quickActions = document.createElement("div");
  private readonly quickTranslateButton = document.createElement("button");
  private readonly quickStopButton = document.createElement("button");
  private readonly pageTab = document.createElement("button");
  private readonly videoTab = document.createElement("button");
  private readonly imageTab = document.createElement("button");
  private readonly pagePanel = document.createElement("div");
  private readonly videoPanel = document.createElement("div");
  private readonly imagePanel = document.createElement("div");
  private readonly pageStatusRow = document.createElement("div");
  private readonly pageStatus = document.createElement("span");
  private readonly pageProgress = document.createElement("span");
  private readonly pageDiagnostic = document.createElement("details");
  private readonly pageDiagnosticText = document.createElement("pre");
  private readonly subtitleStatusRow = document.createElement("div");
  private readonly subtitleStatus = document.createElement("span");
  private readonly subtitleProgress = document.createElement("span");
  private readonly subtitleDiagnostic = document.createElement("details");
  private readonly subtitleDiagnosticText = document.createElement("pre");
  private readonly autoTranslate = document.createElement("input");
  private readonly autoTranslatePattern = document.createElement("small");
  private readonly pageSourceLanguageSelect = document.createElement("select");
  private readonly pageTargetLanguageSelect = document.createElement("select");
  private readonly pageModeSelect = document.createElement("select");
  private readonly pageResponseModeSelect = document.createElement("select");
  private readonly pageDisplayModeSelect = document.createElement("select");
  private readonly selectionTranslationEnabled =
    document.createElement("input");
  private readonly selectionTranslationModeSelect =
    document.createElement("select");
  private readonly translateButton = document.createElement("button");
  private readonly restoreButton = document.createElement("button");
  private readonly subtitleSourceLanguageSelect =
    document.createElement("select");
  private readonly subtitleTargetLanguageSelect =
    document.createElement("select");
  private readonly modeSelect = document.createElement("select");
  private readonly subtitleResponseModeSelect =
    document.createElement("select");
  private readonly displaySelect = document.createElement("select");
  private readonly hideNativeCheckbox = document.createElement("input");
  private readonly subtitleFontDecreaseButton =
    document.createElement("button");
  private readonly subtitleFontIncreaseButton =
    document.createElement("button");
  private readonly subtitleFontScaleValue = document.createElement("output");
  private readonly subtitleOpacityDecreaseButton =
    document.createElement("button");
  private readonly subtitleOpacityIncreaseButton =
    document.createElement("button");
  private readonly subtitleOpacityValue = document.createElement("output");
  private readonly subtitleStartButton = document.createElement("button");
  private readonly subtitleCancelButton = document.createElement("button");
  private readonly ocrStatusRow = document.createElement("div");
  private readonly ocrStatus = document.createElement("span");
  private readonly ocrProgress = document.createElement("span");
  private readonly ocrDetails = document.createElement("details");
  private readonly ocrDiagnostic = document.createElement("details");
  private readonly ocrDiagnosticText = document.createElement("pre");
  private readonly ocrEnabledCheckbox = document.createElement("input");
  private readonly ocrStartButton = document.createElement("button");
  private readonly ocrStopButton = document.createElement("button");
  private readonly imageStatusRow = document.createElement("div");
  private readonly imageStatus = document.createElement("span");
  private readonly imageProgress = document.createElement("span");
  private readonly imageDiagnostic = document.createElement("details");
  private readonly imageDiagnosticText = document.createElement("pre");
  private readonly imageEnabledCheckbox = document.createElement("input");
  private readonly imageSourceLanguageSelect = document.createElement("select");
  private readonly imageTargetLanguageSelect = document.createElement("select");
  private readonly imageModeSelect = document.createElement("select");
  private readonly imageModelOverrideInput = document.createElement("input");
  private readonly imageDisplayModeSelect = document.createElement("select");
  private readonly imageStartButton = document.createElement("button");
  private readonly imageCancelButton = document.createElement("button");
  private settings: ContentSettings;
  private currentPageStatus: PageStatus = {
    state: "idle",
    total: 0,
    completed: 0,
    failed: 0,
  };
  private currentSubtitleStatus: SubtitleStatus = {
    state: "unavailable",
    total: 0,
    completed: 0,
    failed: 0,
  };
  private currentOcrStatus: OcrStatus = { state: "disabled", recognized: 0 };
  private currentImageStatus: ImageTranslationStatus = {
    state: "disabled",
    total: 0,
    completed: 0,
    hasCurrentImage: false,
  };
  private preferredTaskTarget: FloatingTaskTarget = "page";
  private pageBusy = false;
  private expanded = false;
  private dragState: DragState | undefined;
  private suppressLauncherClick = false;
  private positionGeneration = 0;
  private edgeHideTimer: number | undefined;
  private fullscreenActive = false;
  private fullscreenDockedEdge: DockedEdge | undefined;
  private fullscreenPositionSnapshot: FullscreenPositionSnapshot | undefined;
  private fullscreenPositionGeneration = 0;
  private restoreEdgeHiddenAfterFullscreen = false;
  private subtitleTaskBusy = false;
  private subtitleCancelBusy = false;
  private pageSettingsRevision = 0;
  private subtitleSettingsRevision = 0;
  private ocrSettingsRevision = 0;
  private imageSettingsRevision = 0;
  private pendingPageSettings: PendingSettingsPatch<PageSettings> | undefined;
  private pendingSubtitleSettings:
    PendingSettingsPatch<SubtitleSettings> | undefined;
  private pendingOcrSettings:
    PendingSettingsPatch<ContentSettings["ocr"]> | undefined;
  private pendingImageSettings:
    PendingSettingsPatch<ImageTranslationSettings> | undefined;
  private siteAutoTranslateBusy = false;

  constructor(private readonly options: UnifiedFloatingControlOptions) {
    this.settings = options.settings;
    this.host.dataset.norixortransUi = "unified-floating-control";
    this.host.dataset.quickActionSide = "left";
    this.fullscreenPortal.dataset.norixortransUi =
      "floating-control-fullscreen-portal";
    this.fullscreenPortal.setAttribute("popover", "manual");
    Object.assign(this.fullscreenPortal.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      maxWidth: "none",
      maxHeight: "none",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      pointerEvents: "none",
      overflow: "visible",
    });
    const root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = UNIFIED_FLOATING_CONTROL_STYLE;
    const control = document.createElement("div");
    control.className = "control";
    const uiLocale = browser.i18n.getUILanguage();

    this.panel.id = "norixortrans-floating-panel";
    this.panel.className = "panel";
    this.panel.hidden = true;
    this.panel.setAttribute("aria-label", message("floatingControl"));
    const header = document.createElement("div");
    header.className = "header";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = message("floatingControl");
    const headerActions = document.createElement("div");
    headerActions.className = "header-actions";
    const menu = this.panelMenu;
    menu.className = "panel-menu";
    const menuSummary = document.createElement("summary");
    menuSummary.setAttribute("aria-label", message("visibilityMenu"));
    menuSummary.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
    const menuPopover = document.createElement("div");
    menuPopover.className = "panel-menu-popover";
    const hideCurrentButton = document.createElement("button");
    hideCurrentButton.type = "button";
    hideCurrentButton.textContent = message("hideCurrentPage");
    const hidePermanentlyButton = document.createElement("button");
    hidePermanentlyButton.type = "button";
    hidePermanentlyButton.className = "danger";
    hidePermanentlyButton.textContent = message("disableFloatingPermanently");
    const settingsLink = document.createElement("a");
    settingsLink.href =
      browser.runtime?.getURL?.("/options.html") ?? "#settings";
    settingsLink.target = "_blank";
    settingsLink.rel = "noopener";
    settingsLink.textContent = message("optionsTitle");
    const visibilitySettingsLink = document.createElement("a");
    visibilitySettingsLink.href =
      browser.runtime?.getURL?.("/options.html#visibility") ?? "#visibility";
    visibilitySettingsLink.target = "_blank";
    visibilitySettingsLink.rel = "noopener";
    visibilitySettingsLink.textContent = message("manageVisibilityMemory");
    menuPopover.append(
      settingsLink,
      visibilitySettingsLink,
      hideCurrentButton,
      hidePermanentlyButton,
    );
    menu.append(menuSummary, menuPopover);
    const closeButton = document.createElement("button");
    closeButton.className = "icon-button";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", message("closeQuickSettings"));
    closeButton.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    headerActions.append(menu, closeButton);
    header.append(title, headerActions);

    this.updateBanner.className = "update-banner";
    this.updateBanner.hidden = true;
    this.updateTitle.className = "update-title";
    this.updateLink.className = "update-link";
    this.updateLink.target = "_blank";
    this.updateLink.rel = "noopener";
    this.updateLink.textContent = message("updateViewRelease");
    this.ignoreUpdateButton.type = "button";
    this.ignoreUpdateButton.className = "update-ignore";
    this.ignoreUpdateButton.textContent = message("updateIgnoreVersion");
    this.updateBanner.append(
      this.updateTitle,
      this.updateLink,
      this.ignoreUpdateButton,
    );

    const tablist = document.createElement("div");
    tablist.className = "tablist";
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", message("floatingControl"));
    this.configureTab(
      this.pageTab,
      "norixortrans-page-panel",
      message("pageTranslationTab"),
      true,
    );
    this.configureTab(
      this.videoTab,
      "norixortrans-video-panel",
      message("videoTranslationTab"),
      false,
    );
    this.configureTab(
      this.imageTab,
      "norixortrans-image-panel",
      message("imageTranslationTab"),
      false,
    );
    tablist.append(this.pageTab, this.videoTab, this.imageTab);

    this.pagePanel.id = "norixortrans-page-panel";
    this.pagePanel.className = "tab-panel";
    this.pagePanel.setAttribute("role", "tabpanel");
    this.pagePanel.setAttribute("aria-labelledby", this.pageTab.id);
    this.pagePanel.tabIndex = 0;
    this.pageStatusRow.className = "status-row";
    const pageStatusCopy = this.createStatusCopy(this.pageStatus);
    this.pageProgress.className = "progress";
    this.pageStatusRow.append(pageStatusCopy, this.pageProgress);
    this.configureDiagnostic(this.pageDiagnostic, this.pageDiagnosticText);
    const autoLabel = document.createElement("label");
    autoLabel.className = "checkbox page-toggle";
    this.autoTranslate.type = "checkbox";
    this.autoTranslate.setAttribute(
      "aria-label",
      message("pageAutoTranslateCurrentSite"),
    );
    const autoCopy = document.createElement("span");
    autoCopy.className = "checkbox-copy";
    const autoText = document.createElement("span");
    autoText.textContent = message("pageAutoTranslateCurrentSite");
    this.autoTranslatePattern.textContent =
      autoTranslateSitePatternForHostname(location.hostname) ??
      location.hostname;
    autoCopy.append(autoText, this.autoTranslatePattern);
    autoLabel.append(this.autoTranslate, autoCopy);
    const pageSourceLanguageField = this.createSelectField(
      message("sourceLanguage"),
      this.pageSourceLanguageSelect,
      SOURCE_LANGUAGES.map((language) =>
        createLanguageOption(language, uiLocale),
      ),
    );
    const pageTargetLanguageField = this.createSelectField(
      message("targetLanguage"),
      this.pageTargetLanguageSelect,
      TARGET_LANGUAGES.map((language) =>
        createLanguageOption(language, uiLocale),
      ),
    );
    const pageModeField = this.createSelectField(
      message("translationMode"),
      this.pageModeSelect,
      [createOption("fast", "modeFast"), createOption("ai", "modeAi")],
    );
    const pageResponseModeField = this.createSelectField(
      message("aiResponseMode"),
      this.pageResponseModeSelect,
      [
        createOption("stream", "responseModeStream"),
        createOption("batch", "responseModeBatch"),
      ],
    );
    const pageDisplayModeField = this.createSelectField(
      message("displayMode"),
      this.pageDisplayModeSelect,
      [
        createOption("translated", "pageDisplayReplace"),
        createOption("bilingual", "pageDisplayAppend"),
      ],
    );
    const selectionTranslationModeField = this.createSelectField(
      message("selectionTranslationMode"),
      this.selectionTranslationModeSelect,
      [createOption("fast", "modeFast"), createOption("ai", "modeAi")],
    );
    selectionTranslationModeField.classList.add("field-wide");
    const selectionTranslationLabel = document.createElement("label");
    selectionTranslationLabel.className = "checkbox";
    this.selectionTranslationEnabled.type = "checkbox";
    const selectionTranslationText = document.createElement("span");
    selectionTranslationText.textContent = message(
      "selectionTranslationEnabled",
    );
    selectionTranslationLabel.append(
      this.selectionTranslationEnabled,
      selectionTranslationText,
    );
    const pageSettingsGrid = document.createElement("div");
    pageSettingsGrid.className = "settings-grid";
    pageSettingsGrid.append(
      pageSourceLanguageField,
      pageTargetLanguageField,
      pageModeField,
      pageResponseModeField,
      pageDisplayModeField,
      autoLabel,
      selectionTranslationModeField,
      selectionTranslationLabel,
    );
    const pageActions = document.createElement("div");
    pageActions.className = "actions";
    this.translateButton.type = "button";
    this.translateButton.className = "primary";
    this.translateButton.textContent = message("widgetTranslate");
    this.restoreButton.type = "button";
    this.restoreButton.textContent = message("widgetRestore");
    pageActions.append(this.translateButton, this.restoreButton);
    this.pagePanel.append(
      this.pageStatusRow,
      this.pageDiagnostic,
      pageSettingsGrid,
      pageActions,
    );

    this.videoPanel.id = "norixortrans-video-panel";
    this.videoPanel.className = "tab-panel";
    this.videoPanel.setAttribute("role", "tabpanel");
    this.videoPanel.setAttribute("aria-labelledby", this.videoTab.id);
    this.videoPanel.tabIndex = 0;
    this.videoPanel.hidden = true;
    this.subtitleStatusRow.className = "status-row";
    const subtitleStatusCopy = this.createStatusCopy(this.subtitleStatus);
    this.subtitleProgress.className = "progress";
    this.subtitleStatusRow.append(subtitleStatusCopy, this.subtitleProgress);
    this.configureDiagnostic(
      this.subtitleDiagnostic,
      this.subtitleDiagnosticText,
    );
    const subtitleSourceLanguageField = this.createSelectField(
      message("sourceLanguage"),
      this.subtitleSourceLanguageSelect,
      SOURCE_LANGUAGES.map((language) =>
        createLanguageOption(language, uiLocale),
      ),
    );
    const subtitleTargetLanguageField = this.createSelectField(
      message("targetLanguage"),
      this.subtitleTargetLanguageSelect,
      TARGET_LANGUAGES.map((language) =>
        createLanguageOption(language, uiLocale),
      ),
    );
    const modeField = this.createSelectField(
      message("translationMode"),
      this.modeSelect,
      [createOption("fast", "modeFast"), createOption("ai", "modeAi")],
    );
    const subtitleResponseModeField = this.createSelectField(
      message("aiResponseMode"),
      this.subtitleResponseModeSelect,
      [
        createOption("stream", "responseModeStream"),
        createOption("batch", "responseModeBatch"),
      ],
    );
    const displayField = this.createSelectField(
      message("subtitleDisplayMode"),
      this.displaySelect,
      [
        createOption("original", "displayOriginal"),
        createOption("translated", "displayTranslated"),
        createOption("bilingual", "displayBilingual"),
      ],
    );
    const hideNativeLabel = document.createElement("label");
    hideNativeLabel.className = "checkbox";
    this.hideNativeCheckbox.type = "checkbox";
    const hideNativeText = document.createElement("span");
    hideNativeText.textContent = message("hideNativeSubtitles");
    hideNativeLabel.append(this.hideNativeCheckbox, hideNativeText);
    const videoSettingsGrid = document.createElement("div");
    videoSettingsGrid.className = "settings-grid";
    const subtitleAppearance = document.createElement("div");
    subtitleAppearance.className = "subtitle-appearance";
    subtitleAppearance.append(
      this.createAdjustment(
        message("subtitleFontSize"),
        this.subtitleFontScaleValue,
        this.subtitleFontDecreaseButton,
        this.subtitleFontIncreaseButton,
        message("subtitleFontDecrease"),
        message("subtitleFontIncrease"),
      ),
      this.createAdjustment(
        message("subtitleBackground"),
        this.subtitleOpacityValue,
        this.subtitleOpacityDecreaseButton,
        this.subtitleOpacityIncreaseButton,
        message("subtitleOpacityDecrease"),
        message("subtitleOpacityIncrease"),
      ),
    );
    videoSettingsGrid.append(
      subtitleSourceLanguageField,
      subtitleTargetLanguageField,
      modeField,
      subtitleResponseModeField,
      displayField,
      hideNativeLabel,
      subtitleAppearance,
    );
    const subtitleActions = document.createElement("div");
    subtitleActions.className = "actions subtitle-actions";
    this.subtitleStartButton.type = "button";
    this.subtitleStartButton.className = "primary";
    this.subtitleStartButton.textContent = message("startSubtitleTranslation");
    this.subtitleCancelButton.type = "button";
    this.subtitleCancelButton.textContent = message(
      "cancelSubtitleTranslation",
    );
    subtitleActions.append(this.subtitleStartButton, this.subtitleCancelButton);
    const createProfileButton = document.createElement("button");
    createProfileButton.type = "button";
    createProfileButton.className = "profile-action";
    createProfileButton.textContent = message("createSiteProfile");
    this.ocrDetails.className = "ocr-section";
    const ocrSummary = document.createElement("summary");
    this.ocrStatusRow.className = "status-row";
    const ocrStatusCopy = this.createStatusCopy(this.ocrStatus);
    this.ocrProgress.className = "progress";
    this.ocrStatusRow.append(ocrStatusCopy, this.ocrProgress);
    const ocrEnabledLabel = document.createElement("label");
    ocrEnabledLabel.className = "checkbox";
    this.ocrEnabledCheckbox.type = "checkbox";
    const ocrEnabledText = document.createElement("span");
    ocrEnabledText.textContent = message("ocrExperimentalEnabled");
    ocrEnabledLabel.append(this.ocrEnabledCheckbox, ocrEnabledText);
    const ocrControls = document.createElement("div");
    ocrControls.className = "ocr-controls";
    const ocrActions = document.createElement("div");
    ocrActions.className = "actions";
    this.ocrStartButton.type = "button";
    this.ocrStartButton.className = "primary";
    this.ocrStartButton.textContent = message("ocrStart");
    this.ocrStopButton.type = "button";
    this.ocrStopButton.textContent = message("ocrStop");
    ocrActions.append(this.ocrStartButton, this.ocrStopButton);
    this.configureDiagnostic(this.ocrDiagnostic, this.ocrDiagnosticText);
    ocrSummary.append(this.ocrStatusRow);
    ocrControls.append(ocrEnabledLabel, ocrActions, this.ocrDiagnostic);
    this.ocrDetails.append(ocrSummary, ocrControls);
    this.videoPanel.append(
      this.subtitleStatusRow,
      subtitleActions,
      this.subtitleDiagnostic,
      videoSettingsGrid,
      createProfileButton,
      this.ocrDetails,
    );

    this.imagePanel.id = "norixortrans-image-panel";
    this.imagePanel.className = "tab-panel";
    this.imagePanel.setAttribute("role", "tabpanel");
    this.imagePanel.setAttribute("aria-labelledby", this.imageTab.id);
    this.imagePanel.tabIndex = 0;
    this.imagePanel.hidden = true;
    this.imageStatusRow.className = "status-row";
    this.imageStatusRow.append(
      this.createStatusCopy(this.imageStatus),
      this.imageProgress,
    );
    this.imageProgress.className = "progress";
    this.configureDiagnostic(this.imageDiagnostic, this.imageDiagnosticText);
    const imageEnabledLabel = document.createElement("label");
    imageEnabledLabel.className = "checkbox field-wide";
    this.imageEnabledCheckbox.type = "checkbox";
    const imageEnabledText = document.createElement("span");
    imageEnabledText.textContent = message("imageTranslationEnabled");
    imageEnabledLabel.append(this.imageEnabledCheckbox, imageEnabledText);
    const imageSourceField = this.createSelectField(
      message("sourceLanguage"),
      this.imageSourceLanguageSelect,
      SOURCE_LANGUAGES.map((language) =>
        createLanguageOption(language, uiLocale),
      ),
    );
    const imageTargetField = this.createSelectField(
      message("targetLanguage"),
      this.imageTargetLanguageSelect,
      TARGET_LANGUAGES.map((language) =>
        createLanguageOption(language, uiLocale),
      ),
    );
    const imageModeField = this.createSelectField(
      message("translationMode"),
      this.imageModeSelect,
      [createOption("fast", "modeFast"), createOption("ai", "modeAi")],
    );
    const imageDisplayField = this.createSelectField(
      message("displayMode"),
      this.imageDisplayModeSelect,
      [
        createOption("translated", "displayTranslated"),
        createOption("bilingual", "displayBilingual"),
      ],
    );
    const imageModelField = document.createElement("label");
    imageModelField.className = "field field-wide";
    const imageModelLabel = document.createElement("span");
    imageModelLabel.textContent = message("imageModelOverride");
    this.imageModelOverrideInput.className = "compact-input";
    this.imageModelOverrideInput.type = "text";
    this.imageModelOverrideInput.maxLength = 256;
    this.imageModelOverrideInput.placeholder = message("imageModelInherit");
    imageModelField.append(imageModelLabel, this.imageModelOverrideInput);
    const imageGrid = document.createElement("div");
    imageGrid.className = "settings-grid";
    imageGrid.append(
      imageEnabledLabel,
      imageSourceField,
      imageTargetField,
      imageModeField,
      imageDisplayField,
      imageModelField,
    );
    const imageActions = document.createElement("div");
    imageActions.className = "actions";
    this.imageStartButton.type = "button";
    this.imageStartButton.className = "primary";
    this.imageStartButton.textContent = message("imageTranslateCurrent");
    this.imageCancelButton.type = "button";
    this.imageCancelButton.textContent = message("imageCancelOrClear");
    imageActions.append(this.imageStartButton, this.imageCancelButton);
    this.imagePanel.append(
      this.imageStatusRow,
      this.imageDiagnostic,
      imageGrid,
      imageActions,
    );

    this.launcher.className = "icon-button launcher";
    this.launcher.type = "button";
    this.launcher.setAttribute("aria-label", message("floatingControl"));
    this.launcher.setAttribute("aria-controls", this.panel.id);
    this.launcher.setAttribute("aria-expanded", "false");
    this.launcher.setAttribute(
      "aria-keyshortcuts",
      "ArrowUp ArrowDown ArrowLeft ArrowRight",
    );
    this.launcher.innerHTML =
      '<span class="launcher-surface"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h10M9 3v2c0 4-2 7-5 9"/><path d="M6 10c2 0 4 1 6 3"/><path d="m14 19 3-8 3 8M15 16h4"/></svg><span class="launcher-active-dot" aria-hidden="true"></span></span>';

    this.quickActions.className = "quick-actions";
    this.quickActions.setAttribute("role", "group");
    this.quickActions.setAttribute(
      "aria-label",
      message("floatingPageQuickActions"),
    );
    this.quickTranslateButton.type = "button";
    this.quickTranslateButton.className = "quick-action quick-translate";
    this.quickTranslateButton.setAttribute(
      "aria-label",
      message("widgetTranslate"),
    );
    this.quickTranslateButton.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h10M9 3v2c0 4-2 7-5 9"/><path d="M6 10c2 0 4 1 6 3"/><path d="m14 19 3-8 3 8M15 16h4"/></svg>';
    this.quickStopButton.type = "button";
    this.quickStopButton.className = "quick-action quick-stop";
    this.quickStopButton.setAttribute(
      "aria-label",
      message("stopPageTranslation"),
    );
    this.quickStopButton.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';
    this.quickActions.append(this.quickTranslateButton, this.quickStopButton);

    this.panel.append(
      header,
      this.updateBanner,
      tablist,
      this.pagePanel,
      this.videoPanel,
      this.imagePanel,
    );
    control.append(this.panel, this.launcher, this.quickActions);
    root.append(style, control);
    document.documentElement.append(this.host);

    closeButton.addEventListener("click", () => this.collapse(true));
    hideCurrentButton.addEventListener("click", () => {
      void this.runHideCurrentAction(hideCurrentButton);
    });
    hidePermanentlyButton.addEventListener("click", () => {
      void this.runHidePermanentlyAction(hidePermanentlyButton);
    });
    this.ignoreUpdateButton.addEventListener("click", () => {
      const version = this.ignoreUpdateButton.dataset.version;
      if (!version) return;
      void browser.runtime
        .sendMessage({ type: "UPDATE_IGNORE", version })
        .then((response: unknown) => {
          if (isUpdateStatus(response)) this.renderUpdateStatus(response);
        })
        .catch(() => undefined);
    });
    const collapseForSettingsNavigation = (): void => {
      menu.open = false;
      this.collapse(false);
    };
    settingsLink.addEventListener("click", collapseForSettingsNavigation);
    visibilitySettingsLink.addEventListener(
      "click",
      collapseForSettingsNavigation,
    );
    this.launcher.addEventListener("click", this.handleLauncherClick);
    this.launcher.addEventListener("pointerdown", this.startDrag);
    this.launcher.addEventListener("pointermove", this.moveDrag);
    this.launcher.addEventListener("pointerup", this.endDrag);
    this.launcher.addEventListener("pointercancel", this.cancelDrag);
    this.launcher.addEventListener("keydown", this.moveLauncherWithKeyboard);
    this.launcher.addEventListener(
      "lostpointercapture",
      this.handleLostPointerCapture,
    );
    this.host.addEventListener("pointerleave", this.scheduleEdgeHide);
    this.pageTab.addEventListener("click", () => this.activateTab("page"));
    this.videoTab.addEventListener("click", () => this.activateTab("video"));
    this.imageTab.addEventListener("click", () => this.activateTab("image"));
    tablist.addEventListener("keydown", this.handleTabKeydown);
    this.translateButton.addEventListener("click", () => {
      void this.runPageAction(() => this.options.onPageTranslate());
    });
    this.quickTranslateButton.addEventListener("click", () => {
      void this.runQuickTranslateAction();
    });
    this.quickStopButton.addEventListener("click", () => {
      void this.runQuickStopAction();
    });
    this.restoreButton.addEventListener("click", () => {
      void this.runPageAction(() => this.options.onPageRestore());
    });
    this.autoTranslate.addEventListener("change", () => {
      void this.changeAutoTranslate();
    });
    this.pageSourceLanguageSelect.addEventListener("change", () => {
      void this.changePageSettings();
    });
    this.pageTargetLanguageSelect.addEventListener("change", () => {
      void this.changePageSettings();
    });
    this.pageModeSelect.addEventListener("change", () => {
      void this.changePageMode();
    });
    this.pageResponseModeSelect.addEventListener("change", () => {
      void this.changePageResponseMode();
    });
    this.pageDisplayModeSelect.addEventListener("change", () => {
      void this.changePageSettings();
    });
    this.selectionTranslationModeSelect.addEventListener("change", () => {
      void this.changePageSettings();
    });
    this.selectionTranslationEnabled.addEventListener("change", () => {
      void this.changePageSettings();
    });
    this.subtitleSourceLanguageSelect.addEventListener("change", () => {
      void this.changeSubtitleSettings();
    });
    this.subtitleTargetLanguageSelect.addEventListener("change", () => {
      void this.changeSubtitleSettings();
    });
    this.modeSelect.addEventListener("change", () => {
      void this.changeSubtitleSettings();
    });
    this.subtitleResponseModeSelect.addEventListener("change", () => {
      void this.changeSubtitleSettings();
    });
    this.displaySelect.addEventListener("change", () => {
      void this.changeSubtitleSettings();
    });
    this.hideNativeCheckbox.addEventListener("change", () => {
      void this.changeSubtitleSettings();
    });
    this.subtitleFontDecreaseButton.addEventListener("click", () => {
      void this.changeSubtitleAppearance("fontScale", -0.05);
    });
    this.subtitleFontIncreaseButton.addEventListener("click", () => {
      void this.changeSubtitleAppearance("fontScale", 0.05);
    });
    this.subtitleOpacityDecreaseButton.addEventListener("click", () => {
      void this.changeSubtitleAppearance("backgroundOpacity", -0.05);
    });
    this.subtitleOpacityIncreaseButton.addEventListener("click", () => {
      void this.changeSubtitleAppearance("backgroundOpacity", 0.05);
    });
    this.subtitleStartButton.addEventListener("click", () => {
      void this.runSubtitleTaskAction(() => this.options.onSubtitleStart());
    });
    this.subtitleCancelButton.addEventListener("click", () => {
      void this.runSubtitleCancelAction();
    });
    createProfileButton.addEventListener("click", () => {
      this.collapse(false);
      void this.options.onCreateProfile();
    });
    this.ocrEnabledCheckbox.addEventListener("change", () => {
      void this.changeOcrEnabled();
    });
    this.ocrStartButton.addEventListener("click", () => {
      this.preferredTaskTarget = "video";
      this.collapse(false);
      void this.options.onOcrStart?.();
    });
    this.ocrStopButton.addEventListener("click", () => {
      this.preferredTaskTarget = "video";
      void this.options.onOcrStop?.();
    });
    for (const control of [
      this.imageEnabledCheckbox,
      this.imageSourceLanguageSelect,
      this.imageTargetLanguageSelect,
      this.imageModeSelect,
      this.imageDisplayModeSelect,
    ]) {
      control.addEventListener("change", () => void this.changeImageSettings());
    }
    this.imageModelOverrideInput.addEventListener("change", () => {
      void this.changeImageSettings();
    });
    this.imageStartButton.addEventListener("click", () => {
      this.preferredTaskTarget = "image";
      void this.options.onImageStart?.();
    });
    this.imageCancelButton.addEventListener("click", () => {
      this.preferredTaskTarget = "image";
      void this.options.onImageCancelOrClear?.();
    });
    document.addEventListener("pointerdown", this.handleOutsidePointerDown);
    document.addEventListener("keydown", this.handleDocumentKeydown);
    document.addEventListener("fullscreenchange", this.handleFullscreenChange);
    window.addEventListener("resize", this.handleViewportResize);
    window.visualViewport?.addEventListener(
      "resize",
      this.handleViewportResize,
    );

    this.updateSettings(options.settings);
    this.updatePageStatus(this.currentPageStatus);
    this.updateSubtitleStatus(this.currentSubtitleStatus);
    this.updateOcrStatus({
      state: options.settings.ocr.enabled ? "idle" : "disabled",
      recognized: 0,
    });
    this.updateImageStatus({
      state: options.settings.imageTranslation.enabled ? "idle" : "disabled",
      total: 0,
      completed: 0,
      hasCurrentImage: false,
    });
    this.restoreStoredPosition();
    void this.restorePersistedPosition();
    void this.refreshUpdateStatus();
    this.handleFullscreenChange();
  }

  private renderUpdateStatus(status: ExtensionUpdateStatus): void {
    const available =
      status.state === "available" &&
      Boolean(status.latestVersion) &&
      Boolean(status.releaseUrl);
    this.updateBanner.hidden = !available;
    if (!available || !status.latestVersion || !status.releaseUrl) return;
    this.updateTitle.textContent = message(
      "updateAvailableTitle",
      status.latestVersion,
    );
    this.updateLink.href = status.releaseUrl;
    this.ignoreUpdateButton.dataset.version = status.latestVersion;
  }

  private async refreshUpdateStatus(): Promise<void> {
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "UPDATE_STATUS_GET",
      });
      if (isUpdateStatus(response)) this.renderUpdateStatus(response);
    } catch {
      this.updateBanner.hidden = true;
    }
  }

  updateSettings(settings: ContentSettings): void {
    this.pageSettingsRevision += 1;
    this.subtitleSettingsRevision += 1;
    this.ocrSettingsRevision += 1;
    this.imageSettingsRevision += 1;
    this.settings = settings;
    this.renderPageSettings();
    this.renderSubtitleSettings();
    this.renderOcrSettings();
    this.renderImageSettings();
  }

  private renderPageSettings(): void {
    const settings = {
      ...this.settings.page,
      ...this.pendingPageSettings?.patch,
    };
    this.autoTranslate.checked = isSiteAutoTranslateEnabled(
      settings,
      location.hostname,
    );
    this.pageSourceLanguageSelect.value = settings.sourceLanguage;
    this.pageTargetLanguageSelect.value = settings.targetLanguage;
    this.pageModeSelect.value = settings.mode;
    this.pageResponseModeSelect.value = settings.aiResponseMode;
    this.pageDisplayModeSelect.value = settings.displayMode;
    this.selectionTranslationEnabled.checked =
      settings.selectionTranslationEnabled;
    this.selectionTranslationModeSelect.value =
      settings.selectionTranslationMode;
    this.setPageSettingsDisabled(this.pendingPageSettings !== undefined);
  }

  private renderSubtitleSettings(): void {
    const settings = {
      ...this.settings.subtitles,
      ...this.pendingSubtitleSettings?.patch,
    };
    this.subtitleSourceLanguageSelect.value = settings.sourceLanguage;
    this.subtitleTargetLanguageSelect.value = settings.targetLanguage;
    this.modeSelect.value = settings.mode;
    this.subtitleResponseModeSelect.value = settings.aiResponseMode;
    this.displaySelect.value = settings.displayMode;
    this.hideNativeCheckbox.checked = settings.hideNativeSubtitles;
    this.subtitleFontScaleValue.textContent = message(
      "percentageValue",
      String(Math.round(settings.fontScale * 100)),
    );
    this.subtitleOpacityValue.textContent = message(
      "percentageValue",
      String(Math.round(settings.backgroundOpacity * 100)),
    );
    this.setSubtitleSettingsDisabled(
      this.pendingSubtitleSettings !== undefined,
    );
  }

  private renderOcrSettings(): void {
    const settings = {
      ...this.settings.ocr,
      ...this.pendingOcrSettings?.patch,
    };
    this.ocrEnabledCheckbox.checked = settings.enabled;
    this.syncOcrButtons();
  }

  private renderImageSettings(): void {
    const settings = {
      ...this.settings.imageTranslation,
      ...this.pendingImageSettings?.patch,
    };
    this.imageEnabledCheckbox.checked = settings.enabled;
    this.imageSourceLanguageSelect.value = settings.sourceLanguage;
    this.imageTargetLanguageSelect.value = settings.targetLanguage;
    this.imageModeSelect.value = settings.mode;
    this.imageModelOverrideInput.value = settings.modelOverride;
    this.imageDisplayModeSelect.value = settings.displayMode;
    const disabled = this.pendingImageSettings !== undefined;
    this.imageEnabledCheckbox.disabled = disabled;
    this.imageSourceLanguageSelect.disabled = disabled || !settings.enabled;
    this.imageTargetLanguageSelect.disabled = disabled || !settings.enabled;
    this.imageModeSelect.disabled = disabled || !settings.enabled;
    this.imageDisplayModeSelect.disabled = disabled || !settings.enabled;
    this.imageModelOverrideInput.disabled =
      disabled || !settings.enabled || settings.mode !== "ai";
    this.syncImageButtons();
  }

  private beginPageSettingsChange(
    patch: Partial<PageSettings>,
  ): PendingSettingsPatch<PageSettings> | undefined {
    if (this.pendingPageSettings) return undefined;
    const pending = { revision: this.pageSettingsRevision, patch };
    this.pendingPageSettings = pending;
    this.renderPageSettings();
    return pending;
  }

  private finishPageSettingsChange(
    pending: PendingSettingsPatch<PageSettings>,
    succeeded: boolean,
  ): void {
    if (this.pendingPageSettings !== pending) return;
    if (succeeded && this.pageSettingsRevision === pending.revision) {
      this.settings = {
        ...this.settings,
        page: { ...this.settings.page, ...pending.patch },
      };
    }
    this.pendingPageSettings = undefined;
    this.renderPageSettings();
  }

  private beginSubtitleSettingsChange(
    patch: Partial<SubtitleSettings>,
  ): PendingSettingsPatch<SubtitleSettings> | undefined {
    if (this.pendingSubtitleSettings) return undefined;
    const pending = { revision: this.subtitleSettingsRevision, patch };
    this.pendingSubtitleSettings = pending;
    this.renderSubtitleSettings();
    return pending;
  }

  private finishSubtitleSettingsChange(
    pending: PendingSettingsPatch<SubtitleSettings>,
    succeeded: boolean,
  ): void {
    if (this.pendingSubtitleSettings !== pending) return;
    if (succeeded && this.subtitleSettingsRevision === pending.revision) {
      this.settings = {
        ...this.settings,
        subtitles: { ...this.settings.subtitles, ...pending.patch },
      };
    }
    this.pendingSubtitleSettings = undefined;
    this.renderSubtitleSettings();
  }

  private beginOcrSettingsChange(
    patch: Partial<ContentSettings["ocr"]>,
  ): PendingSettingsPatch<ContentSettings["ocr"]> | undefined {
    if (this.pendingOcrSettings) return undefined;
    const pending = { revision: this.ocrSettingsRevision, patch };
    this.pendingOcrSettings = pending;
    this.renderOcrSettings();
    return pending;
  }

  private finishOcrSettingsChange(
    pending: PendingSettingsPatch<ContentSettings["ocr"]>,
    succeeded: boolean,
  ): void {
    if (this.pendingOcrSettings !== pending) return;
    if (succeeded && this.ocrSettingsRevision === pending.revision) {
      this.settings = {
        ...this.settings,
        ocr: { ...this.settings.ocr, ...pending.patch },
      };
    }
    this.pendingOcrSettings = undefined;
    this.renderOcrSettings();
  }

  private async changeImageSettings(): Promise<void> {
    if (this.pendingImageSettings) return;
    const sourceLanguage = this.imageSourceLanguageSelect.value;
    const targetLanguage = this.imageTargetLanguageSelect.value;
    const mode = this.imageModeSelect.value;
    const displayMode = this.imageDisplayModeSelect.value;
    if (
      !SOURCE_LANGUAGES.some((language) => language.code === sourceLanguage) ||
      !TARGET_LANGUAGES.some((language) => language.code === targetLanguage) ||
      (mode !== "fast" && mode !== "ai") ||
      (displayMode !== "translated" && displayMode !== "bilingual")
    ) {
      return;
    }
    const patch: ImageSettingsPatch = {
      enabled: this.imageEnabledCheckbox.checked,
      sourceLanguage,
      targetLanguage,
      mode,
      modelOverride: this.imageModelOverrideInput.value.trim().slice(0, 256),
      displayMode,
    };
    const pending = {
      revision: this.imageSettingsRevision,
      patch,
    };
    this.pendingImageSettings = pending;
    this.renderImageSettings();
    let succeeded = false;
    try {
      await this.options.onImageSettingsChange?.(patch);
      succeeded = true;
    } catch {
      this.imageStatusRow.dataset.state = "error";
      this.imageStatus.textContent = message("settingsSaveFailed");
    } finally {
      if (this.pendingImageSettings === pending) {
        if (succeeded && this.imageSettingsRevision === pending.revision) {
          this.settings = {
            ...this.settings,
            imageTranslation: {
              ...this.settings.imageTranslation,
              ...pending.patch,
            },
          };
        }
        this.pendingImageSettings = undefined;
        this.renderImageSettings();
      }
    }
  }

  updatePageStatus(status: PageStatus): void {
    this.currentPageStatus = status;
    if (this.pageTaskActive()) this.preferredTaskTarget = "page";
    this.pageStatusRow.dataset.state = status.state;
    this.pageStatus.textContent =
      status.message ?? pageStateMessage(status.state);
    this.pageProgress.textContent = this.progressText(status);
    this.updateDiagnostic(
      this.pageDiagnostic,
      this.pageDiagnosticText,
      status.details,
    );
    this.syncPageButtons();
    this.syncLauncherLoading();
  }

  updateSubtitleStatus(status: SubtitleStatus): void {
    this.currentSubtitleStatus = status;
    if (this.videoTaskActive()) this.preferredTaskTarget = "video";
    const displayState = stableSubtitleDisplayState(status);
    this.subtitleStatusRow.dataset.state = displayState;
    this.subtitleStatus.textContent = subtitleStatusMessage(
      status,
      displayState,
    );
    this.subtitleProgress.textContent = this.progressText(status);
    this.updateDiagnostic(
      this.subtitleDiagnostic,
      this.subtitleDiagnosticText,
      status.details,
    );
    this.syncVideoStatusVisibility();
    this.syncSubtitleTaskButtons();
    this.syncLauncherLoading();
  }

  updateOcrStatus(status: OcrStatus): void {
    this.currentOcrStatus = status;
    if (this.ocrTaskActive()) this.preferredTaskTarget = "video";
    this.ocrStatusRow.dataset.state = status.state;
    this.ocrStatus.textContent =
      status.message ?? ocrStateMessage(status.state);
    this.ocrProgress.textContent =
      status.state === "initializing" && status.progress !== undefined
        ? `${Math.round(status.progress * 100)}%`
        : status.recognized > 0
          ? message("ocrRecognizedCount", String(status.recognized))
          : "";
    this.updateDiagnostic(
      this.ocrDiagnostic,
      this.ocrDiagnosticText,
      status.state === "error" || status.state === "unavailable"
        ? status.message
        : undefined,
    );
    if (!["disabled", "idle", "cancelled"].includes(status.state)) {
      this.ocrDetails.open = true;
    }
    this.syncVideoStatusVisibility();
    this.syncOcrButtons();
    this.syncQuickActions();
    this.syncLauncherLoading();
  }

  updateImageStatus(status: ImageTranslationStatus): void {
    this.currentImageStatus = status;
    if (["capturing", "recognizing", "translating"].includes(status.state)) {
      this.preferredTaskTarget = "image";
    }
    this.imageStatusRow.dataset.state = status.state;
    this.imageStatus.textContent =
      status.message ??
      message(
        `imageStatus${status.state[0]?.toUpperCase()}${status.state.slice(1)}`,
      );
    this.imageProgress.textContent = this.progressText(status);
    this.updateDiagnostic(
      this.imageDiagnostic,
      this.imageDiagnosticText,
      status.details,
    );
    this.syncImageButtons();
    this.syncQuickActions();
    this.syncLauncherLoading();
  }

  private syncVideoStatusVisibility(): void {
    const ocrHasCurrentTrack =
      this.currentOcrStatus.recognized > 0 ||
      [
        "selecting",
        "initializing",
        "capturing",
        "recognizing",
        "active",
      ].includes(this.currentOcrStatus.state);
    // The OCR section already owns this state. Avoid contradicting it with a
    // simultaneous "no readable subtitle track" message above the controls.
    this.subtitleStatusRow.hidden =
      this.currentSubtitleStatus.state === "unavailable" && ocrHasCurrentTrack;
  }

  show(): void {
    this.host.dataset.hidden = "false";
  }

  hide(): void {
    this.collapse(false);
    this.host.dataset.hidden = "true";
  }

  destroy(): void {
    document.removeEventListener("pointerdown", this.handleOutsidePointerDown);
    document.removeEventListener("keydown", this.handleDocumentKeydown);
    document.removeEventListener(
      "fullscreenchange",
      this.handleFullscreenChange,
    );
    window.removeEventListener("resize", this.handleViewportResize);
    window.visualViewport?.removeEventListener(
      "resize",
      this.handleViewportResize,
    );
    this.removeDragFallbackListeners();
    this.launcher.removeEventListener(
      "lostpointercapture",
      this.handleLostPointerCapture,
    );
    this.launcher.removeEventListener("keydown", this.moveLauncherWithKeyboard);
    if (this.edgeHideTimer !== undefined) {
      window.clearTimeout(this.edgeHideTimer);
    }
    this.host.removeEventListener("pointerleave", this.scheduleEdgeHide);
    try {
      (
        this.fullscreenPortal as HTMLElement & { hidePopover?: () => void }
      ).hidePopover?.();
    } catch {
      // Ignore a portal that was already closed by the browser.
    }
    this.fullscreenPortal.remove();
    this.host.remove();
  }

  private configureTab(
    tab: HTMLButtonElement,
    panelId: string,
    label: string,
    selected: boolean,
  ): void {
    tab.id = `${panelId}-tab`;
    tab.className = "tab";
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panelId);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.textContent = label;
  }

  private configureDiagnostic(
    diagnostic: HTMLDetailsElement,
    text: HTMLPreElement,
  ): void {
    diagnostic.className = "diagnostic";
    diagnostic.hidden = true;
    const summary = document.createElement("summary");
    summary.textContent = message("viewProviderDetails");
    text.setAttribute("aria-label", message("providerDetailsLabel"));
    diagnostic.append(summary, text);
  }

  private updateDiagnostic(
    diagnostic: HTMLDetailsElement,
    text: HTMLPreElement,
    details: string | undefined,
  ): void {
    const visibleDetails = details?.trim().slice(0, 4_000) ?? "";
    text.textContent = visibleDetails;
    diagnostic.hidden = !visibleDetails;
    if (!visibleDetails) diagnostic.open = false;
  }

  private createStatusCopy(status: HTMLSpanElement): HTMLDivElement {
    const copy = document.createElement("div");
    copy.className = "status-copy";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");
    status.className = "status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    copy.append(dot, status);
    return copy;
  }

  private createSelectField(
    labelText: string,
    select: HTMLSelectElement,
    options: readonly HTMLOptionElement[],
  ): HTMLLabelElement {
    const label = document.createElement("label");
    label.className = "field";
    const text = document.createElement("span");
    text.textContent = labelText;
    select.append(...options);
    label.append(text, select);
    return label;
  }

  private createAdjustment(
    labelText: string,
    output: HTMLOutputElement,
    decreaseButton: HTMLButtonElement,
    increaseButton: HTMLButtonElement,
    decreaseLabel: string,
    increaseLabel: string,
  ): HTMLDivElement {
    const adjustment = document.createElement("div");
    adjustment.className = "adjustment";
    const label = document.createElement("span");
    label.className = "adjustment-label";
    label.textContent = labelText;
    const stepper = document.createElement("div");
    stepper.className = "stepper";
    decreaseButton.type = "button";
    decreaseButton.textContent = "−";
    decreaseButton.setAttribute("aria-label", decreaseLabel);
    decreaseButton.title = decreaseLabel;
    increaseButton.type = "button";
    increaseButton.textContent = "+";
    increaseButton.setAttribute("aria-label", increaseLabel);
    increaseButton.title = increaseLabel;
    output.setAttribute("aria-live", "polite");
    stepper.append(decreaseButton, output, increaseButton);
    adjustment.append(label, stepper);
    return adjustment;
  }

  private progressText(status: { total: number; completed: number }): string {
    return status.total > 0 ? `${status.completed}/${status.total}` : "";
  }

  private async runHideCurrentAction(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await this.options.onHideCurrent();
      this.hide();
    } catch {
      this.pageStatusRow.dataset.state = "error";
      this.pageStatus.textContent = message("floatingHideFailed");
      button.disabled = false;
    }
  }

  private async runHidePermanentlyAction(
    button: HTMLButtonElement,
  ): Promise<void> {
    button.disabled = true;
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "FLOATING_BUTTON_SET",
        surface: "all",
        enabled: false,
      });
      if (
        typeof response !== "object" ||
        response === null ||
        !("ok" in response) ||
        response.ok !== true
      ) {
        throw new Error("floating-hide-failed");
      }
      this.hide();
    } catch {
      this.pageStatusRow.dataset.state = "error";
      this.pageStatus.textContent = message("floatingHideFailed");
      button.disabled = false;
    }
  }

  private readonly handleLauncherClick = (event: MouseEvent): void => {
    if (this.suppressLauncherClick) {
      event.preventDefault();
      event.stopPropagation();
      this.suppressLauncherClick = false;
      return;
    }
    if (this.expanded) this.collapse(false);
    else this.expand();
  };

  private expand(): void {
    this.revealDockedControl();
    this.activateTab(this.resolveTaskTarget());
    this.expanded = true;
    this.panel.hidden = false;
    this.launcher.setAttribute("aria-expanded", "true");
    this.positionPanel();
    (this.pageTab.getAttribute("aria-selected") === "true"
      ? this.pageTab
      : this.videoTab.getAttribute("aria-selected") === "true"
        ? this.videoTab
        : this.imageTab
    ).focus();
  }

  private collapse(restoreFocus: boolean): void {
    const activeElement = this.host.shadowRoot?.activeElement;
    const panelOwnedFocus =
      activeElement instanceof Node && this.panel.contains(activeElement);
    this.expanded = false;
    this.panel.hidden = true;
    this.panelMenu.open = false;
    this.launcher.setAttribute("aria-expanded", "false");
    if (
      (restoreFocus || panelOwnedFocus) &&
      this.host.dataset.hidden !== "true"
    ) {
      this.launcher.focus({ preventScroll: true });
    }
    this.scheduleEdgeHide();
  }

  private positionPanel(): void {
    if (!this.expanded) return;
    const viewportWidth = contentViewportWidth();
    const viewportHeight = contentViewportHeight();
    const launcherRect = this.launcher.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    const panelWidth =
      panelRect.width ||
      Math.max(0, Math.min(360, viewportWidth - VIEWPORT_PADDING * 2));
    const maximumPanelLeft = Math.max(
      VIEWPORT_PADDING,
      viewportWidth - VIEWPORT_PADDING - panelWidth,
    );
    const panelLeft = Math.min(
      Math.max(launcherRect.right - panelWidth, VIEWPORT_PADDING),
      maximumPanelLeft,
    );
    this.panel.style.left = `${Math.round(panelLeft - launcherRect.left)}px`;
    this.panel.style.right = "auto";
    const spaceAbove = launcherRect.top - VIEWPORT_PADDING - 8;
    const spaceBelow =
      viewportHeight - launcherRect.bottom - VIEWPORT_PADDING - 8;
    const openDown = spaceBelow >= panelRect.height || spaceBelow >= spaceAbove;
    this.panel.style.top = openDown ? `${LAUNCHER_SIZE + 8}px` : "auto";
    this.panel.style.bottom = openDown ? "auto" : `${LAUNCHER_SIZE + 8}px`;
    this.panel.style.maxHeight = `${Math.max(
      44,
      Math.floor(openDown ? spaceBelow : spaceAbove),
    )}px`;
  }

  private activateTab(
    tab: "page" | "video" | "image",
    moveFocus = false,
  ): void {
    this.preferredTaskTarget = tab;
    const pageActive = tab === "page";
    const videoActive = tab === "video";
    const imageActive = tab === "image";
    this.pageTab.setAttribute("aria-selected", String(pageActive));
    this.pageTab.tabIndex = pageActive ? 0 : -1;
    this.pagePanel.hidden = !pageActive;
    this.videoTab.setAttribute("aria-selected", String(videoActive));
    this.videoTab.tabIndex = videoActive ? 0 : -1;
    this.videoPanel.hidden = !videoActive;
    this.imageTab.setAttribute("aria-selected", String(imageActive));
    this.imageTab.tabIndex = imageActive ? 0 : -1;
    this.imagePanel.hidden = !imageActive;
    if (moveFocus) {
      (pageActive
        ? this.pageTab
        : videoActive
          ? this.videoTab
          : this.imageTab
      ).focus();
    }
    this.syncQuickActions();
    this.positionPanel();
  }

  private readonly handleTabKeydown = (event: KeyboardEvent): void => {
    const tabs = ["page", "video", "image"] as const;
    const active =
      this.pageTab.getAttribute("aria-selected") === "true"
        ? 0
        : this.videoTab.getAttribute("aria-selected") === "true"
          ? 1
          : 2;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      this.activateTab(
        tabs[(active + delta + tabs.length) % tabs.length]!,
        true,
      );
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      this.activateTab("page", true);
    } else if (event.key === "End") {
      event.preventDefault();
      this.activateTab("image", true);
    }
  };

  private pageTaskActive(): boolean {
    return (
      this.pageBusy ||
      this.currentPageStatus.state === "scanning" ||
      this.currentPageStatus.state === "translating"
    );
  }

  private subtitleTaskActive(): boolean {
    return (
      this.subtitleTaskBusy ||
      this.subtitleCancelBusy ||
      this.currentSubtitleStatus.state === "translating"
    );
  }

  private ocrTaskActive(): boolean {
    return [
      "selecting",
      "initializing",
      "capturing",
      "recognizing",
      "active",
    ].includes(this.currentOcrStatus.state);
  }

  private videoTaskActive(): boolean {
    return this.subtitleTaskActive() || this.ocrTaskActive();
  }

  private imageTaskActive(): boolean {
    return ["capturing", "recognizing", "translating"].includes(
      this.currentImageStatus.state,
    );
  }

  private resolveTaskTarget(): FloatingTaskTarget {
    const pageActive = this.pageTaskActive();
    const videoActive = this.videoTaskActive();
    const imageActive = this.imageTaskActive();
    const active = [
      ...(pageActive ? (["page"] as const) : []),
      ...(videoActive ? (["video"] as const) : []),
      ...(imageActive ? (["image"] as const) : []),
    ];
    if (active.length === 1) return active[0]!;
    return this.preferredTaskTarget;
  }

  private runQuickTranslateAction(): void {
    const target = this.resolveTaskTarget();
    this.preferredTaskTarget = target;
    if (target === "video") this.subtitleStartButton.click();
    else if (target === "image") this.imageStartButton.click();
    else this.translateButton.click();
  }

  private runQuickStopAction(): void {
    const target = this.resolveTaskTarget();
    this.preferredTaskTarget = target;
    if (target === "page") {
      this.restoreButton.click();
    } else if (target === "image") {
      this.imageCancelButton.click();
    } else if (this.ocrTaskActive()) {
      this.ocrStopButton.click();
    } else {
      this.subtitleCancelButton.click();
    }
  }

  private async runPageAction(
    action: () => Promise<void> | void,
  ): Promise<void> {
    if (this.pageBusy) return;
    this.preferredTaskTarget = "page";
    this.pageBusy = true;
    this.syncPageButtons();
    try {
      await action();
    } catch {
      this.pageStatusRow.dataset.state = "error";
      this.pageStatus.textContent = message("pageActionFailed");
    } finally {
      this.pageBusy = false;
      this.syncPageButtons();
    }
  }

  private async changeAutoTranslate(): Promise<void> {
    if (this.siteAutoTranslateBusy) return;
    const enabled = this.autoTranslate.checked;
    this.siteAutoTranslateBusy = true;
    this.setPageSettingsDisabled(true);
    try {
      await this.options.onAutoTranslateChange(enabled);
    } catch {
      this.autoTranslate.checked = !enabled;
      this.pageStatusRow.dataset.state = "error";
      this.pageStatus.textContent = message("settingsSaveFailed");
    } finally {
      this.siteAutoTranslateBusy = false;
      this.renderPageSettings();
    }
  }

  private async changePageSettings(): Promise<void> {
    if (this.pendingPageSettings) return;
    const sourceLanguage = this.pageSourceLanguageSelect.value;
    const targetLanguage = this.pageTargetLanguageSelect.value;
    const displayMode = this.pageDisplayModeSelect.value;
    const selectionTranslationEnabled =
      this.selectionTranslationEnabled.checked;
    const selectionTranslationMode = this.selectionTranslationModeSelect.value;
    if (
      !SOURCE_LANGUAGES.some((language) => language.code === sourceLanguage) ||
      !TARGET_LANGUAGES.some((language) => language.code === targetLanguage) ||
      (displayMode !== "translated" && displayMode !== "bilingual") ||
      (selectionTranslationMode !== "fast" && selectionTranslationMode !== "ai")
    ) {
      return;
    }
    const patch: PageSettingsPatch = {
      sourceLanguage,
      targetLanguage,
      displayMode,
      selectionTranslationEnabled,
      selectionTranslationMode,
    };
    const pending = this.beginPageSettingsChange(patch);
    if (!pending) return;
    let succeeded = false;
    try {
      await this.options.onPageSettingsChange(patch);
      succeeded = true;
    } catch {
      this.pageStatusRow.dataset.state = "error";
      this.pageStatus.textContent = message("settingsSaveFailed");
    } finally {
      this.finishPageSettingsChange(pending, succeeded);
    }
  }

  private async changePageMode(): Promise<void> {
    if (this.pendingPageSettings) return;
    const mode = this.pageModeSelect.value;
    if (mode !== "fast" && mode !== "ai") return;
    const pending = this.beginPageSettingsChange({ mode });
    if (!pending) return;
    let succeeded = false;
    try {
      await this.options.onPageModeChange(mode);
      succeeded = true;
    } catch {
      this.pageStatusRow.dataset.state = "error";
      this.pageStatus.textContent = message("settingsSaveFailed");
    } finally {
      this.finishPageSettingsChange(pending, succeeded);
    }
  }

  private async changePageResponseMode(): Promise<void> {
    if (this.pendingPageSettings || this.settings.page.mode !== "ai") return;
    const responseMode = this.pageResponseModeSelect.value;
    if (responseMode !== "stream" && responseMode !== "batch") return;
    const pending = this.beginPageSettingsChange({
      aiResponseMode: responseMode,
    });
    if (!pending) return;
    let succeeded = false;
    try {
      await this.options.onPageResponseModeChange(responseMode);
      succeeded = true;
    } catch {
      this.pageStatusRow.dataset.state = "error";
      this.pageStatus.textContent = message("settingsSaveFailed");
    } finally {
      this.finishPageSettingsChange(pending, succeeded);
    }
  }

  private setPageSettingsDisabled(disabled: boolean): void {
    this.pageSourceLanguageSelect.disabled = disabled;
    this.pageTargetLanguageSelect.disabled = disabled;
    this.pageModeSelect.disabled = disabled;
    this.pageResponseModeSelect.disabled =
      disabled || this.pageModeSelect.value !== "ai";
    this.pageDisplayModeSelect.disabled = disabled;
    this.autoTranslate.disabled = disabled || this.siteAutoTranslateBusy;
    this.selectionTranslationEnabled.disabled = disabled;
    this.selectionTranslationModeSelect.disabled = disabled;
  }

  private readonly changeSubtitleSettings = async (): Promise<void> => {
    if (this.pendingSubtitleSettings) return;
    const sourceLanguage = this.subtitleSourceLanguageSelect.value;
    const targetLanguage = this.subtitleTargetLanguageSelect.value;
    const mode = this.modeSelect.value;
    const aiResponseMode = this.subtitleResponseModeSelect.value;
    const displayMode = this.displaySelect.value;
    if (
      !SOURCE_LANGUAGES.some((language) => language.code === sourceLanguage) ||
      !TARGET_LANGUAGES.some((language) => language.code === targetLanguage) ||
      (mode !== "fast" && mode !== "ai") ||
      (aiResponseMode !== "stream" && aiResponseMode !== "batch") ||
      (displayMode !== "original" &&
        displayMode !== "translated" &&
        displayMode !== "bilingual")
    ) {
      return;
    }
    const patch: SubtitleSettingsPatch = {
      sourceLanguage,
      targetLanguage,
      mode,
      aiResponseMode,
      displayMode,
      hideNativeSubtitles: this.hideNativeCheckbox.checked,
      fontScale: this.settings.subtitles.fontScale,
      backgroundOpacity: this.settings.subtitles.backgroundOpacity,
    };
    const pending = this.beginSubtitleSettingsChange(patch);
    if (!pending) return;
    let succeeded = false;
    try {
      await this.options.onSubtitleSettingsChange(patch);
      succeeded = true;
    } catch {
      this.subtitleStatusRow.dataset.state = "error";
      this.subtitleStatus.textContent = message("settingsSaveFailed");
    } finally {
      this.finishSubtitleSettingsChange(pending, succeeded);
    }
  };

  private async changeSubtitleAppearance(
    field: "fontScale" | "backgroundOpacity",
    delta: number,
  ): Promise<void> {
    if (this.pendingSubtitleSettings) return;
    const current = this.settings.subtitles[field];
    const minimum = field === "fontScale" ? 0.75 : 0.3;
    const maximum = field === "fontScale" ? 1.8 : 0.95;
    const next = Math.min(
      maximum,
      Math.max(minimum, Math.round((current + delta) * 100) / 100),
    );
    if (next === current) return;
    const patch: SubtitleSettingsPatch = {
      sourceLanguage: this.settings.subtitles.sourceLanguage,
      targetLanguage: this.settings.subtitles.targetLanguage,
      mode: this.settings.subtitles.mode,
      aiResponseMode: this.settings.subtitles.aiResponseMode,
      displayMode: this.settings.subtitles.displayMode,
      hideNativeSubtitles: this.settings.subtitles.hideNativeSubtitles,
      fontScale:
        field === "fontScale" ? next : this.settings.subtitles.fontScale,
      backgroundOpacity:
        field === "backgroundOpacity"
          ? next
          : this.settings.subtitles.backgroundOpacity,
    };
    const pending = this.beginSubtitleSettingsChange(patch);
    if (!pending) return;
    let succeeded = false;
    try {
      await this.options.onSubtitleSettingsChange(patch);
      succeeded = true;
    } catch {
      this.subtitleStatusRow.dataset.state = "error";
      this.subtitleStatus.textContent = message("settingsSaveFailed");
    } finally {
      this.finishSubtitleSettingsChange(pending, succeeded);
    }
  }

  private setSubtitleSettingsDisabled(disabled: boolean): void {
    this.subtitleSourceLanguageSelect.disabled = disabled;
    this.subtitleTargetLanguageSelect.disabled = disabled;
    this.modeSelect.disabled = disabled;
    this.subtitleResponseModeSelect.disabled =
      disabled || this.modeSelect.value !== "ai";
    this.displaySelect.disabled = disabled;
    this.hideNativeCheckbox.disabled = disabled;
    this.subtitleFontDecreaseButton.disabled = disabled;
    this.subtitleFontIncreaseButton.disabled = disabled;
    this.subtitleOpacityDecreaseButton.disabled = disabled;
    this.subtitleOpacityIncreaseButton.disabled = disabled;
  }

  private async changeOcrEnabled(): Promise<void> {
    const enabled = this.ocrEnabledCheckbox.checked;
    const pending = this.beginOcrSettingsChange({ enabled });
    if (!pending) return;
    let succeeded = false;
    try {
      await this.options.onOcrEnabledChange?.(enabled);
      succeeded = true;
    } catch {
      this.updateOcrStatus({
        state: "error",
        recognized: 0,
        message: message(
          enabled ? "ocrCapturePermissionRequired" : "settingsSaveFailed",
        ),
      });
    } finally {
      this.finishOcrSettingsChange(pending, succeeded);
      if (succeeded) {
        this.updateOcrStatus({
          state: this.settings.ocr.enabled ? "idle" : "disabled",
          recognized: 0,
        });
      }
    }
  }

  private async runSubtitleTaskAction(
    action: () => Promise<void> | void,
  ): Promise<void> {
    if (this.subtitleTaskBusy) return;
    this.preferredTaskTarget = "video";
    this.subtitleTaskBusy = true;
    this.syncSubtitleTaskButtons();
    try {
      await action();
    } catch {
      this.subtitleStatusRow.dataset.state = "error";
      this.subtitleStatus.textContent = message("subtitleTaskActionFailed");
    } finally {
      this.subtitleTaskBusy = false;
      this.syncSubtitleTaskButtons();
    }
  }

  private async runSubtitleCancelAction(): Promise<void> {
    if (this.subtitleCancelBusy) return;
    this.preferredTaskTarget = "video";
    this.subtitleCancelBusy = true;
    this.syncSubtitleTaskButtons();
    try {
      await this.options.onSubtitleCancel();
    } catch {
      this.subtitleStatusRow.dataset.state = "error";
      this.subtitleStatus.textContent = message("subtitleTaskActionFailed");
    } finally {
      this.subtitleCancelBusy = false;
      this.syncSubtitleTaskButtons();
    }
  }

  private syncSubtitleTaskButtons(): void {
    const status = this.currentSubtitleStatus;
    const retry = status.failed > 0 && status.state !== "cancelled";
    this.subtitleStartButton.textContent = message(
      retry ? "retryFailedSubtitles" : "startSubtitleTranslation",
    );
    this.subtitleStartButton.disabled =
      this.subtitleTaskBusy ||
      status.state === "translating" ||
      status.state === "ready";
    this.subtitleCancelButton.disabled =
      this.subtitleCancelBusy ||
      status.total === 0 ||
      status.state === "cancelled" ||
      status.state === "unavailable" ||
      status.state === "waiting";
    this.syncQuickActions();
  }

  private syncOcrButtons(): void {
    const enabled = this.settings.ocr.enabled;
    const running = [
      "selecting",
      "initializing",
      "capturing",
      "recognizing",
      "active",
    ].includes(this.currentOcrStatus.state);
    this.ocrEnabledCheckbox.disabled = this.pendingOcrSettings !== undefined;
    this.ocrStartButton.disabled = !enabled || running;
    this.ocrStopButton.disabled = !running;
  }

  private syncImageButtons(): void {
    const running = this.imageTaskActive();
    this.imageStartButton.disabled =
      !this.settings.imageTranslation.enabled ||
      running ||
      !this.currentImageStatus.hasCurrentImage;
    this.imageCancelButton.disabled =
      !this.currentImageStatus.hasCurrentImage ||
      ["disabled", "idle", "available"].includes(this.currentImageStatus.state);
    this.imageCancelButton.textContent = message(
      running ? "imageCancelAction" : "imageClearAction",
    );
  }

  private syncQuickActions(): void {
    const target = this.resolveTaskTarget();
    const targetLabel = message(
      target === "video"
        ? "videoTranslationTab"
        : target === "image"
          ? "imageTranslationTab"
          : "pageTranslationTab",
    );
    this.host.dataset.taskTarget = target;
    this.quickActions.setAttribute(
      "aria-label",
      `${message("floatingControl")} · ${targetLabel}`,
    );
    this.launcher.title = `${message("floatingControl")} · ${targetLabel}`;

    let translateLabel: string;
    let stopLabel: string;
    if (target === "page") {
      const translating =
        this.currentPageStatus.state === "scanning" ||
        this.currentPageStatus.state === "translating";
      translateLabel = message("widgetTranslate");
      stopLabel = message("stopPageTranslation");
      this.quickTranslateButton.disabled = this.pageBusy || translating;
      this.quickStopButton.disabled = this.pageBusy || !translating;
    } else if (target === "image") {
      translateLabel = message("imageTranslateCurrent");
      stopLabel = message(
        this.imageTaskActive() ? "imageCancelAction" : "imageClearAction",
      );
      this.quickTranslateButton.disabled = this.imageStartButton.disabled;
      this.quickStopButton.disabled = this.imageCancelButton.disabled;
    } else if (this.ocrTaskActive()) {
      translateLabel = message("ocrStart");
      stopLabel = message("ocrStop");
      this.quickTranslateButton.disabled = true;
      this.quickStopButton.disabled = this.ocrStopButton.disabled;
    } else {
      const retry =
        this.currentSubtitleStatus.failed > 0 &&
        this.currentSubtitleStatus.state !== "cancelled";
      translateLabel = message(
        retry ? "retryFailedSubtitles" : "startSubtitleTranslation",
      );
      stopLabel = message("cancelSubtitleTranslation");
      this.quickTranslateButton.disabled = this.subtitleStartButton.disabled;
      this.quickStopButton.disabled = this.subtitleCancelButton.disabled;
    }

    this.quickTranslateButton.setAttribute("aria-label", translateLabel);
    this.quickTranslateButton.title = translateLabel;
    this.quickStopButton.setAttribute("aria-label", stopLabel);
    this.quickStopButton.title = stopLabel;
    this.syncLauncherLoading();
  }

  private syncLauncherLoading(): void {
    const targetLabel = message(
      this.resolveTaskTarget() === "video"
        ? "videoTranslationTab"
        : this.resolveTaskTarget() === "image"
          ? "imageTranslationTab"
          : "pageTranslationTab",
    );
    const launcherLabel = `${message("floatingControl")} · ${targetLabel}`;
    const ocrLoading = ["initializing", "recognizing"].includes(
      this.currentOcrStatus.state,
    );
    const fullSubtitleLoading =
      this.currentSubtitleStatus.state === "translating" &&
      this.currentSubtitleStatus.completeness === "full";
    const loading =
      this.currentPageStatus.state === "scanning" ||
      this.currentPageStatus.state === "translating" ||
      fullSubtitleLoading ||
      ocrLoading ||
      this.imageTaskActive();
    this.host.dataset.loading = String(loading);
    const progressCandidates: Array<{ completed: number; total: number }> = [];
    if (
      ["scanning", "translating"].includes(this.currentPageStatus.state) &&
      this.currentPageStatus.total > 0
    ) {
      progressCandidates.push(this.currentPageStatus);
    }
    if (this.imageTaskActive() && this.currentImageStatus.total > 0) {
      progressCandidates.push(this.currentImageStatus);
    }
    if (fullSubtitleLoading && this.currentSubtitleStatus.total > 0) {
      progressCandidates.push(this.currentSubtitleStatus);
    }
    if (
      this.currentOcrStatus.state === "initializing" &&
      this.currentOcrStatus.progress !== undefined
    ) {
      progressCandidates.push({
        completed: this.currentOcrStatus.progress,
        total: 1,
      });
    }
    const completed = progressCandidates.reduce(
      (sum, status) => sum + Math.min(status.completed, status.total),
      0,
    );
    const total = progressCandidates.reduce(
      (sum, status) => sum + status.total,
      0,
    );
    if (loading && total > 0) {
      const progress = Math.min(1, Math.max(0, completed / total));
      this.host.dataset.progressMode = "determinate";
      this.host.style.setProperty(
        "--nt-progress-angle",
        `${progress * 360}deg`,
      );
      this.launcher.setAttribute(
        "aria-label",
        `${launcherLabel} ${message(
          "percentageValue",
          String(Math.round(progress * 100)),
        )}`,
      );
    } else {
      this.host.dataset.progressMode = "indeterminate";
      this.host.style.removeProperty("--nt-progress-angle");
      this.launcher.setAttribute("aria-label", launcherLabel);
    }
    this.launcher.setAttribute("aria-busy", String(loading));
  }

  private syncPageButtons(): void {
    const translating =
      this.currentPageStatus.state === "scanning" ||
      this.currentPageStatus.state === "translating";
    this.translateButton.disabled = this.pageBusy || translating;
    this.restoreButton.textContent = message(
      translating ? "cancelPageTranslation" : "widgetRestore",
    );
    this.restoreButton.disabled =
      this.pageBusy ||
      (!translating &&
        this.currentPageStatus.state !== "translated" &&
        this.currentPageStatus.state !== "partial");
    this.syncQuickActions();
  }

  private readonly startDrag = (event: PointerEvent): void => {
    if (event.button !== 0 || event.isPrimary === false) return;
    this.positionGeneration += 1;
    const dockedEdge = this.currentDockedEdge();
    const edgeHidden = this.host.dataset.edgeHidden;
    const rect = this.host.getBoundingClientRect();
    const storedLeft = Number.parseFloat(this.host.style.left);
    const storedTop = Number.parseFloat(this.host.style.top);
    this.dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // A docked control is translated partly outside the viewport. Keep its
      // stable layout position without revealing it on pointerdown: moving the
      // hit target before pointerup cancels an ordinary click on the wake tab.
      hostLeft: Number.isFinite(storedLeft) ? storedLeft : rect.left,
      hostTop: Number.isFinite(storedTop) ? storedTop : rect.top,
      moved: false,
      styleLeft: this.host.style.left,
      styleTop: this.host.style.top,
      styleRight: this.host.style.right,
      styleBottom: this.host.style.bottom,
      ...(dockedEdge ? { dockedEdge } : {}),
      ...(edgeHidden ? { edgeHidden } : {}),
    };
    this.addDragFallbackListeners();
    try {
      this.launcher.setPointerCapture?.(event.pointerId);
    } catch {
      // Window listeners keep dragging controllable across players/iframes.
    }
  };

  private readonly moveLauncherWithKeyboard = (event: KeyboardEvent): void => {
    const direction =
      event.key === "ArrowLeft"
        ? { x: -1, y: 0 }
        : event.key === "ArrowRight"
          ? { x: 1, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -1 }
            : event.key === "ArrowDown"
              ? { x: 0, y: 1 }
              : null;
    if (!direction) return;

    event.preventDefault();
    this.positionGeneration += 1;
    this.revealDockedControl();
    const rect = this.host.getBoundingClientRect();
    const storedLeft = Number.parseFloat(this.host.style.left);
    const storedTop = Number.parseFloat(this.host.style.top);
    const step = event.shiftKey ? KEYBOARD_MOVE_LARGE_STEP : KEYBOARD_MOVE_STEP;
    delete this.host.dataset.dockedEdge;
    this.applyPosition(
      (Number.isFinite(storedLeft) ? storedLeft : rect.left) +
        direction.x * step,
      (Number.isFinite(storedTop) ? storedTop : rect.top) + direction.y * step,
    );
    const appliedLeft = Number.parseFloat(this.host.style.left);
    const appliedTop = Number.parseFloat(this.host.style.top);
    const rightEdge = Math.max(
      VIEWPORT_PADDING,
      contentViewportWidth() - LAUNCHER_SIZE - VIEWPORT_PADDING,
    );
    const bottomEdge = Math.max(
      VIEWPORT_PADDING,
      contentViewportHeight() - LAUNCHER_SIZE - VIEWPORT_PADDING,
    );
    if (
      appliedLeft === VIEWPORT_PADDING ||
      appliedLeft === rightEdge ||
      appliedTop === VIEWPORT_PADDING ||
      appliedTop === bottomEdge
    ) {
      this.dockToNearbyEdge(false);
    }
    this.savePosition();
    this.positionPanel();
  };

  private readonly moveDrag = (event: PointerEvent): void => {
    const state = this.dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    if (!state.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
    if (!state.moved) this.revealDockedControl();
    state.moved = true;
    event.preventDefault();
    this.applyPosition(state.hostLeft + deltaX, state.hostTop + deltaY);
    this.host.dataset.dragging = "true";
    this.positionPanel();
  };

  private readonly endDrag = (event: PointerEvent): void => {
    const state = this.dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    this.finishActiveDrag("commit");
  };

  private readonly cancelDrag = (event: PointerEvent): void => {
    const state = this.dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    this.finishActiveDrag("restore");
  };

  private readonly handleLostPointerCapture = (event: PointerEvent): void => {
    const state = this.dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    this.finishActiveDrag("commit");
  };

  private releaseDragPointer(pointerId: number): void {
    try {
      if (this.launcher.hasPointerCapture?.(pointerId)) {
        this.launcher.releasePointerCapture(pointerId);
      }
    } catch {
      // The browser may already have released capture at an iframe boundary.
    }
  }

  private addDragFallbackListeners(): void {
    window.addEventListener("pointermove", this.moveDrag);
    window.addEventListener("pointerup", this.endDrag);
    window.addEventListener("pointercancel", this.cancelDrag);
    window.addEventListener("pointerout", this.handleDragPointerOut);
    window.addEventListener("blur", this.finishInterruptedDrag);
  }

  private removeDragFallbackListeners(): void {
    window.removeEventListener("pointermove", this.moveDrag);
    window.removeEventListener("pointerup", this.endDrag);
    window.removeEventListener("pointercancel", this.cancelDrag);
    window.removeEventListener("pointerout", this.handleDragPointerOut);
    window.removeEventListener("blur", this.finishInterruptedDrag);
  }

  private readonly handleDragPointerOut = (event: PointerEvent): void => {
    const state = this.dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    if (
      event.relatedTarget !== null &&
      !(event.relatedTarget instanceof HTMLIFrameElement)
    ) {
      return;
    }
    this.finishActiveDrag("commit");
  };

  private readonly finishInterruptedDrag = (): void => {
    this.finishActiveDrag("commit");
  };

  private finishActiveDrag(outcome: "commit" | "restore"): void {
    const state = this.dragState;
    if (!state) return;
    // Clear first because releasePointerCapture can synchronously dispatch a
    // lostpointercapture event in some browser/player combinations.
    this.dragState = undefined;
    this.releaseDragPointer(state.pointerId);
    this.removeDragFallbackListeners();
    delete this.host.dataset.dragging;
    if (!state.moved) return;
    if (outcome === "commit") {
      this.suppressLauncherClick = true;
      window.setTimeout(() => {
        this.suppressLauncherClick = false;
      }, 0);
      this.dockToNearbyEdge();
      this.savePosition();
      return;
    }
    this.host.style.left = state.styleLeft;
    this.host.style.top = state.styleTop;
    this.host.style.right = state.styleRight;
    this.host.style.bottom = state.styleBottom;
    if (state.dockedEdge) this.host.dataset.dockedEdge = state.dockedEdge;
    else delete this.host.dataset.dockedEdge;
    if (state.edgeHidden) this.host.dataset.edgeHidden = state.edgeHidden;
    else delete this.host.dataset.edgeHidden;
    this.positionPanel();
  }

  private applyPosition(left: number, top: number): void {
    const viewportWidth = contentViewportWidth();
    const viewportHeight = contentViewportHeight();
    const maximumLeft = Math.max(
      VIEWPORT_PADDING,
      viewportWidth - LAUNCHER_SIZE - VIEWPORT_PADDING,
    );
    const maximumTop = Math.max(
      VIEWPORT_PADDING,
      viewportHeight - LAUNCHER_SIZE - VIEWPORT_PADDING,
    );
    const clampedLeft = Math.min(maximumLeft, Math.max(VIEWPORT_PADDING, left));
    const clampedTop = Math.min(maximumTop, Math.max(VIEWPORT_PADDING, top));
    this.host.style.left = `${Math.round(clampedLeft)}px`;
    this.host.style.top = `${Math.round(clampedTop)}px`;
    this.host.style.right = "auto";
    this.host.style.bottom = "auto";
    this.host.dataset.quickActionSide =
      clampedLeft + LAUNCHER_SIZE / 2 < viewportWidth / 2 ? "right" : "left";
  }

  private readonly handleViewportResize = (): void => {
    const left = Number.parseFloat(this.host.style.left);
    const top = Number.parseFloat(this.host.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      const dockedEdge = this.currentDockedEdge();
      this.applyPosition(left, top);
      if (dockedEdge) this.alignToDockedEdge(dockedEdge);
      else this.dockToNearbyEdge(false);
      if (!this.fullscreenActive) this.savePosition();
    }
    this.positionPanel();
  };

  private currentDockedEdge(): DockedEdge | undefined {
    const edge = this.host.dataset.dockedEdge;
    return edge === "left" ||
      edge === "right" ||
      edge === "top" ||
      edge === "bottom"
      ? edge
      : undefined;
  }

  private alignToDockedEdge(edge: DockedEdge): void {
    const left = Number.parseFloat(this.host.style.left);
    const top = Number.parseFloat(this.host.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    const rightEdge = Math.max(
      VIEWPORT_PADDING,
      contentViewportWidth() - LAUNCHER_SIZE - VIEWPORT_PADDING,
    );
    const bottomEdge = Math.max(
      VIEWPORT_PADDING,
      contentViewportHeight() - LAUNCHER_SIZE - VIEWPORT_PADDING,
    );
    this.applyPosition(
      edge === "left" ? VIEWPORT_PADDING : edge === "right" ? rightEdge : left,
      edge === "top" ? VIEWPORT_PADDING : edge === "bottom" ? bottomEdge : top,
    );
    this.host.dataset.dockedEdge = edge;
  }

  private dockToNearbyEdge(collapsePanel = true): void {
    const left = Number.parseFloat(this.host.style.left);
    const top = Number.parseFloat(this.host.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    const viewportWidth = contentViewportWidth();
    const viewportHeight = contentViewportHeight();
    const rightEdge = Math.max(
      VIEWPORT_PADDING,
      viewportWidth - LAUNCHER_SIZE - VIEWPORT_PADDING,
    );
    const bottomEdge = Math.max(
      VIEWPORT_PADDING,
      viewportHeight - LAUNCHER_SIZE - VIEWPORT_PADDING,
    );
    const leftDistance = Math.abs(left - VIEWPORT_PADDING);
    const rightDistance = Math.abs(rightEdge - left);
    const topDistance = Math.abs(top - VIEWPORT_PADDING);
    const bottomDistance = Math.abs(bottomEdge - top);
    const distances = [
      ["left", leftDistance],
      ["right", rightDistance],
      ["top", topDistance],
      ["bottom", bottomDistance],
    ] as const;
    const nearest = [...distances].sort(
      (leftEntry, rightEntry) => leftEntry[1] - rightEntry[1],
    )[0];
    if (!nearest || nearest[1] > EDGE_DOCK_THRESHOLD) {
      delete this.host.dataset.dockedEdge;
      this.host.dataset.edgeHidden = "false";
      return;
    }
    const edge = nearest[0];
    this.alignToDockedEdge(edge);
    if (collapsePanel) {
      this.collapse(false);
      this.releaseNonKeyboardFocus();
      this.host.dataset.edgeHidden = "true";
    }
  }

  private releaseNonKeyboardFocus(): void {
    const active = this.host.shadowRoot?.activeElement;
    if (!(active instanceof HTMLElement)) return;
    try {
      if (active.matches(":focus-visible")) return;
    } catch {
      // Older selector engines may not expose :focus-visible to matches().
    }
    active.blur();
  }

  private readonly revealDockedControl = (): void => {
    if (this.edgeHideTimer !== undefined) {
      window.clearTimeout(this.edgeHideTimer);
      this.edgeHideTimer = undefined;
    }
    this.host.dataset.edgeHidden = "false";
  };

  private readonly scheduleEdgeHide = (): void => {
    if (!this.host.dataset.dockedEdge || this.expanded) return;
    if (this.edgeHideTimer !== undefined) {
      window.clearTimeout(this.edgeHideTimer);
    }
    this.edgeHideTimer = window.setTimeout(() => {
      this.edgeHideTimer = undefined;
      if (!this.expanded && this.host.dataset.dockedEdge) {
        this.releaseNonKeyboardFocus();
        this.host.dataset.edgeHidden = "true";
      }
    }, EDGE_HIDE_DELAY_MS);
  };

  private positionStorageKey(): string {
    return `norixortrans:unified-control:${location.origin}${location.pathname}`;
  }

  private normalizedPosition(): FloatingControlPosition | undefined {
    const left = Number.parseFloat(this.host.style.left);
    const top = Number.parseFloat(this.host.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return undefined;
    const viewportWidth = contentViewportWidth();
    const viewportHeight = contentViewportHeight();
    const horizontalRange = Math.max(
      0,
      viewportWidth - LAUNCHER_SIZE - VIEWPORT_PADDING * 2,
    );
    const verticalRange = Math.max(
      0,
      viewportHeight - LAUNCHER_SIZE - VIEWPORT_PADDING * 2,
    );
    return {
      x:
        horizontalRange === 0
          ? 0
          : Math.min(
              1,
              Math.max(0, (left - VIEWPORT_PADDING) / horizontalRange),
            ),
      y:
        verticalRange === 0
          ? 0
          : Math.min(1, Math.max(0, (top - VIEWPORT_PADDING) / verticalRange)),
    };
  }

  private applyNormalizedPosition(position: FloatingControlPosition): void {
    const viewportWidth = contentViewportWidth();
    const viewportHeight = contentViewportHeight();
    const horizontalRange = Math.max(
      0,
      viewportWidth - LAUNCHER_SIZE - VIEWPORT_PADDING * 2,
    );
    const verticalRange = Math.max(
      0,
      viewportHeight - LAUNCHER_SIZE - VIEWPORT_PADDING * 2,
    );
    this.applyPosition(
      VIEWPORT_PADDING + horizontalRange * position.x,
      VIEWPORT_PADDING + verticalRange * position.y,
    );
  }

  private async restorePersistedPosition(): Promise<void> {
    if (!this.options.loadPosition) return;
    const generation = this.positionGeneration;
    try {
      const position = await this.options.loadPosition();
      if (
        generation !== this.positionGeneration ||
        !position ||
        !Number.isFinite(position.x) ||
        position.x < 0 ||
        position.x > 1 ||
        !Number.isFinite(position.y) ||
        position.y < 0 ||
        position.y > 1
      ) {
        return;
      }
      this.applyNormalizedPosition(position);
      this.dockToNearbyEdge(false);
      if (this.host.dataset.dockedEdge) {
        if (this.expanded) {
          this.revealDockedControl();
          this.positionPanel();
        } else {
          this.host.dataset.edgeHidden = "true";
        }
      }
    } catch {
      // Persisted-position failures must not disable the current page controls.
    }
  }

  private restoreStoredPosition(): void {
    try {
      const stored = sessionStorage.getItem(this.positionStorageKey());
      if (!stored) return;
      const value: unknown = JSON.parse(stored);
      if (
        typeof value !== "object" ||
        value === null ||
        !("left" in value) ||
        !("top" in value) ||
        typeof value.left !== "number" ||
        !Number.isFinite(value.left) ||
        typeof value.top !== "number" ||
        !Number.isFinite(value.top)
      ) {
        return;
      }
      this.applyPosition(value.left, value.top);
      this.dockToNearbyEdge(false);
      if (this.host.dataset.dockedEdge) {
        this.host.dataset.edgeHidden = "true";
      }
    } catch {
      // Restricted pages may reject sessionStorage; controls remain usable without restoration.
    }
  }

  private savePosition(): void {
    const normalized = this.normalizedPosition();
    try {
      sessionStorage.setItem(
        this.positionStorageKey(),
        JSON.stringify({
          left: Number.parseFloat(this.host.style.left),
          top: Number.parseFloat(this.host.style.top),
        }),
      );
    } catch {
      // Position persistence is optional; storage failures must not break this session.
    }
    if (normalized && this.options.onPositionChange) {
      void Promise.resolve(this.options.onPositionChange(normalized)).catch(
        () => undefined,
      );
    }
  }

  private readonly handleOutsidePointerDown = (event: PointerEvent): void => {
    const path = event.composedPath();
    if (this.panelMenu.open && !path.includes(this.panelMenu)) {
      this.panelMenu.open = false;
    }
    if (!this.expanded) return;
    if (!path.includes(this.host)) this.collapse(false);
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (this.panelMenu.open) {
      event.preventDefault();
      this.panelMenu.open = false;
      this.panelMenu.querySelector<HTMLElement>("summary")?.focus();
      return;
    }
    const activeElement = this.host.shadowRoot?.activeElement;
    const disclosures = [
      this.pageDiagnostic,
      this.subtitleDiagnostic,
      this.ocrDiagnostic,
      this.ocrDetails,
    ];
    const openDisclosure =
      disclosures.find(
        (disclosure) =>
          disclosure.open &&
          !disclosure.hidden &&
          activeElement instanceof Node &&
          disclosure.contains(activeElement),
      ) ??
      disclosures.find((disclosure) => disclosure.open && !disclosure.hidden);
    if (openDisclosure) {
      event.preventDefault();
      openDisclosure.open = false;
      openDisclosure.querySelector<HTMLElement>("summary")?.focus();
      return;
    }
    if (!this.expanded) return;
    event.preventDefault();
    this.collapse(true);
  };

  private readonly handleFullscreenChange = (): void => {
    const fullscreen = document.fullscreenElement;
    const portal = this.fullscreenPortal as HTMLElement & {
      hidePopover?: () => void;
      showPopover?: () => void;
    };
    this.host.dataset.fullscreenHidden = "false";
    if (fullscreen instanceof HTMLElement) {
      if (!this.fullscreenActive) {
        this.fullscreenDockedEdge = this.currentDockedEdge();
        this.fullscreenPositionSnapshot = {
          left: this.host.style.left,
          top: this.host.style.top,
          right: this.host.style.right,
          bottom: this.host.style.bottom,
          ...(this.fullscreenDockedEdge
            ? { dockedEdge: this.fullscreenDockedEdge }
            : {}),
        };
        this.fullscreenPositionGeneration = this.positionGeneration;
        this.restoreEdgeHiddenAfterFullscreen =
          this.fullscreenDockedEdge !== undefined &&
          this.host.dataset.edgeHidden === "true";
      }
      this.fullscreenActive = true;
      this.collapse(false);
      this.revealDockedControl();
      if (typeof portal.showPopover === "function") {
        if (!portal.isConnected) document.documentElement.append(portal);
        if (this.host.parentElement !== portal) portal.append(this.host);
        try {
          portal.showPopover();
        } catch {
          // Repeated fullscreen notifications can arrive while already open.
        }
      } else if (this.host.parentElement !== fullscreen) {
        fullscreen.append(this.host);
      }
    } else {
      const restorePreFullscreenDock =
        this.fullscreenActive &&
        this.fullscreenPositionGeneration === this.positionGeneration;
      const positionSnapshot = restorePreFullscreenDock
        ? this.fullscreenPositionSnapshot
        : undefined;
      const dockedEdge = restorePreFullscreenDock
        ? this.fullscreenDockedEdge
        : this.currentDockedEdge();
      const restoreEdgeHidden =
        restorePreFullscreenDock && this.restoreEdgeHiddenAfterFullscreen;
      this.fullscreenActive = false;
      this.fullscreenDockedEdge = undefined;
      this.fullscreenPositionSnapshot = undefined;
      this.restoreEdgeHiddenAfterFullscreen = false;
      try {
        portal.hidePopover?.();
      } catch {
        // Ignore a portal that was already closed by the browser.
      }
      if (this.host.parentElement !== document.documentElement) {
        document.documentElement.append(this.host);
      }
      portal.remove();
      if (positionSnapshot) {
        this.host.style.left = positionSnapshot.left;
        this.host.style.top = positionSnapshot.top;
        this.host.style.right = positionSnapshot.right;
        this.host.style.bottom = positionSnapshot.bottom;
        if (positionSnapshot.dockedEdge) {
          this.host.dataset.dockedEdge = positionSnapshot.dockedEdge;
        } else {
          delete this.host.dataset.dockedEdge;
        }
      } else if (dockedEdge) {
        this.host.dataset.dockedEdge = dockedEdge;
      }
      this.handleViewportResize();
      if (restoreEdgeHidden && this.currentDockedEdge()) {
        this.releaseNonKeyboardFocus();
        this.host.dataset.edgeHidden = "true";
      }
      return;
    }
    this.handleViewportResize();
  };
}
