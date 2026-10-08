import type {
  ContentSettings,
  FastProviderId,
  ImageTranslationSettings,
  OcrSettings,
  PageSettings,
  SubtitleSettings,
} from "@/src/shared/settings";

/** Page fields the floating control saves through `PAGE_QUICK_SETTINGS_SET`. */
export type PageSettingsPatch = Pick<
  PageSettings,
  | "sourceLanguage"
  | "targetLanguage"
  | "displayMode"
  | "selectionTranslationEnabled"
  | "selectionTranslationMode"
>;

/** Subtitle fields saved through `SUBTITLE_QUICK_SETTINGS_SET`. */
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
export type OcrSettingsPatch = OcrSettings;

/** Normalized (0..1) launcher position persisted by the background. */
export interface FloatingControlPosition {
  x: number;
  y: number;
}

/**
 * Host callbacks shared by every part of the floating control. The content
 * entry implements them with background messages; each callback rejects when
 * the request did not complete so the control can show a failure notice.
 */
export interface FloatingControlCallbacks {
  settings: ContentSettings;
  onPageTranslate(): Promise<void> | void;
  /** Re-queues only failed blocks; falls back to `onPageTranslate` when absent. */
  onPageRetryFailed?(): Promise<void> | void;
  /** Stops in-flight work but keeps translated blocks; falls back to restore. */
  onPageCancel?(): Promise<void> | void;
  onPageRestore(): Promise<void> | void;
  onAutoTranslateChange(enabled: boolean): Promise<void> | void;
  onPageSettingsChange(
    settings: PageSettingsPatch,
    fastProvider?: FastProviderId,
  ): Promise<void> | void;
  onPageModeChange(
    mode: "fast" | "ai",
    fastProvider?: FastProviderId,
  ): Promise<void> | void;
  onPageResponseModeChange(mode: "stream" | "batch"): Promise<void> | void;
  onSubtitleSettingsChange(
    settings: SubtitleSettingsPatch,
    fastProvider?: FastProviderId,
  ): Promise<void> | void;
  onSubtitleStart(): Promise<void> | void;
  onSubtitleCancel(): Promise<void> | void;
  onCreateProfile(): Promise<void> | void;
  onOcrSettingsChange?(settings: OcrSettingsPatch): Promise<void> | void;
  onOcrEnabledChange?(enabled: boolean): Promise<void> | void;
  onOcrStart?(): Promise<void> | void;
  onOcrStop?(): Promise<void> | void;
  onImageSettingsChange?(
    settings: ImageSettingsPatch,
    fastProvider?: FastProviderId,
  ): Promise<void> | void;
  onImageStart?(): Promise<void> | void;
  onImageCancelOrClear?(): Promise<void> | void;
  loadPosition?(): Promise<FloatingControlPosition | undefined>;
  onPositionChange?(position: FloatingControlPosition): Promise<void> | void;
  onHideCurrent(): Promise<void> | void;
}
