import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";
import { languageTagsMatch } from "@/src/shared/languages";
import {
  builtInSiteProfile,
  profileMatchesLocation,
} from "@/src/subtitles/profiles/registry";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import { selectActiveVideo } from "@/src/subtitles/video-selection";

import type { SubtitleAdapter } from "./types";

const DEFAULT_PROFILE = builtInSiteProfile("default-html5");

function cueText(cue: TextTrackCue): string {
  if ("text" in cue && typeof cue.text === "string") return cue.text.trim();
  return "";
}

function readTrack(
  track: TextTrack,
  videoIndex: number,
  trackIndex: number,
  completeness: SubtitleTrack["completeness"],
): SubtitleTrack | null {
  if (!track.cues || track.cues.length === 0) return null;

  const cues: SubtitleCue[] = [];
  for (let index = 0; index < track.cues.length; index += 1) {
    const sourceCue = track.cues[index];
    if (!sourceCue) continue;
    const originalText = cueText(sourceCue);
    if (!originalText) continue;
    const startMs = Math.max(0, Math.round(sourceCue.startTime * 1_000));
    const endMs = Number.isFinite(sourceCue.endTime)
      ? Math.max(startMs, Math.round(sourceCue.endTime * 1_000))
      : null;
    cues.push({
      id: `texttrack-${videoIndex}-${trackIndex}-${index}-${startMs}`,
      startMs,
      endMs,
      originalText,
    });
  }

  if (cues.length === 0) return null;
  return {
    source: "texttrack",
    completeness,
    language: track.language || "und",
    cues,
  };
}

function hasCompleteFiniteTimeline(
  video: HTMLVideoElement,
  track: TextTrack,
  trackElement: HTMLTrackElement | undefined,
): boolean {
  if (video.duration === Number.POSITIVE_INFINITY) return false;
  if (trackElement?.readyState === 2) return true;
  if (!Number.isFinite(video.duration) || video.duration <= 0) return false;
  if (trackElement || !track.cues || track.cues.length === 0) return false;

  let finalCueEnd = Number.NEGATIVE_INFINITY;
  for (const cue of Array.from(track.cues)) {
    if (!Number.isFinite(cue.startTime) || !Number.isFinite(cue.endTime)) {
      return false;
    }
    finalCueEnd = Math.max(finalCueEnd, cue.endTime);
  }

  // Script-created tracks have no HTMLTrackElement/readyState. Only call one
  // complete when the populated timeline reaches well ahead of playback and
  // close to the finite media end. Cue lists growing around currentTime remain
  // streams, including on finite DVR/VOD players.
  const endToleranceSeconds = Math.max(2, Math.min(120, video.duration * 0.1));
  const remainingSeconds = Math.max(0, video.duration - video.currentTime);
  const requiredLookaheadSeconds = Math.min(30, remainingSeconds * 0.5);
  return (
    remainingSeconds > 1 &&
    finalCueEnd >= video.duration - endToleranceSeconds &&
    finalCueEnd >= video.currentTime + requiredLookaheadSeconds
  );
}

export class Html5TextTrackAdapter implements SubtitleAdapter {
  readonly id = "html5-texttrack";
  readonly priority = 1;
  private sourceLanguage = "auto";
  private preferredVideo: HTMLVideoElement | null = null;
  private readonly invalidationListeners = new Set<() => void>();
  private hadUsableTrack = false;

  constructor(
    private readonly profile: SubtitleSiteProfile = DEFAULT_PROFILE,
  ) {}

  setSourceLanguage(language: string): void {
    this.sourceLanguage = language;
  }

  setPreferredVideo(video: HTMLVideoElement | null): void {
    if (video === this.preferredVideo) return;
    this.preferredVideo = video;
    if (!this.hadUsableTrack) return;
    this.hadUsableTrack = false;
    for (const listener of this.invalidationListeners) listener();
  }

  matches(location: Location): boolean {
    return profileMatchesLocation(this.profile, location);
  }

  collect(): Promise<SubtitleTrack | null> {
    const video = selectActiveVideo(
      this.profile.selectors.video,
      this.preferredVideo,
    );
    if (!video) return Promise.resolve(this.observeCollection(null));
    const videoIndex = Array.from(
      document.querySelectorAll<HTMLVideoElement>(this.profile.selectors.video),
    ).indexOf(video);
    const trackIndexes = Array.from(
      { length: video.textTracks.length },
      (_, index) => index,
    ).sort((leftIndex, rightIndex) => {
      const left = video.textTracks[leftIndex];
      const right = video.textTracks[rightIndex];
      if (this.sourceLanguage !== "auto") {
        const leftMatches = Boolean(
          left && languageTagsMatch(this.sourceLanguage, left.language),
        );
        const rightMatches = Boolean(
          right && languageTagsMatch(this.sourceLanguage, right.language),
        );
        if (leftMatches !== rightMatches) return leftMatches ? -1 : 1;
      }
      const modeRank = (track: TextTrack | undefined): number =>
        track?.mode === "showing" ? 0 : track?.mode === "hidden" ? 1 : 2;
      return modeRank(left) - modeRank(right);
    });
    for (const trackIndex of trackIndexes) {
      const track = video.textTracks[trackIndex];
      if (!track || (track.kind !== "subtitles" && track.kind !== "captions"))
        continue;
      if (
        this.sourceLanguage !== "auto" &&
        !languageTagsMatch(this.sourceLanguage, track.language)
      )
        continue;

      const previousMode = track.mode;
      if (previousMode === "disabled") track.mode = "hidden";
      const trackElement = Array.from(video.querySelectorAll("track")).find(
        (element) => element.track === track,
      );
      const completeness = hasCompleteFiniteTimeline(video, track, trackElement)
        ? "full"
        : "stream";
      const parsed = readTrack(track, videoIndex, trackIndex, completeness);
      if (previousMode === "disabled") track.mode = previousMode;
      if (parsed) return Promise.resolve(this.observeCollection(parsed));
    }
    return Promise.resolve(this.observeCollection(null));
  }

  private observeCollection(track: SubtitleTrack | null): SubtitleTrack | null {
    if (track) {
      this.hadUsableTrack = true;
    } else if (this.hadUsableTrack) {
      this.hadUsableTrack = false;
      for (const listener of this.invalidationListeners) listener();
    }
    return track;
  }

  subscribe(listener: (track: SubtitleTrack) => void): () => void {
    let disposed = false;
    let timer: number | undefined;
    let video: HTMLVideoElement | null = null;
    let tracks: TextTrack[] = [];
    const schedule = (): void => {
      if (disposed || timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        bind();
        void this.collect().then((track) => {
          if (disposed) return;
          if (track) {
            listener(track);
          }
        });
      }, 40);
    };
    const unbind = (): void => {
      video?.textTracks.removeEventListener("addtrack", schedule);
      video?.textTracks.removeEventListener("removetrack", schedule);
      video?.removeEventListener("loadedmetadata", schedule);
      video?.removeEventListener("durationchange", schedule);
      video?.removeEventListener("emptied", schedule);
      for (const track of tracks)
        track.removeEventListener("cuechange", schedule);
      tracks = [];
    };
    const bind = (): void => {
      const nextVideo = selectActiveVideo(
        this.profile.selectors.video,
        this.preferredVideo,
      );
      const nextTracks = nextVideo
        ? Array.from(
            { length: nextVideo.textTracks.length },
            (_, index) => nextVideo.textTracks[index],
          ).filter((track): track is TextTrack => track !== undefined)
        : [];
      if (
        nextVideo === video &&
        nextTracks.length === tracks.length &&
        nextTracks.every((track, index) => track === tracks[index])
      ) {
        return;
      }
      unbind();
      video = nextVideo;
      tracks = nextTracks;
      video?.textTracks.addEventListener("addtrack", schedule);
      video?.textTracks.addEventListener("removetrack", schedule);
      video?.addEventListener("loadedmetadata", schedule);
      video?.addEventListener("durationchange", schedule);
      video?.addEventListener("emptied", schedule);
      for (const track of tracks) track.addEventListener("cuechange", schedule);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "kind", "srclang", "default"],
    });
    document.addEventListener("play", schedule, true);
    bind();
    schedule();
    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener("play", schedule, true);
      unbind();
      video = null;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }
}
