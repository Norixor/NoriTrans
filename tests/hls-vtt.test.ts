import {
  assembleHlsVttFullTrack,
  fetchHlsVttFullTrack,
  parseHlsSubtitleTracks,
  parseHlsVttMediaPlaylist,
  selectHlsSubtitleTrack,
} from "@/src/subtitles/adapters/hls-vtt";
import { isAllowedSubtitleCaptureUrl } from "@/src/subtitles/adapters/captured";
import { describe, expect, it, vi } from "vitest";

const MASTER_URL = "https://cdn.disney-plus.net/title/master.m3u8";
const allowed = (url: string) =>
  isAllowedSubtitleCaptureUrl("disney-plus", url, MASTER_URL);

describe("finite HLS WebVTT subtitle discovery", () => {
  it("selects an allowlisted non-forced subtitle rendition", () => {
    const master = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English forced",LANGUAGE="en-US",FORCED=YES,URI="forced.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en-GB",DEFAULT=YES,URI="en/full.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French",LANGUAGE="fr",URI="fr/full.m3u8"',
    ].join("\n");
    const tracks = parseHlsSubtitleTracks(master, MASTER_URL, allowed);

    expect(selectHlsSubtitleTrack(tracks, "en")).toMatchObject({
      language: "en-GB",
      forced: false,
      url: "https://cdn.disney-plus.net/title/en/full.m3u8",
    });
    expect(selectHlsSubtitleTrack(tracks, "de")).toBeNull();
  });

  it("requires a finite VOD playlist and assembles only after every segment succeeds", async () => {
    const playlist = [
      "#EXTM3U",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXTINF:2.0,",
      "one.vtt",
      "#EXTINF:3.0,",
      "two.vtt",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const playlistUrl = "https://cdn.disney-plus.net/title/en/full.m3u8";
    const plan = parseHlsVttMediaPlaylist(
      playlist,
      playlistUrl,
      "en-US",
      allowed,
    );
    expect(plan?.segments.map(({ offsetMs }) => offsetMs)).toEqual([0, 2_000]);

    const fetchValue = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          url.endsWith("one.vtt")
            ? "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFirst"
            : "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nSecond",
          { status: 200 },
        ),
      ),
    );
    const body = await fetchHlsVttFullTrack(
      plan!,
      fetchValue,
      new AbortController().signal,
    );

    expect(assembleHlsVttFullTrack(body!)).toMatchObject({
      source: "network",
      completeness: "full",
      captureEvidence: "verified-full-response",
      cues: [
        { startMs: 0, originalText: "First" },
        { startMs: 2_000, originalText: "Second" },
      ],
    });
    fetchValue.mockImplementationOnce(() =>
      Promise.resolve(new Response("missing", { status: 404 })),
    );
    await expect(
      fetchHlsVttFullTrack(plan!, fetchValue, new AbortController().signal),
    ).resolves.toBeNull();
  });

  it("rejects live, encrypted, and cross-site playlists", () => {
    const base =
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:2,\none.vtt\n#EXT-X-ENDLIST";
    expect(
      parseHlsVttMediaPlaylist(
        base.replace("#EXT-X-ENDLIST", ""),
        MASTER_URL,
        "en",
        allowed,
      ),
    ).toBeNull();
    expect(
      parseHlsVttMediaPlaylist(
        base.replace(
          "#EXTINF:2,",
          '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:2,',
        ),
        MASTER_URL,
        "en",
        allowed,
      ),
    ).toBeNull();
    expect(
      parseHlsVttMediaPlaylist(
        base.replace("one.vtt", "https://attacker.example/one.vtt"),
        MASTER_URL,
        "en",
        allowed,
      ),
    ).toBeNull();
  });
});
