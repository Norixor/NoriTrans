import { Html5TextTrackAdapter } from "@/src/subtitles/adapters/html5";
import { CapturedProfileSubtitleAdapter } from "@/src/subtitles/adapters/captured-profile";
import { NetflixSubtitleAdapter } from "@/src/subtitles/adapters/netflix";
import { ProfileDomSubtitleAdapter } from "@/src/subtitles/adapters/profile-dom";
import type { SubtitleAdapter } from "@/src/subtitles/adapters/types";
import { YouTubeTimedTextAdapter } from "@/src/subtitles/adapters/youtube";
import {
  effectiveBuiltInSiteProfiles,
  isBuiltInProfileOverride,
  isOcrOnlySubtitleLocation,
  isUserSiteProfile,
  profileMatchesLocation,
} from "@/src/subtitles/profiles/registry";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import {
  DECLARATIVE_CAPTURE_PROFILE_IDS,
  DOM_PROFILE_IDS,
} from "@/src/subtitles/profiles/catalog";

const ACTIVE_USER_PROFILE_PRIORITY = 0;

export function createSubtitleAdapters(
  profiles: SubtitleSiteProfile[],
  location: Location,
): SubtitleAdapter[] {
  // Tencent Video is deliberately OCR-only: do not let HTML5, generic DOM,
  // declarative network, or a stale user DOM profile auto-capture page UI.
  if (isOcrOnlySubtitleLocation(location)) return [];

  const effectiveProfiles = effectiveBuiltInSiteProfiles(
    profiles.filter(isBuiltInProfileOverride),
  );
  const effectiveById = new Map(
    effectiveProfiles.map((profile) => [profile.id, profile] as const),
  );
  const effective = (id: string): SubtitleSiteProfile => {
    const profile = effectiveById.get(id);
    if (!profile) throw new Error(`Missing effective subtitle profile: ${id}`);
    return profile;
  };
  const youtube = effective("youtube");
  const netflix = effective("netflix");
  const capturedProfiles = DECLARATIVE_CAPTURE_PROFILE_IDS.map((id) =>
    effective(id),
  );
  const domProfiles = DOM_PROFILE_IDS.map((id) => effective(id));
  const hasBuiltInSiteAdapter = [
    youtube,
    netflix,
    ...capturedProfiles,
    ...domProfiles,
  ].some((profile) => profileMatchesLocation(profile, location));
  const matchingUserProfiles = profiles
    .filter((profile) => isUserSiteProfile(profile))
    .filter((profile) => profileMatchesLocation(profile, location));
  const adapters: SubtitleAdapter[] = [
    new Html5TextTrackAdapter(effective("default-html5")),
    new YouTubeTimedTextAdapter(youtube),
    new NetflixSubtitleAdapter(netflix),
    ...capturedProfiles.map(
      (profile) => new CapturedProfileSubtitleAdapter(profile),
    ),
    ...domProfiles.map((profile) => new ProfileDomSubtitleAdapter(profile)),
    ...matchingUserProfiles.map(
      (profile) =>
        new ProfileDomSubtitleAdapter(
          profile,
          true,
          ACTIVE_USER_PROFILE_PRIORITY,
        ),
    ),
  ];
  if (!hasBuiltInSiteAdapter) {
    adapters.push(
      new ProfileDomSubtitleAdapter(effective("default-dom-heuristic")),
    );
  }
  return adapters.sort((left, right) => left.priority - right.priority);
}
