import { describe, expect, it } from "vitest";
import { isBackgroundCommand } from "@/src/messaging/protocol";
import { DEFAULT_SETTINGS, mergeSettings } from "@/src/shared/settings";
import { parseSettingsPatch } from "@/src/shared/settings-patch";
import { isSoundCue } from "@/src/subtitles/sound-cues";

describe("isSoundCue", () => {
  it.each([
    "(🎵 siren)",
    "(🎵 警笛声)",
    "[Music]",
    "(applause)",
    "{wind}",
    "♪",
    "♪ ♪",
    "♫♬",
    "🎶",
    "- ♪ -",
    "（笑）",
    "［音楽］",
    "【拍手】",
    "｛風｝",
    "〈BGM〉",
    "《♪》",
    "(a (b) c)",
    "[ door [creaks] ]",
    "  [Music]  ",
    "[Music]\n(applause)",
    "(applause)\r\n♪",
    "- [Music]\n- (laughs)",
    "(♪ la la la ♪)",
  ])("treats %j as a sound cue", (text) => {
    expect(isSoundCue(text)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "\n \n",
    "♪ la la la ♪",
    "♪ Hello ♪",
    "[Music] Hello",
    "Hello [Music]",
    "(John) Hi",
    "(a) and (b)",
    "(a) b (c)",
    "[a][b]",
    "(unclosed",
    "closed)",
    "(mismatched]",
    "()",
    "( )",
    "Hello",
    "- Hello",
    "[Music]\nHello there",
    "Hello there\n(applause)",
    "♪ la\n(music)",
    "「こんにちは」",
    "...",
    "-",
  ])("keeps %j as translatable text", (text) => {
    expect(isSoundCue(text)).toBe(false);
  });
});

describe("ignore sound cues setting", () => {
  it("defaults off and normalizes missing or malformed stored values", () => {
    expect(DEFAULT_SETTINGS.subtitles.ignoreSoundCues).toBe(false);
    const legacySubtitles: Record<string, unknown> = {
      ...DEFAULT_SETTINGS.subtitles,
    };
    delete legacySubtitles.ignoreSoundCues;
    expect(
      mergeSettings({ ...DEFAULT_SETTINGS, subtitles: legacySubtitles })
        .subtitles.ignoreSoundCues,
    ).toBe(false);
    expect(
      mergeSettings({
        ...DEFAULT_SETTINGS,
        subtitles: { ...DEFAULT_SETTINGS.subtitles, ignoreSoundCues: "yes" },
      }).subtitles.ignoreSoundCues,
    ).toBe(false);
    const stored = mergeSettings({
      ...DEFAULT_SETTINGS,
      subtitles: { ...DEFAULT_SETTINGS.subtitles, ignoreSoundCues: true },
    });
    expect(stored.subtitles.ignoreSoundCues).toBe(true);
    expect({ ...stored.subtitles, ignoreSoundCues: false }).toEqual(
      DEFAULT_SETTINGS.subtitles,
    );
  });

  it("accepts boolean patches and rejects other types", () => {
    expect(
      parseSettingsPatch({ subtitles: { ignoreSoundCues: true } }),
    ).toEqual({ ok: true, patch: { subtitles: { ignoreSoundCues: true } } });
    for (const value of ["true", 1, null]) {
      expect(
        parseSettingsPatch({ subtitles: { ignoreSoundCues: value } }).ok,
      ).toBe(false);
    }
  });

  it("requires the boolean in a full SETTINGS_SET payload", () => {
    expect(
      isBackgroundCommand({ type: "SETTINGS_SET", settings: DEFAULT_SETTINGS }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "SETTINGS_SET",
        settings: {
          ...DEFAULT_SETTINGS,
          subtitles: { ...DEFAULT_SETTINGS.subtitles, ignoreSoundCues: 1 },
        },
      }),
    ).toBe(false);
  });
});
