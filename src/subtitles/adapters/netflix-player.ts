function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function callMethod(
  receiver: Record<string, unknown>,
  name: string,
  args: unknown[] = [],
): unknown {
  const method = receiver[name];
  if (typeof method !== "function") return undefined;
  return Reflect.apply(method, receiver, args) as unknown;
}

/**
 * Reads Netflix's private player object without assuming it is available or
 * stable. This runs only in MAIN world and intentionally returns no guessed
 * URLs when the current player shape is unavailable.
 */
export function readNetflixPlayerTextTracks(root: unknown): unknown[] {
  try {
    if (!isRecord(root)) return [];
    const netflix = root.netflix;
    if (!isRecord(netflix)) return [];
    const appContext = netflix.appContext;
    if (!isRecord(appContext) || !isRecord(appContext.state)) return [];
    const playerApp = appContext.state.playerApp;
    if (!isRecord(playerApp)) return [];
    const api = callMethod(playerApp, "getAPI");
    if (!isRecord(api) || !isRecord(api.videoPlayer)) return [];

    const videoPlayer = api.videoPlayer;
    const sessionIds = callMethod(videoPlayer, "getAllPlayerSessionIds");
    if (!Array.isArray(sessionIds)) return [];
    const watchSessionIds = (sessionIds as unknown[]).filter((sessionId) =>
      /watch/iu.test(String(sessionId)),
    );

    for (const sessionId of watchSessionIds.slice(0, 12)) {
      const player =
        callMethod(videoPlayer, "getVideoPlayerBySessionId", [sessionId]) ??
        callMethod(videoPlayer, "getVideoPlayerSession", [sessionId]);
      if (!isRecord(player)) continue;
      const tracks =
        callMethod(player, "getTextTrackList") ??
        callMethod(player, "getTimedTextTrackList");
      if (Array.isArray(tracks) && tracks.length > 0) return tracks;
    }
  } catch {
    // Netflix changes this private object over time; discovery must fail closed.
  }
  return [];
}
