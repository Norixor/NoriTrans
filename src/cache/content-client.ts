import type { SubtitleTrack } from "@/src/subtitles/types";
import { browser } from "wxt/browser";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCacheEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

let cacheLeaseGeneration = 0;
const cacheEpochByKey = new Map<string, number>();

/**
 * Invalidates every lease captured before a global cache clear. A later write
 * is allowed only after the same key has been read again from the background,
 * so a cancelled content task cannot repopulate freshly cleared storage.
 */
export function invalidateSharedCacheLeases(): void {
  cacheLeaseGeneration += 1;
  cacheEpochByKey.clear();
}

function rememberCacheLease(
  key: string,
  response: Record<string, unknown>,
  generation: number,
): boolean {
  if (generation !== cacheLeaseGeneration || !isCacheEpoch(response.epoch)) {
    return false;
  }
  cacheEpochByKey.set(key, response.epoch);
  return true;
}

export async function getSharedCachedTranslation(
  key: string,
): Promise<string | undefined> {
  const generation = cacheLeaseGeneration;
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: "TRANSLATION_CACHE_GET",
      key,
    });
    if (
      !isRecord(response) ||
      response.ok !== true ||
      !rememberCacheLease(key, response, generation) ||
      response.hit !== true ||
      typeof response.translatedText !== "string" ||
      response.translatedText.length === 0
    ) {
      return undefined;
    }
    return response.translatedText;
  } catch {
    return undefined;
  }
}

export function setSharedCachedTranslation(
  key: string,
  translatedText: string,
): Promise<void> {
  const epoch = cacheEpochByKey.get(key);
  if (epoch === undefined) return Promise.resolve();
  try {
    void browser.runtime
      .sendMessage({
        type: "TRANSLATION_CACHE_SET",
        key,
        translatedText,
        epoch,
      })
      .catch(() => undefined);
  } catch {
    // Cache writes are best-effort.
  }
  return Promise.resolve();
}

export async function getSharedSubtitleTrack(key: string): Promise<unknown> {
  const generation = cacheLeaseGeneration;
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: "SUBTITLE_TRACK_GET",
      key,
    });
    return isRecord(response) &&
      response.ok === true &&
      rememberCacheLease(key, response, generation) &&
      response.hit === true
      ? response.track
      : undefined;
  } catch {
    return undefined;
  }
}

export async function setSharedSubtitleTrack(
  key: string,
  track: SubtitleTrack,
): Promise<void> {
  const epoch = cacheEpochByKey.get(key);
  if (epoch === undefined) return;
  try {
    await browser.runtime.sendMessage({
      type: "SUBTITLE_TRACK_SET",
      key,
      track,
      epoch,
    });
  } catch {
    // Track persistence is an optimization; live capture remains available.
  }
}

export async function deleteSharedSubtitleTrack(key: string): Promise<void> {
  const epoch = cacheEpochByKey.get(key);
  if (epoch === undefined) return;
  try {
    await browser.runtime.sendMessage({
      type: "SUBTITLE_TRACK_DELETE",
      key,
      epoch,
    });
  } catch {
    // Track persistence is an optimization; live capture remains authoritative.
  }
}
