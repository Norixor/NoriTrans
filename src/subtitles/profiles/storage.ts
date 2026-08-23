import {
  isBuiltInProfileOverride,
  isUserSiteProfile,
  parseEditableSiteProfile,
} from "@/src/subtitles/profiles/registry";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import { browser } from "wxt/browser";

const STORAGE_KEY = "subtitleSiteProfiles";
const OVERRIDE_STORAGE_KEY = "subtitleSiteProfileOverrides";
const MAX_USER_PROFILES = 50;
const MAX_OVERRIDES = 50;

export async function loadUserSiteProfiles(): Promise<SubtitleSiteProfile[]> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  if (!Array.isArray(stored[STORAGE_KEY])) return [];
  return stored[STORAGE_KEY].filter((profile): profile is SubtitleSiteProfile =>
    isUserSiteProfile(profile),
  ).slice(0, MAX_USER_PROFILES);
}

export async function saveUserSiteProfile(
  profile: SubtitleSiteProfile,
  expectedHostname?: string,
): Promise<void> {
  let validated: SubtitleSiteProfile;
  try {
    validated = parseEditableSiteProfile(profile);
  } catch {
    throw new Error("无效或超出当前网站范围的字幕 Profile。");
  }
  if (!isUserSiteProfile(validated, expectedHostname)) {
    throw new Error("无效或超出当前网站范围的字幕 Profile。");
  }
  const profiles = await loadUserSiteProfiles();
  const next = [
    validated,
    ...profiles.filter((item) => item.id !== validated.id),
  ]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_USER_PROFILES);
  await browser.storage.local.set({ [STORAGE_KEY]: next });
}

export async function loadSiteProfileOverrides(): Promise<
  SubtitleSiteProfile[]
> {
  const stored = await browser.storage.local.get(OVERRIDE_STORAGE_KEY);
  if (!Array.isArray(stored[OVERRIDE_STORAGE_KEY])) return [];
  return stored[OVERRIDE_STORAGE_KEY].filter(
    (profile): profile is SubtitleSiteProfile =>
      isBuiltInProfileOverride(profile),
  ).slice(0, MAX_OVERRIDES);
}

export async function saveEditableSiteProfile(
  value: unknown,
): Promise<{ kind: "user" | "override"; profile: SubtitleSiteProfile }> {
  const profile = parseEditableSiteProfile(value);
  if (profile.id.startsWith("user-")) {
    await saveUserSiteProfile(profile);
    return { kind: "user", profile };
  }
  const overrides = await loadSiteProfileOverrides();
  const next = [
    profile,
    ...overrides.filter((candidate) => candidate.id !== profile.id),
  ]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_OVERRIDES);
  await browser.storage.local.set({ [OVERRIDE_STORAGE_KEY]: next });
  return { kind: "override", profile };
}

export async function deleteSiteProfileOverride(id: string): Promise<void> {
  const overrides = await loadSiteProfileOverrides();
  if (!overrides.some((profile) => profile.id === id)) {
    throw new Error("无效的内置 Profile 覆盖 ID。");
  }
  await browser.storage.local.set({
    [OVERRIDE_STORAGE_KEY]: overrides.filter((profile) => profile.id !== id),
  });
}

export async function loadRuntimeSiteProfiles(): Promise<
  SubtitleSiteProfile[]
> {
  const [profiles, overrides] = await Promise.all([
    loadUserSiteProfiles(),
    loadSiteProfileOverrides(),
  ]);
  return [...profiles, ...overrides];
}

export async function deleteUserSiteProfile(id: string): Promise<void> {
  if (!/^user-[a-z0-9-]{1,59}$/u.test(id)) {
    throw new Error("无效的字幕 Profile ID。");
  }
  const profiles = await loadUserSiteProfiles();
  await browser.storage.local.set({
    [STORAGE_KEY]: profiles.filter((profile) => profile.id !== id),
  });
}
