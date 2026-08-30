import { browser } from "wxt/browser";

const RELEASES_LATEST_URLS = [
  "https://api.github.com/repos/Norixor/NoriTrans/releases/latest",
  "https://api.github.com/repos/Norixor/nTrans/releases/latest",
  "https://api.github.com/repos/Norixor/NorixorTrans/releases/latest",
] as const;
const RELEASE_PAGE_PREFIXES = [
  "https://github.com/Norixor/NoriTrans/releases/tag/",
  "https://github.com/Norixor/nTrans/releases/tag/",
  "https://github.com/Norixor/NorixorTrans/releases/tag/",
] as const;
const UPDATE_STATE_KEY = "norixortrans:update-state-v1";
const UPDATE_PREFERENCES_KEY = "norixortrans:update-preferences-v1";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 8_000;

export type ExtensionUpdateState =
  "never" | "current" | "available" | "ignored" | "error";

export interface ExtensionUpdateStatus {
  ok: true;
  state: ExtensionUpdateState;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt?: number;
  autoCheckEnabled: boolean;
  errorCode?: "request_failed" | "invalid_response";
}

interface StoredUpdateState {
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt?: number;
  errorCode?: ExtensionUpdateStatus["errorCode"];
}

interface StoredUpdatePreferences {
  autoCheckEnabled: boolean;
  ignoredVersion?: string;
}

interface GithubLatestRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

const VERSION_PATTERN = /^v?\d{1,5}(?:\.\d{1,5}){1,3}$/u;
let inFlightCheck: Promise<ExtensionUpdateStatus> | undefined;

function normalizedVersion(value: string): string | undefined {
  const trimmed = value.trim();
  if (!VERSION_PATTERN.test(trimmed)) return undefined;
  const normalized = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  const parts = normalized.split(".").map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part > 65_535)) {
    return undefined;
  }
  return parts.join(".");
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReleasePageUrl(value: string): boolean {
  return (
    value.length <= 512 &&
    RELEASE_PAGE_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

function readStoredState(value: unknown): StoredUpdateState {
  if (!isRecord(value)) return {};
  const latestVersion =
    typeof value.latestVersion === "string"
      ? normalizedVersion(value.latestVersion)
      : undefined;
  const releaseUrl =
    typeof value.releaseUrl === "string" && isReleasePageUrl(value.releaseUrl)
      ? value.releaseUrl
      : undefined;
  const checkedAt =
    typeof value.checkedAt === "number" &&
    Number.isFinite(value.checkedAt) &&
    value.checkedAt > 0
      ? value.checkedAt
      : undefined;
  const errorCode =
    value.errorCode === "request_failed" ||
    value.errorCode === "invalid_response"
      ? value.errorCode
      : undefined;
  return {
    ...(latestVersion && releaseUrl ? { latestVersion, releaseUrl } : {}),
    ...(checkedAt ? { checkedAt } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

function readStoredPreferences(value: unknown): StoredUpdatePreferences {
  if (!isRecord(value)) return { autoCheckEnabled: true };
  const ignoredVersion =
    typeof value.ignoredVersion === "string"
      ? normalizedVersion(value.ignoredVersion)
      : undefined;
  return {
    autoCheckEnabled:
      typeof value.autoCheckEnabled === "boolean"
        ? value.autoCheckEnabled
        : true,
    ...(ignoredVersion ? { ignoredVersion } : {}),
  };
}

async function loadUpdateData(): Promise<{
  state: StoredUpdateState;
  preferences: StoredUpdatePreferences;
}> {
  const stored = await browser.storage.local.get([
    UPDATE_STATE_KEY,
    UPDATE_PREFERENCES_KEY,
  ]);
  return {
    state: readStoredState(stored[UPDATE_STATE_KEY]),
    preferences: readStoredPreferences(stored[UPDATE_PREFERENCES_KEY]),
  };
}

function publicStatus(
  state: StoredUpdateState,
  preferences: StoredUpdatePreferences,
): ExtensionUpdateStatus {
  const currentVersion = browser.runtime.getManifest().version;
  let status: ExtensionUpdateState = "never";
  if (state.latestVersion) {
    const updateAvailable =
      compareVersions(state.latestVersion, currentVersion) > 0;
    status = updateAvailable
      ? preferences.ignoredVersion === state.latestVersion
        ? "ignored"
        : "available"
      : state.errorCode
        ? "error"
        : "current";
  } else if (state.errorCode) {
    status = "error";
  }
  return {
    ok: true,
    state: status,
    currentVersion,
    ...(state.latestVersion ? { latestVersion: state.latestVersion } : {}),
    ...(state.releaseUrl ? { releaseUrl: state.releaseUrl } : {}),
    ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}),
    autoCheckEnabled: preferences.autoCheckEnabled,
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
  };
}

async function updateBadge(status: ExtensionUpdateStatus): Promise<void> {
  const available = status.state === "available";
  await browser.action.setBadgeText({ text: available ? "NEW" : "" });
  if (available) {
    await browser.action.setBadgeBackgroundColor({ color: "#b87912" });
  }
}

async function persistState(
  state: StoredUpdateState,
  preferences: StoredUpdatePreferences,
): Promise<ExtensionUpdateStatus> {
  await browser.storage.local.set({ [UPDATE_STATE_KEY]: state });
  const status = publicStatus(state, preferences);
  await updateBadge(status);
  return status;
}

function parseLatestRelease(value: unknown): {
  latestVersion: string;
  releaseUrl: string;
} | null {
  if (!isRecord(value)) return null;
  const release = value as GithubLatestRelease;
  if (release.draft !== false || release.prerelease !== false) return null;
  if (
    typeof release.tag_name !== "string" ||
    typeof release.html_url !== "string"
  ) {
    return null;
  }
  const latestVersion = normalizedVersion(release.tag_name);
  if (!latestVersion || !isReleasePageUrl(release.html_url)) {
    return null;
  }
  return { latestVersion, releaseUrl: release.html_url };
}

async function requestLatestRelease(): Promise<{
  latestVersion: string;
  releaseUrl: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let lastError: Error | undefined;
    for (const url of RELEASES_LATEST_URLS) {
      try {
        const response = await fetch(url, {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          lastError = new Error("request_failed");
          continue;
        }
        const parsed = parseLatestRelease(await response.json());
        if (!parsed) throw new Error("invalid_response");
        return parsed;
      } catch (error) {
        if (error instanceof Error && error.message === "invalid_response") {
          throw error;
        }
        lastError =
          error instanceof Error ? error : new Error("request_failed");
      }
    }
    throw lastError ?? new Error("request_failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function performCheck(force: boolean): Promise<ExtensionUpdateStatus> {
  const { state, preferences } = await loadUpdateData();
  if (!force && !preferences.autoCheckEnabled) {
    const status = publicStatus(state, preferences);
    await updateBadge(status);
    return status;
  }
  if (
    !force &&
    state.checkedAt &&
    Date.now() - state.checkedAt < CHECK_INTERVAL_MS
  ) {
    const status = publicStatus(state, preferences);
    await updateBadge(status);
    return status;
  }
  try {
    const latest = await requestLatestRelease();
    return persistState({ ...latest, checkedAt: Date.now() }, preferences);
  } catch (error) {
    const errorCode =
      error instanceof Error && error.message === "invalid_response"
        ? "invalid_response"
        : "request_failed";
    return persistState(
      {
        ...state,
        checkedAt: Date.now(),
        errorCode,
      },
      preferences,
    );
  }
}

export async function checkForUpdates(
  force = false,
): Promise<ExtensionUpdateStatus> {
  if (!inFlightCheck) {
    inFlightCheck = performCheck(force).finally(() => {
      inFlightCheck = undefined;
    });
  }
  return inFlightCheck;
}

export async function getUpdateStatus(): Promise<ExtensionUpdateStatus> {
  return checkForUpdates(false);
}

export async function setAutomaticUpdateChecks(
  enabled: boolean,
): Promise<ExtensionUpdateStatus> {
  const { state, preferences } = await loadUpdateData();
  const next = { ...preferences, autoCheckEnabled: enabled };
  await browser.storage.local.set({ [UPDATE_PREFERENCES_KEY]: next });
  if (enabled) return checkForUpdates(false);
  const status = publicStatus(state, next);
  await updateBadge(status);
  return status;
}

export async function ignoreUpdate(
  version: string,
): Promise<ExtensionUpdateStatus> {
  const normalized = normalizedVersion(version);
  const { state, preferences } = await loadUpdateData();
  const next = {
    ...preferences,
    ...(normalized && normalized === state.latestVersion
      ? { ignoredVersion: normalized }
      : {}),
  };
  await browser.storage.local.set({ [UPDATE_PREFERENCES_KEY]: next });
  const status = publicStatus(state, next);
  await updateBadge(status);
  return status;
}

export async function initializeUpdateChecker(): Promise<void> {
  await getUpdateStatus();
}
