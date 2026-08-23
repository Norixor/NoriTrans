import { languageTagsMatch } from "@/src/shared/languages";

export interface NetflixTimedTextCandidate {
  url: string;
  language: string;
  profile: string;
  trackKey: string;
}

const PROFILE_PRIORITY = [
  "imsc1.1",
  "dfxp-ls-sdh",
  "webvtt-lssdh-ios8",
  "simplesdh",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function candidateUrls(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value
      .slice(0, 12)
      .flatMap((entry) => candidateUrls(entry, depth + 1));
  if (!isRecord(value)) return [];
  const direct = [value.url, value.href].map(stringValue).filter(Boolean);
  if (direct.length > 0) return direct;
  return Object.values(value)
    .slice(0, 24)
    .flatMap((entry) => candidateUrls(entry, depth + 1));
}

function profileRank(profile: string): number {
  const normalized = profile.trim().toLowerCase();
  const index = PROFILE_PRIORITY.findIndex((value) =>
    normalized.includes(value),
  );
  return index < 0 ? PROFILE_PRIORITY.length : index;
}

/**
 * Extracts only signed timed-text download URLs declared by Netflix manifest
 * track metadata. Generic JSON strings are intentionally ignored.
 */
export function extractNetflixTimedTextCandidates(
  value: unknown,
  limit = 48,
): NetflixTimedTextCandidate[] {
  const found: NetflixTimedTextCandidate[] = [];
  const seenObjects = new WeakSet<object>();
  const seenUrls = new Set<string>();

  const collectTrack = (track: unknown, index: number): void => {
    if (!isRecord(track) || found.length >= limit) return;
    if (track.isNoneTrack === true || track.isImageBased === true) return;
    const language =
      stringValue(track.bcp47) ||
      stringValue(track.language) ||
      stringValue(track.locale) ||
      stringValue(track.languageTag);
    const trackKey =
      stringValue(track.trackId) ||
      stringValue(track.downloadableId) ||
      stringValue(track.dlid) ||
      `track-${index}`;
    const downloadables = isRecord(track.ttDownloadables)
      ? track.ttDownloadables
      : isRecord(track.downloadables)
        ? track.downloadables
        : null;
    if (!downloadables) return;

    for (const [profile, downloadable] of Object.entries(downloadables)) {
      for (const rawUrl of candidateUrls(downloadable)) {
        if (found.length >= limit) return;
        let url: URL;
        try {
          url = new URL(rawUrl, location.href);
        } catch {
          continue;
        }
        if (url.protocol !== "https:" || seenUrls.has(url.href)) continue;
        seenUrls.add(url.href);
        found.push({ url: url.href, language, profile, trackKey });
      }
    }
  };

  const walk = (node: unknown, depth: number): void => {
    if (
      depth > 12 ||
      found.length >= limit ||
      (!isRecord(node) && !Array.isArray(node))
    )
      return;
    if (typeof node === "object" && node !== null) {
      if (seenObjects.has(node)) return;
      seenObjects.add(node);
    }
    if (Array.isArray(node)) {
      for (const child of node.slice(0, 200)) walk(child, depth + 1);
      return;
    }
    const tracks = node.timedtexttracks;
    if (Array.isArray(tracks)) {
      tracks.slice(0, 100).forEach(collectTrack);
    }
    for (const child of Object.values(node).slice(0, 200)) {
      walk(child, depth + 1);
    }
  };

  walk(value, 0);
  return found;
}

/** Chooses at most one preferred representation per timed-text track. */
export function selectNetflixTimedTextCandidates(
  candidates: readonly NetflixTimedTextCandidate[],
  preferredLanguage: string,
  limit = 8,
): NetflixTimedTextCandidate[] {
  const preferred = preferredLanguage.trim();
  const matching =
    preferred && preferred !== "auto"
      ? candidates.filter(
          (candidate) =>
            candidate.language.length > 0 &&
            languageTagsMatch(preferred, candidate.language),
        )
      : [...candidates];
  const byTrack = new Map<string, NetflixTimedTextCandidate>();
  for (const candidate of matching) {
    const key = `${candidate.trackKey}|${candidate.language}`;
    const current = byTrack.get(key);
    if (
      !current ||
      profileRank(candidate.profile) < profileRank(current.profile)
    ) {
      byTrack.set(key, candidate);
    }
  }
  return [...byTrack.values()]
    .sort(
      (left, right) =>
        profileRank(left.profile) - profileRank(right.profile) ||
        left.language.localeCompare(right.language) ||
        left.trackKey.localeCompare(right.trackKey),
    )
    .slice(0, Math.max(0, limit));
}
