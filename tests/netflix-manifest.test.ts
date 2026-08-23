import {
  extractNetflixTimedTextCandidates,
  selectNetflixTimedTextCandidates,
} from "@/src/subtitles/adapters/netflix-manifest";
import { describe, expect, it } from "vitest";

describe("Netflix manifest timed-text discovery", () => {
  it("extracts only downloadable subtitle URLs with their track language", () => {
    const candidates = extractNetflixTimedTextCandidates({
      result: {
        movieId: 123,
        timedtexttracks: [
          {
            isNoneTrack: true,
            ttDownloadables: {
              "imsc1.1": { urls: [{ url: "https://ignored.example/none" }] },
            },
          },
          {
            trackId: "en-main",
            bcp47: "en-US",
            ttDownloadables: {
              "webvtt-lssdh-ios8": {
                urls: [
                  { url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&p=vtt" },
                ],
              },
              "imsc1.1": {
                urls: [
                  { url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&p=imsc" },
                ],
              },
            },
          },
        ],
        unrelated: "https://attacker.example/subtitle.vtt",
      },
    });

    expect(candidates).toEqual([
      {
        url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&p=vtt",
        language: "en-US",
        profile: "webvtt-lssdh-ios8",
        trackKey: "en-main",
      },
      {
        url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&p=imsc",
        language: "en-US",
        profile: "imsc1.1",
        trackKey: "en-main",
      },
    ]);
  });

  it("chooses one preferred representation per matching language track", () => {
    const selected = selectNetflixTimedTextCandidates(
      [
        {
          url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&p=vtt",
          language: "en-US",
          profile: "webvtt-lssdh-ios8",
          trackKey: "en-main",
        },
        {
          url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&p=imsc",
          language: "en-US",
          profile: "imsc1.1",
          trackKey: "en-main",
        },
        {
          url: "https://ipv4-c001.nflxvideo.net/?o=3&v=4&p=imsc",
          language: "zh-Hans",
          profile: "imsc1.1",
          trackKey: "zh-main",
        },
      ],
      "en",
    );

    expect(selected).toEqual([
      expect.objectContaining({
        url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&p=imsc",
        language: "en-US",
      }),
    ]);
  });
});
