import {
  deleteSharedSubtitleTrack,
  getSharedCachedTranslation,
  getSharedSubtitleTrack,
  invalidateSharedCacheLeases,
  setSharedCachedTranslation,
  setSharedSubtitleTrack,
} from "@/src/cache/content-client";
import type { SubtitleTrack } from "@/src/subtitles/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(),
}));

vi.mock("wxt/browser", () => ({ browser: { runtime } }));

const key = "a".repeat(64);
const track: SubtitleTrack = {
  source: "youtube-timedtext",
  completeness: "full",
  language: "en",
  cues: [{ id: "cue-1", startMs: 0, endMs: 1_000, originalText: "Hello" }],
};

describe("content cache client", () => {
  beforeEach(() => {
    runtime.sendMessage.mockReset();
    invalidateSharedCacheLeases();
  });

  it("reads translation and subtitle-track hits from the extension background", async () => {
    runtime.sendMessage
      .mockResolvedValueOnce({
        ok: true,
        hit: true,
        translatedText: "你好",
        epoch: 3,
      })
      .mockResolvedValueOnce({ ok: true, hit: true, track, epoch: 3 });

    await expect(getSharedCachedTranslation(key)).resolves.toBe("你好");
    await expect(getSharedSubtitleTrack(key)).resolves.toEqual(track);
    expect(runtime.sendMessage).toHaveBeenNthCalledWith(1, {
      type: "TRANSLATION_CACHE_GET",
      key,
    });
    expect(runtime.sendMessage).toHaveBeenNthCalledWith(2, {
      type: "SUBTITLE_TRACK_GET",
      key,
    });
  });

  it("treats misses, malformed replies, and runtime failures as cache misses", async () => {
    runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, hit: false, epoch: 4 })
      .mockResolvedValueOnce({
        ok: true,
        hit: true,
        translatedText: 42,
        epoch: 4,
      })
      .mockRejectedValueOnce(new Error("background unavailable"));

    await expect(getSharedCachedTranslation(key)).resolves.toBeUndefined();
    await expect(getSharedCachedTranslation(key)).resolves.toBeUndefined();
    await expect(getSharedSubtitleTrack(key)).resolves.toBeUndefined();
  });

  it("writes translations and tracks only through background messages", async () => {
    runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, hit: false, epoch: 7 })
      .mockResolvedValueOnce({ ok: true, hit: false, epoch: 7 })
      .mockResolvedValue({ ok: true, stored: true, epoch: 7 });

    await getSharedCachedTranslation(key);
    await getSharedSubtitleTrack(key);

    await setSharedCachedTranslation(key, "你好");
    await setSharedSubtitleTrack(key, track);
    await deleteSharedSubtitleTrack(key);

    expect(runtime.sendMessage).toHaveBeenNthCalledWith(3, {
      type: "TRANSLATION_CACHE_SET",
      key,
      translatedText: "你好",
      epoch: 7,
    });
    expect(runtime.sendMessage).toHaveBeenNthCalledWith(4, {
      type: "SUBTITLE_TRACK_SET",
      key,
      track,
      epoch: 7,
    });
    expect(runtime.sendMessage).toHaveBeenNthCalledWith(5, {
      type: "SUBTITLE_TRACK_DELETE",
      key,
      epoch: 7,
    });
  });

  it("drops leases and pending reads when a global cache clear is observed", async () => {
    let resolveRead: ((value: unknown) => void) | undefined;
    runtime.sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const pendingRead = getSharedCachedTranslation(key);
    invalidateSharedCacheLeases();
    resolveRead?.({ ok: true, hit: true, translatedText: "旧译文", epoch: 8 });

    await expect(pendingRead).resolves.toBeUndefined();
    runtime.sendMessage.mockClear();
    await setSharedCachedTranslation(key, "迟到译文");
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });
});
