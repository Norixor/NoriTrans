import type { ContentSettings } from "@/src/shared/settings";
import type { SiteTranslationProfile } from "@/src/site-profiles/types";

type SiteLocation = Pick<Location, "hostname"> &
  Partial<Pick<Location, "pathname">>;

function hostnameSuffixScore(hostname: string, suffix: string): number {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return normalized === suffix || normalized.endsWith(`.${suffix}`)
    ? suffix.length
    : -1;
}

function matchScore(
  profile: SiteTranslationProfile,
  locationValue: SiteLocation,
): number {
  const pathname = locationValue.pathname || "/";
  if (profile.match.urlRules?.length) {
    return profile.match.urlRules.reduce((best, rule) => {
      const hostScore = Math.max(
        -1,
        ...rule.hostnameSuffixes.map((suffix) =>
          hostnameSuffixScore(locationValue.hostname, suffix),
        ),
      );
      if (hostScore < 0) return best;
      const pathScore = Math.max(
        -1,
        ...rule.pathnamePrefixes.map((prefix) =>
          prefix === "/" || pathname.startsWith(prefix) ? prefix.length : -1,
        ),
      );
      return pathScore < 0
        ? best
        : Math.max(best, hostScore * 10_000 + pathScore);
    }, -1);
  }
  return Math.max(
    -1,
    ...profile.match.hostnameSuffixes.map((suffix) =>
      hostnameSuffixScore(locationValue.hostname, suffix),
    ),
  );
}

export function resolveSiteTranslationProfile(
  profiles: readonly SiteTranslationProfile[],
  locationValue: SiteLocation,
): SiteTranslationProfile | undefined {
  return profiles
    .map((profile) => ({ profile, score: matchScore(profile, locationValue) }))
    .filter(({ score }) => score >= 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.profile.id.localeCompare(right.profile.id),
    )[0]?.profile;
}

/** Merge one most-specific site profile onto a fresh global snapshot. */
export function applySiteProfileSettings(
  globalSettings: ContentSettings,
  profiles: readonly SiteTranslationProfile[],
  locationValue: SiteLocation,
): ContentSettings {
  const profile = resolveSiteTranslationProfile(profiles, locationValue);
  if (!profile) return globalSettings;
  const pageOverride = profile.overrides.page;
  const selectionOverride = profile.overrides.selection;
  const subtitleOverride = profile.overrides.subtitles;
  const pageSettings = { ...globalSettings.page };
  delete pageSettings.fastProviderOverride;
  delete pageSettings.modelOverride;
  delete pageSettings.selectionTranslationFastProviderOverride;
  const subtitleSettings = { ...globalSettings.subtitles };
  delete subtitleSettings.fastProviderOverride;
  delete subtitleSettings.modelOverride;
  return {
    ...globalSettings,
    activeSiteProfile: { id: profile.id, name: profile.name },
    page: {
      ...pageSettings,
      ...(pageOverride
        ? {
            sourceLanguage: pageOverride.sourceLanguage,
            targetLanguage: pageOverride.targetLanguage,
            mode: pageOverride.mode,
            fastProviderOverride: pageOverride.fastProvider,
            modelOverride: pageOverride.modelOverride,
            ...(pageOverride.aiResponseMode !== undefined
              ? { aiResponseMode: pageOverride.aiResponseMode }
              : {}),
            ...(pageOverride.displayMode !== undefined
              ? { displayMode: pageOverride.displayMode }
              : {}),
            ...(pageOverride.autoTranslate !== undefined
              ? {
                  autoTranslate: pageOverride.autoTranslate,
                  autoTranslateSitePatterns: [],
                  autoTranslateExcludedSitePatterns: [],
                }
              : {}),
            ...(pageOverride.floatingButtonEnabled !== undefined
              ? { floatingButtonEnabled: pageOverride.floatingButtonEnabled }
              : {}),
          }
        : {}),
      ...(selectionOverride
        ? {
            selectionTranslationSourceLanguage:
              selectionOverride.sourceLanguage,
            selectionTranslationTargetLanguage:
              selectionOverride.targetLanguage,
            selectionTranslationMode: selectionOverride.mode,
            selectionTranslationModelOverride: selectionOverride.modelOverride,
            selectionTranslationFastProviderOverride:
              selectionOverride.fastProvider,
            ...(selectionOverride.enabled !== undefined
              ? {
                  selectionTranslationEnabled: selectionOverride.enabled,
                }
              : {}),
            ...(selectionOverride.aiResponseMode !== undefined
              ? {
                  selectionTranslationAiResponseMode:
                    selectionOverride.aiResponseMode,
                }
              : {}),
            ...(selectionOverride.displayMode !== undefined
              ? {
                  selectionTranslationDisplayMode:
                    selectionOverride.displayMode,
                }
              : {}),
          }
        : {}),
    },
    subtitles: {
      ...subtitleSettings,
      ...(subtitleOverride
        ? {
            sourceLanguage: subtitleOverride.sourceLanguage,
            targetLanguage: subtitleOverride.targetLanguage,
            mode: subtitleOverride.mode,
            fastProviderOverride: subtitleOverride.fastProvider,
            modelOverride: subtitleOverride.modelOverride,
            ...(subtitleOverride.enabled !== undefined
              ? { enabled: subtitleOverride.enabled }
              : {}),
            ...(subtitleOverride.floatingButtonEnabled !== undefined
              ? {
                  floatingButtonEnabled: subtitleOverride.floatingButtonEnabled,
                }
              : {}),
            ...(subtitleOverride.aiResponseMode !== undefined
              ? { aiResponseMode: subtitleOverride.aiResponseMode }
              : {}),
            ...(subtitleOverride.displayMode !== undefined
              ? { displayMode: subtitleOverride.displayMode }
              : {}),
            ...(subtitleOverride.hideNativeSubtitles !== undefined
              ? {
                  hideNativeSubtitles: subtitleOverride.hideNativeSubtitles,
                }
              : {}),
            ...(subtitleOverride.position !== undefined
              ? { position: subtitleOverride.position }
              : {}),
            ...(subtitleOverride.customPosition !== undefined
              ? { customPosition: subtitleOverride.customPosition }
              : {}),
            ...(subtitleOverride.fontScale !== undefined
              ? { fontScale: subtitleOverride.fontScale }
              : {}),
            ...(subtitleOverride.backgroundOpacity !== undefined
              ? { backgroundOpacity: subtitleOverride.backgroundOpacity }
              : {}),
          }
        : {}),
    },
  };
}
