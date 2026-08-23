import {
  assembleMaxDashFullTrack,
  fetchMaxDashFullTrack,
  parseMaxDashTextTracks,
  selectMaxDashTextTrack,
  type MaxDashTrackPlan,
} from "@/src/subtitles/adapters/max-dash";
import { isAllowedSubtitleCaptureUrl } from "@/src/subtitles/adapters/captured";
import { describe, expect, it, vi } from "vitest";

const MANIFEST_URL =
  "https://cmaf.fly.eu.hbomaxcdn.com/title/manifest/main.mpd";

function allowedMaxUrl(url: string): boolean {
  return isAllowedSubtitleCaptureUrl("max", url, MANIFEST_URL);
}

function adaptation(options: {
  forced?: boolean;
  language: string;
  media: string;
  representationId: string;
  timescale?: number;
  timeline: string;
}): string {
  return `<AdaptationSet contentType="text" lang="${options.language}">
    <Label>${options.language}${options.forced ? " forced" : " full"}</Label>
    ${options.forced ? '<Role value="forced-subtitle" />' : ""}
    <SegmentTemplate media="${options.media}" startNumber="7" timescale="${options.timescale ?? 1_000}">
      <SegmentTimeline>${options.timeline}</SegmentTimeline>
    </SegmentTemplate>
    <Representation id="${options.representationId}" bandwidth="256" mimeType="text/vtt" />
  </AdaptationSet>`;
}

describe("Max finite DASH subtitle discovery", () => {
  it("expands SegmentTimeline and replaces Number, Time, representation and bandwidth templates", () => {
    const mpd = `<MPD type="static">
      <BaseURL>https://cmaf.fly.eu.hbomaxcdn.com/title/subtitle/</BaseURL>
      <Period>
        ${adaptation({
          language: "en-US",
          media: "$RepresentationID$/$Bandwidth$/seg-$Number%03d$-$Time$.vtt",
          representationId: "english",
          timescale: 90_000,
          timeline: '<S t="90000" d="180000" r="2" />',
        })}
      </Period>
    </MPD>`;

    const tracks = parseMaxDashTextTracks(mpd, MANIFEST_URL, allowedMaxUrl);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.segments).toEqual([
      {
        number: 7,
        time: 90_000,
        offsetMs: 1_000,
        url: "https://cmaf.fly.eu.hbomaxcdn.com/title/subtitle/english/256/seg-007-90000.vtt",
      },
      {
        number: 8,
        time: 270_000,
        offsetMs: 3_000,
        url: "https://cmaf.fly.eu.hbomaxcdn.com/title/subtitle/english/256/seg-008-270000.vtt",
      },
      {
        number: 9,
        time: 450_000,
        offsetMs: 5_000,
        url: "https://cmaf.fly.eu.hbomaxcdn.com/title/subtitle/english/256/seg-009-450000.vtt",
      },
    ]);
  });

  it("selects the configured source language and prefers a non-forced track", () => {
    const mpd = `<MPD type="static"><Period>
      ${adaptation({
        forced: true,
        language: "en-US",
        media:
          "https://cmaf.fly.eu.hbomaxcdn.com/subtitle/en-forced-$Number$.vtt",
        representationId: "en-forced",
        timeline: '<S t="0" d="1000" />',
      })}
      ${adaptation({
        language: "fr-FR",
        media: "https://cmaf.fly.eu.hbomaxcdn.com/subtitle/fr-$Number$.vtt",
        representationId: "fr",
        timeline: '<S t="0" d="1000" />',
      })}
      ${adaptation({
        language: "en-GB",
        media: "https://cmaf.fly.eu.hbomaxcdn.com/subtitle/en-$Number$.vtt",
        representationId: "en",
        timeline: '<S t="0" d="1000" />',
      })}
    </Period></MPD>`;
    const tracks = parseMaxDashTextTracks(mpd, MANIFEST_URL, allowedMaxUrl);

    expect(selectMaxDashTextTrack(tracks, "fr")?.language).toBe("fr-FR");
    expect(selectMaxDashTextTrack(tracks, "en")?.language).toBe("en-GB");
    expect(selectMaxDashTextTrack(tracks, "de")).toBeNull();
  });

  it("rejects malicious segment URLs and non-finite manifests", () => {
    const malicious = `<MPD type="static"><Period>
      ${adaptation({
        language: "en",
        media: "https://attacker.example/subtitle-$Number$.vtt",
        representationId: "en",
        timeline: '<S t="0" d="1000" />',
      })}
    </Period></MPD>`;
    const dynamic = malicious
      .replace('type="static"', 'type="dynamic"')
      .replace("https://attacker.example", "https://cmaf.fly.eu.hbomaxcdn.com");
    const unbounded = dynamic
      .replace('type="dynamic"', 'type="static"')
      .replace('r="0"', 'r="-1"')
      .replace('<S t="0" d="1000" />', '<S t="0" d="1000" r="-1" />');

    expect(
      parseMaxDashTextTracks(malicious, MANIFEST_URL, allowedMaxUrl),
    ).toEqual([]);
    expect(
      parseMaxDashTextTracks(dynamic, MANIFEST_URL, allowedMaxUrl),
    ).toEqual([]);
    expect(
      parseMaxDashTextTracks(unbounded, MANIFEST_URL, allowedMaxUrl),
    ).toEqual([]);
  });

  it("returns and assembles full only after every VTT segment succeeds", async () => {
    const plan: MaxDashTrackPlan = {
      language: "en-US",
      forced: false,
      segments: [
        {
          number: 1,
          time: 0,
          offsetMs: 0,
          url: "https://cdn.example/one.vtt",
        },
        {
          number: 2,
          time: 2_000,
          offsetMs: 2_000,
          url: "https://cdn.example/two.vtt",
        },
      ],
    };
    const fetchValue = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith("one.vtt")
          ? new Response("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFirst", {
              status: 200,
            })
          : new Response(
              [
                "WEBVTT",
                "X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:180000",
                "",
                "00:00:00.000 --> 00:00:02.000",
                "Second",
              ].join("\n"),
              { status: 200 },
            ),
      ),
    );

    const body = await fetchMaxDashFullTrack(
      plan,
      fetchValue,
      new AbortController().signal,
    );

    expect(body).not.toBeNull();
    expect(assembleMaxDashFullTrack(body!)).toMatchObject({
      source: "network",
      completeness: "full",
      captureEvidence: "verified-full-response",
      language: "en-US",
      cues: [
        { startMs: 0, originalText: "First" },
        { startMs: 2_000, originalText: "Second" },
      ],
    });
  });

  it("applies SegmentTimeline offsets to relative VTT cues without double-offsetting mapped cues", async () => {
    const plan: MaxDashTrackPlan = {
      language: "en",
      forced: false,
      segments: [
        {
          number: 1,
          time: 45_000,
          offsetMs: 5_000,
          url: "https://cdn.example/one.vtt",
        },
        {
          number: 2,
          time: 90_000,
          offsetMs: 10_000,
          url: "https://cdn.example/two.vtt",
        },
        {
          number: 3,
          time: 135_000,
          offsetMs: 15_000,
          url: "https://cdn.example/mapped.vtt",
        },
      ],
    };
    const bodyByUrl = new Map([
      [
        "https://cdn.example/one.vtt",
        "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nRelative first",
      ],
      [
        "https://cdn.example/two.vtt",
        "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nRelative second",
      ],
      [
        "https://cdn.example/mapped.vtt",
        [
          "WEBVTT",
          "X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:1800000",
          "",
          "00:00:00.000 --> 00:00:01.000",
          "Already mapped",
        ].join("\n"),
      ],
    ]);

    const body = await fetchMaxDashFullTrack(
      plan,
      (url) =>
        Promise.resolve(new Response(bodyByUrl.get(url), { status: 200 })),
      new AbortController().signal,
    );

    expect(assembleMaxDashFullTrack(body!)).toMatchObject({
      cues: [
        { startMs: 5_000, originalText: "Relative first" },
        { startMs: 10_000, originalText: "Relative second" },
        { startMs: 20_000, originalText: "Already mapped" },
      ],
    });
  });

  it("returns no full body when a segment is missing", async () => {
    const plan: MaxDashTrackPlan = {
      language: "en",
      forced: false,
      segments: [
        {
          number: 1,
          time: 0,
          offsetMs: 0,
          url: "https://cdn.example/one.vtt",
        },
        {
          number: 2,
          time: 1_000,
          offsetMs: 1_000,
          url: "https://cdn.example/missing.vtt",
        },
      ],
    };
    const fetchValue = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith("missing.vtt")
          ? new Response("missing", { status: 404 })
          : new Response(
              "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOnly partial",
              { status: 200 },
            ),
      ),
    );

    await expect(
      fetchMaxDashFullTrack(plan, fetchValue, new AbortController().signal),
    ).resolves.toBeNull();
  });
});
