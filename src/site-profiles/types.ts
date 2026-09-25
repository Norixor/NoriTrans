import type {
  DisplayMode,
  FastProviderId,
  SubtitleCustomPosition,
  SubtitleDisplayMode,
  SubtitlePosition,
} from "@/src/shared/settings";
import type {
  TranslationMode,
  TranslationResponseMode,
} from "@/src/translation/types";

export interface SiteSurfaceTranslationOverride {
  sourceLanguage: string;
  targetLanguage: string;
  mode: TranslationMode;
  fastProvider: FastProviderId;
  /** Empty inherits the global AI model. */
  modelOverride: string;
}

export interface SitePageTranslationOverride extends SiteSurfaceTranslationOverride {
  aiResponseMode?: TranslationResponseMode;
  displayMode?: DisplayMode;
  autoTranslate?: boolean;
  floatingButtonEnabled?: boolean;
}

export interface SiteSelectionTranslationOverride extends SiteSurfaceTranslationOverride {
  enabled?: boolean;
  aiResponseMode?: TranslationResponseMode;
  displayMode?: DisplayMode;
}

export interface SiteSubtitleTranslationOverride extends SiteSurfaceTranslationOverride {
  enabled?: boolean;
  floatingButtonEnabled?: boolean;
  aiResponseMode?: TranslationResponseMode;
  displayMode?: SubtitleDisplayMode;
  hideNativeSubtitles?: boolean;
  position?: SubtitlePosition;
  customPosition?: SubtitleCustomPosition;
  fontScale?: number;
  backgroundOpacity?: number;
}

export interface SiteTranslationProfile {
  id: string;
  version: 1;
  name: string;
  match: {
    hostnameSuffixes: string[];
    urlRules?: Array<{
      hostnameSuffixes: string[];
      pathnamePrefixes: string[];
    }>;
  };
  overrides: {
    page?: SitePageTranslationOverride;
    selection?: SiteSelectionTranslationOverride;
    subtitles?: SiteSubtitleTranslationOverride;
  };
}
