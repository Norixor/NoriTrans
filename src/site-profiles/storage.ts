import type { SiteTranslationProfile } from "@/src/site-profiles/types";
import {
  isSiteTranslationProfile,
  parseSiteTranslationProfile,
} from "@/src/site-profiles/validation";
import { browser } from "wxt/browser";

const STORAGE_KEY = "siteTranslationProfiles";
const MAX_PROFILES = 100;

export async function loadSiteTranslationProfiles(): Promise<
  SiteTranslationProfile[]
> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  if (!Array.isArray(stored[STORAGE_KEY])) return [];
  return stored[STORAGE_KEY].filter(isSiteTranslationProfile).slice(
    0,
    MAX_PROFILES,
  );
}

export async function saveSiteTranslationProfile(
  value: unknown,
): Promise<SiteTranslationProfile> {
  const profile = parseSiteTranslationProfile(value);
  const profiles = await loadSiteTranslationProfiles();
  const next = [
    profile,
    ...profiles.filter((candidate) => candidate.id !== profile.id),
  ]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_PROFILES);
  await browser.storage.local.set({ [STORAGE_KEY]: next });
  return profile;
}

export async function deleteSiteTranslationProfile(id: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id))
    throw new Error("invalid_site_translation_profile_id");
  const profiles = await loadSiteTranslationProfiles();
  await browser.storage.local.set({
    [STORAGE_KEY]: profiles.filter((profile) => profile.id !== id),
  });
}
