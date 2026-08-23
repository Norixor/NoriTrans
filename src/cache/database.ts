import { type DBSchema, type IDBPDatabase, openDB } from "idb";

export interface TranslationCacheRow {
  key: string;
  translatedText: string;
  updatedAt: number;
}

export interface SubtitleTrackRow {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface TranslationJobRow {
  id: string;
  state: "running" | "paused" | "cancelled" | "completed" | "partial";
  total: number;
  completed: number;
  failed: number;
  value: unknown;
  updatedAt: number;
}

interface NorixorTransDatabase extends DBSchema {
  translations: {
    key: string;
    value: TranslationCacheRow;
    indexes: { "by-updated-at": number };
  };
  subtitleTracks: {
    key: string;
    value: SubtitleTrackRow;
    indexes: { "by-updated-at": number };
  };
  jobs: {
    key: string;
    value: TranslationJobRow;
    indexes: { "by-updated-at": number };
  };
}

let databasePromise: Promise<IDBPDatabase<NorixorTransDatabase>> | undefined;

export function getDatabase(): Promise<IDBPDatabase<NorixorTransDatabase>> {
  databasePromise ??= openDB<NorixorTransDatabase>("norixortrans", 1, {
    upgrade(database) {
      const translations = database.createObjectStore("translations", {
        keyPath: "key",
      });
      translations.createIndex("by-updated-at", "updatedAt");

      const subtitleTracks = database.createObjectStore("subtitleTracks", {
        keyPath: "key",
      });
      subtitleTracks.createIndex("by-updated-at", "updatedAt");

      const jobs = database.createObjectStore("jobs", { keyPath: "id" });
      jobs.createIndex("by-updated-at", "updatedAt");
    },
  });
  return databasePromise;
}

export async function getCachedTranslation(
  key: string,
): Promise<string | undefined> {
  const row = await (await getDatabase()).get("translations", key);
  return row?.translatedText;
}

export async function setCachedTranslation(
  key: string,
  translatedText: string,
): Promise<void> {
  await (
    await getDatabase()
  ).put("translations", {
    key,
    translatedText,
    updatedAt: Date.now(),
  });
}

export async function getSubtitleTrack<T>(key: string): Promise<T | undefined> {
  const row = await (await getDatabase()).get("subtitleTracks", key);
  return row?.value as T | undefined;
}

export async function setSubtitleTrack<T>(
  key: string,
  value: T,
): Promise<void> {
  await (
    await getDatabase()
  ).put("subtitleTracks", {
    key,
    value,
    updatedAt: Date.now(),
  });
}

export async function deleteSubtitleTrack(key: string): Promise<void> {
  await (await getDatabase()).delete("subtitleTracks", key);
}

export async function getTranslationJob<T>(
  id: string,
): Promise<(TranslationJobRow & { value: T }) | undefined> {
  const row = await (await getDatabase()).get("jobs", id);
  return row as (TranslationJobRow & { value: T }) | undefined;
}

export async function setTranslationJob<T>(
  row: Omit<TranslationJobRow, "updatedAt" | "value"> & { value: T },
): Promise<void> {
  await (
    await getDatabase()
  ).put("jobs", {
    ...row,
    updatedAt: Date.now(),
  });
}

export async function clearCache(): Promise<void> {
  const database = await getDatabase();
  const transaction = database.transaction(
    ["translations", "subtitleTracks", "jobs"],
    "readwrite",
  );
  await Promise.all([
    transaction.objectStore("translations").clear(),
    transaction.objectStore("subtitleTracks").clear(),
    transaction.objectStore("jobs").clear(),
    transaction.done,
  ]);
}

export async function cacheStats(): Promise<{
  translations: number;
  subtitleTracks: number;
  jobs: number;
}> {
  const database = await getDatabase();
  const [translations, subtitleTracks, jobs] = await Promise.all([
    database.count("translations"),
    database.count("subtitleTracks"),
    database.count("jobs"),
  ]);
  return { translations, subtitleTracks, jobs };
}
