import { readNetflixPlayerTextTracks } from "@/src/subtitles/adapters/netflix-player";
import { describe, expect, it, vi } from "vitest";

describe("Netflix player subtitle discovery", () => {
  it("reads the active watch session text-track list", () => {
    const tracks = [{ bcp47: "en", ttDownloadables: { "imsc1.1": {} } }];
    const previewPlayer = { getTextTrackList: vi.fn(() => []) };
    const watchPlayer = { getTextTrackList: vi.fn(() => tracks) };
    const getVideoPlayerBySessionId = vi.fn((sessionId: unknown) =>
      String(sessionId).includes("watch") ? watchPlayer : previewPlayer,
    );

    const result = readNetflixPlayerTextTracks({
      netflix: {
        appContext: {
          state: {
            playerApp: {
              getAPI: () => ({
                videoPlayer: {
                  getAllPlayerSessionIds: () => ["preview-1", "watch-2"],
                  getVideoPlayerBySessionId,
                },
              }),
            },
          },
        },
      },
    });

    expect(result).toBe(tracks);
    expect(getVideoPlayerBySessionId).toHaveBeenCalledTimes(1);
    expect(getVideoPlayerBySessionId).toHaveBeenCalledWith("watch-2");
  });

  it("supports the alternate session and timed-text method names", () => {
    const tracks = [{ language: "ja" }];
    expect(
      readNetflixPlayerTextTracks({
        netflix: {
          appContext: {
            state: {
              playerApp: {
                getAPI: () => ({
                  videoPlayer: {
                    getAllPlayerSessionIds: () => ["watch-main"],
                    getVideoPlayerSession: () => ({
                      getTimedTextTrackList: () => tracks,
                    }),
                  },
                }),
              },
            },
          },
        },
      }),
    ).toBe(tracks);
  });

  it("does not mistake a preview player for the active watch session", () => {
    expect(
      readNetflixPlayerTextTracks({
        netflix: {
          appContext: {
            state: {
              playerApp: {
                getAPI: () => ({
                  videoPlayer: {
                    getAllPlayerSessionIds: () => ["preview-1"],
                    getVideoPlayerBySessionId: () => ({
                      getTextTrackList: () => [{ language: "en" }],
                    }),
                  },
                }),
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("fails closed when Netflix changes or throws from the private API", () => {
    expect(readNetflixPlayerTextTracks({})).toEqual([]);
    expect(
      readNetflixPlayerTextTracks({
        netflix: {
          appContext: {
            state: {
              playerApp: {
                getAPI: () => {
                  throw new Error("private API changed");
                },
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });
});
