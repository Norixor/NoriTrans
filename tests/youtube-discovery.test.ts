import {
  extractYouTubeCaptionTracks,
  selectYouTubeCaptionTrack,
  youtubeJson3Url,
} from "@/src/subtitles/adapters/youtube-discovery";
import { describe, expect, it } from "vitest";

describe("YouTube caption discovery", () => {
  it("extracts tracks and prefers a manual caption over ASR", () => {
    const tracks = extractYouTubeCaptionTracks({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://www.youtube.com/api/timedtext?lang=en&kind=asr",
              languageCode: "en",
              kind: "asr",
            },
            {
              baseUrl: "https://www.youtube.com/api/timedtext?lang=fr",
              languageCode: "fr",
              vssId: ".fr",
            },
          ],
        },
      },
    });

    expect(tracks).toHaveLength(2);
    expect(selectYouTubeCaptionTrack(tracks)).toMatchObject({
      languageCode: "fr",
      vssId: ".fr",
    });
  });

  it("uses ASR when it is the only track and forces the json3 format", () => {
    const track = {
      baseUrl:
        "https://www.youtube.com/api/timedtext?lang=en&kind=asr&fmt=srv3",
      languageCode: "en",
      kind: "asr",
    };

    expect(selectYouTubeCaptionTrack([track])).toBe(track);
    expect(youtubeJson3Url(track.baseUrl)).toContain("fmt=json3");
  });

  it("honors the configured source language before the default manual track", () => {
    const tracks = [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?lang=en",
        languageCode: "en",
      },
      {
        baseUrl: "https://www.youtube.com/api/timedtext?lang=fr&kind=asr",
        languageCode: "fr",
        kind: "asr",
      },
    ];

    expect(selectYouTubeCaptionTrack(tracks, "fr")).toBe(tracks[1]);
    expect(selectYouTubeCaptionTrack(tracks, "de")).toBeUndefined();
  });

  it("rejects malformed player response tracks", () => {
    expect(
      extractYouTubeCaptionTracks({
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [{ baseUrl: 123, languageCode: "en" }],
          },
        },
      }),
    ).toEqual([]);
  });
});
