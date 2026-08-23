import { describe, expect, it } from "vitest";

import {
  parseTtml,
  parseTtmlTimeExpression,
  parseVtt,
  parseYouTubeJson3,
} from "@/src/subtitles/parsers";

describe("subtitle parsers", () => {
  it("parses WebVTT cue identifiers, settings, markup, and metadata blocks", () => {
    const track = parseVtt(
      `\uFEFFWEBVTT - synthetic fixture

NOTE ignored metadata
not a cue

cue-one
00:00:01.250 --> 00:00:03.000 align:start position:10%
Hello <b>world</b>

01:02.500 --> 01:04.000
Second &amp; final
line
`,
      "en",
    );

    expect(track).toMatchObject({
      source: "network",
      completeness: "full",
      language: "en",
    });
    expect(track.cues).toEqual([
      {
        id: "network:0:1250",
        startMs: 1_250,
        endMs: 3_000,
        originalText: "Hello world",
      },
      {
        id: "network:1:62500",
        startMs: 62_500,
        endMs: 64_000,
        originalText: "Second & final\nline",
      },
    ]);
  });

  it("skips malformed WebVTT cues without losing later valid cues", () => {
    const track = parseVtt(`WEBVTT

bad cue
not timing

00:00:02.000 --> 00:00:01.000
backwards

00:00:04.000 --> 00:00:05.000
valid
`);

    expect(track.cues).toHaveLength(1);
    expect(track.cues[0]?.originalText).toBe("valid");
  });

  it("caps an oversized cue before it can expand translation work", () => {
    const track = parseVtt(`WEBVTT

00:00:00.000 --> 00:00:05.000
${"x".repeat(2_500)}
`);

    expect(track.cues[0]?.originalText).toHaveLength(2_000);
  });

  it("parses TTML clock, offset, tick, ancestor, and line-break timing", () => {
    const track = parseTtml(`<?xml version="1.0" encoding="UTF-8"?>
      <tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
          xml:lang="de" ttp:frameRate="25" ttp:tickRate="10">
        <body><div begin="1s">
          <p begin="500ms" dur="1.5s"><span>Hello</span><br/>world</p>
          <p begin="20t" end="40t">Ticks</p>
          <p begin="00:00:05.250" end="00:00:06.000">Clock</p>
        </div></body>
      </tt>`);

    expect(track.language).toBe("de");
    expect(
      track.cues.map(({ startMs, endMs, originalText }) => ({
        startMs,
        endMs,
        originalText,
      })),
    ).toEqual([
      { startMs: 1_500, endMs: 3_000, originalText: "Hello\nworld" },
      { startMs: 3_000, endMs: 5_000, originalText: "Ticks" },
      { startMs: 6_250, endMs: 7_000, originalText: "Clock" },
    ]);
  });

  it("parses TTML frame and unit expressions", () => {
    const rates = { frameRate: 25, subFrameRate: 10, tickRate: 100 };

    expect(parseTtmlTimeExpression("00:00:01:12.5", rates)).toBe(1_500);
    expect(parseTtmlTimeExpression("250ms", rates)).toBe(250);
    expect(parseTtmlTimeExpression("1.25s", rates)).toBe(1_250);
    expect(parseTtmlTimeExpression("50t", rates)).toBe(500);
    expect(parseTtmlTimeExpression("12.5f", rates)).toBe(500);
    expect(parseTtmlTimeExpression("nonsense", rates)).toBeNull();
  });

  it("rejects malformed TTML XML", () => {
    expect(() => parseTtml("<tt><body></tt>")).toThrow("Invalid TTML");
  });

  it("parses YouTube json3 and ignores formatting-only or malformed events", () => {
    const track = parseYouTubeJson3(
      JSON.stringify({
        events: [
          {
            tStartMs: 100,
            dDurationMs: 900,
            segs: [{ utf8: "Hello " }, { utf8: "world" }],
          },
          { tStartMs: 1_000, segs: [{ utf8: "\u00a0" }] },
          { tStartMs: 1_500, segs: [{ utf8: "Open ended" }] },
          { tStartMs: -1, dDurationMs: 20, segs: [{ utf8: "Invalid" }] },
        ],
      }),
      "en-US",
    );

    expect(track).toEqual({
      source: "youtube-timedtext",
      completeness: "full",
      language: "en-US",
      cues: [
        {
          id: "youtube-timedtext:0:100",
          startMs: 100,
          endMs: 1_000,
          originalText: "Hello world",
        },
        {
          id: "youtube-timedtext:1:1500",
          startMs: 1_500,
          endMs: null,
          originalText: "Open ended",
        },
      ],
    });
  });

  it("rejects invalid YouTube json3 shapes", () => {
    expect(() => parseYouTubeJson3({ events: "invalid" })).toThrow(
      "Invalid YouTube json3",
    );
  });
});
