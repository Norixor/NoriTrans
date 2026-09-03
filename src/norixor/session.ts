import type {
  NorixorAccountSummary,
  NorixorAuthErrorCode,
  NorixorAuthState,
  NorixorChallengeType,
  NorixorModelCatalog,
  NorixorUsagePeriod,
  NorixorUsageSummary,
} from "@/src/norixor/types";
import { browser } from "wxt/browser";

const API_ORIGIN = "https://api.norixor.org";
const API_ROOT = `${API_ORIGIN}/apps/noritrans`;
const SESSION_STORAGE_KEY = "norixorAuthSession";
const REFRESH_SKEW_MS = 60_000;

interface StoredTokenSession {
  kind: "tokens";
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresAt: number;
}

interface StoredChallengeSession {
  kind: "challenge";
  challengeType: NorixorChallengeType;
  challengeToken: string;
}

type StoredSession = StoredTokenSession | StoredChallengeSession;

interface TokenPayload {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface ChallengePayload {
  challengeType: NorixorChallengeType;
  challengeToken: string;
}

export class NorixorSessionError extends Error {
  constructor(
    readonly code: NorixorAuthErrorCode,
    message?: string,
  ) {
    super(message || code);
    this.name = "NorixorSessionError";
  }
}

let refreshInFlight: Promise<StoredTokenSession> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChallengeType(value: unknown): value is NorixorChallengeType {
  return value === "emailVerification" || value === "mfa";
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!isRecord(value)) return false;
  if (value.kind === "challenge") {
    return (
      isChallengeType(value.challengeType) &&
      typeof value.challengeToken === "string" &&
      /^[A-Za-z0-9_-]{43}$/u.test(value.challengeToken)
    );
  }
  return (
    value.kind === "tokens" &&
    typeof value.accessToken === "string" &&
    value.accessToken.length > 0 &&
    value.accessToken.length <= 16_384 &&
    typeof value.refreshToken === "string" &&
    value.refreshToken.length > 0 &&
    value.refreshToken.length <= 512 &&
    value.tokenType === "Bearer" &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt)
  );
}

async function loadSession(): Promise<StoredSession | undefined> {
  const stored = await browser.storage.local.get(SESSION_STORAGE_KEY);
  return isStoredSession(stored[SESSION_STORAGE_KEY])
    ? stored[SESSION_STORAGE_KEY]
    : undefined;
}

async function saveSession(session: StoredSession): Promise<void> {
  await browser.storage.local.set({ [SESSION_STORAGE_KEY]: session });
}

export async function clearNorixorSession(): Promise<void> {
  refreshInFlight = undefined;
  await browser.storage.local.remove(SESSION_STORAGE_KEY);
}

function tokenPayload(value: unknown): TokenPayload | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.access_token !== "string" ||
    value.access_token.length === 0 ||
    value.access_token.length > 16_384 ||
    typeof value.refresh_token !== "string" ||
    value.refresh_token.length === 0 ||
    value.refresh_token.length > 512 ||
    value.token_type !== "Bearer" ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in < 60 ||
    value.expires_in > 86_400 ||
    (value.scope !== undefined &&
      (typeof value.scope !== "string" || value.scope.length > 512))
  ) {
    return undefined;
  }
  return value as unknown as TokenPayload;
}

function challengePayload(value: unknown): ChallengePayload | undefined {
  if (!isRecord(value)) return undefined;
  return isChallengeType(value.challengeType) &&
    typeof value.challengeToken === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(value.challengeToken)
    ? (value as unknown as ChallengePayload)
    : undefined;
}

function stableErrorCode(value: unknown): NorixorAuthErrorCode {
  switch (value) {
    case "invalid_request":
    case "invalid_grant":
    case "unsupported_grant_type":
    case "unsupported_token_type":
    case "rate_limited":
    case "temporarily_unavailable":
      return value;
    default:
      return "temporarily_unavailable";
  }
}

async function parseFailure(response: Response): Promise<never> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const record = isRecord(payload) ? payload : undefined;
  const code = stableErrorCode(record?.error);
  const description =
    typeof record?.error_description === "string"
      ? record.error_description.replace(/\s+/gu, " ").trim().slice(0, 240)
      : undefined;
  throw new NorixorSessionError(code, description);
}

async function postForm(
  path: string,
  fields: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(`${API_ROOT}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "Accept-Language": browser.i18n.getUILanguage(),
    },
    body: new URLSearchParams(fields),
    cache: "no-store",
  });
  if (!response.ok) return parseFailure(response);
  try {
    return await response.json();
  } catch {
    throw new NorixorSessionError(
      "temporarily_unavailable",
      "NoriTrans login returned an invalid response.",
    );
  }
}

async function acceptAuthPayload(payload: unknown): Promise<NorixorAuthState> {
  const tokens = tokenPayload(payload);
  if (tokens) {
    const session: StoredTokenSession = {
      kind: "tokens",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: "Bearer",
      expiresAt: Date.now() + tokens.expires_in * 1_000,
    };
    await saveSession(session);
    return { state: "signed-in" };
  }
  const challenge = challengePayload(payload);
  if (challenge) {
    await saveSession({
      kind: "challenge",
      challengeType: challenge.challengeType,
      challengeToken: challenge.challengeToken,
    });
    return { state: "challenge", challengeType: challenge.challengeType };
  }
  throw new NorixorSessionError(
    "temporarily_unavailable",
    "NoriTrans login returned an invalid response.",
  );
}

export async function loginToNorixor(
  username: string,
  password: string,
): Promise<NorixorAuthState> {
  return acceptAuthPayload(
    await postForm("/auth/login", { username, password }),
  );
}

export async function registerWithNorixor(
  username: string,
  password: string,
  displayName?: string,
): Promise<NorixorAuthState> {
  return acceptAuthPayload(
    await postForm("/auth/register", {
      username,
      password,
      ...(displayName?.trim() ? { display_name: displayName.trim() } : {}),
    }),
  );
}

export async function completeNorixorChallenge(
  code: string,
): Promise<NorixorAuthState> {
  const session = await loadSession();
  if (!session || session.kind !== "challenge") {
    throw new NorixorSessionError(
      "invalid_grant",
      "No login challenge is active.",
    );
  }
  return acceptAuthPayload(
    await postForm(
      session.challengeType === "mfa"
        ? "/auth/mfa"
        : "/auth/email-verification",
      { challenge_token: session.challengeToken, code },
    ),
  );
}

async function refreshTokenSession(
  session: StoredTokenSession,
): Promise<StoredTokenSession> {
  const payload = tokenPayload(
    await postForm("/auth/token", {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
  );
  if (!payload) {
    throw new NorixorSessionError(
      "temporarily_unavailable",
      "NoriTrans token refresh returned an invalid response.",
    );
  }
  const refreshed: StoredTokenSession = {
    kind: "tokens",
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    tokenType: "Bearer",
    expiresAt: Date.now() + payload.expires_in * 1_000,
  };
  await saveSession(refreshed);
  return refreshed;
}

async function currentTokenSession(
  forceRefresh = false,
): Promise<StoredTokenSession> {
  const session = await loadSession();
  if (!session || session.kind !== "tokens") {
    throw new NorixorSessionError("signed_out", "Sign in to Norixor first.");
  }
  if (!forceRefresh && session.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return session;
  }
  if (!refreshInFlight) {
    const refreshing = refreshTokenSession(session);
    const shared = refreshing.finally(() => {
      if (refreshInFlight === shared) refreshInFlight = undefined;
    });
    refreshInFlight = shared;
  }
  try {
    return await refreshInFlight;
  } catch (error) {
    await clearNorixorSession();
    throw error;
  }
}

export async function norixorAuthState(
  includeAccount = false,
): Promise<NorixorAuthState> {
  const session = await loadSession();
  if (!session) return { state: "signed-out" };
  if (session.kind === "challenge") {
    return { state: "challenge", challengeType: session.challengeType };
  }
  if (!includeAccount) return { state: "signed-in" };
  try {
    const response = await authorizedNorixorFetch("/native/account", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      return response.status === 401
        ? { state: "signed-out" }
        : { state: "signed-in" };
    }
    const payload: unknown = await response.json();
    const account = normalizeAccountSummary(payload);
    return {
      state: "signed-in",
      ...(account ? { account } : {}),
    };
  } catch {
    return { state: "signed-in" };
  }
}

export async function logoutFromNorixor(): Promise<void> {
  const session = await loadSession();
  await clearNorixorSession();
  if (!session || session.kind !== "tokens") return;
  try {
    await postForm("/auth/revoke", {
      token: session.refreshToken,
      token_type_hint: "refresh_token",
    });
  } catch {
    // Local sign-out remains complete even when remote revocation is unavailable.
  }
}

export async function authorizedNorixorFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const request = async (forceRefresh: boolean): Promise<Response> => {
    const session = await currentTokenSession(forceRefresh);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `${session.tokenType} ${session.accessToken}`);
    return fetch(`${API_ROOT}${path}`, { ...init, headers });
  };
  const response = await request(false);
  if (response.status !== 401) return response;
  const retried = await request(true);
  if (retried.status === 401) await clearNorixorSession();
  return retried;
}

export async function fetchNorixorModelCatalog(): Promise<NorixorModelCatalog> {
  const response = await authorizedNorixorFetch("/native/models", {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) return parseFailure(response);
  const payload: unknown = await response.json();
  const data =
    isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
  if (
    !data ||
    typeof data.default_model !== "string" ||
    !Array.isArray(data.models)
  ) {
    throw new NorixorSessionError(
      "temporarily_unavailable",
      "NoriTrans model catalog returned an invalid response.",
    );
  }
  const models = data.models.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(candidate.id) ||
      typeof candidate.display_name !== "string" ||
      candidate.display_name.trim().length === 0 ||
      candidate.display_name.length > 128
    ) {
      return [];
    }
    return [{ id: candidate.id, displayName: candidate.display_name.trim() }];
  });
  if (
    models.length === 0 ||
    new Set(models.map(({ id }) => id)).size !== models.length ||
    !models.some(({ id }) => id === data.default_model)
  ) {
    throw new NorixorSessionError(
      "temporarily_unavailable",
      "NoriTrans model catalog returned an invalid response.",
    );
  }
  return { defaultModel: data.default_model, models };
}

function usagePeriod(value: unknown): NorixorUsagePeriod | undefined {
  if (!isRecord(value)) return undefined;
  const money = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^\d+(?:\.\d{1,18})?$/u.test(candidate);
  if (
    typeof value.start_at !== "string" ||
    value.start_at.length === 0 ||
    value.start_at.length > 128 ||
    typeof value.end_at !== "string" ||
    value.end_at.length === 0 ||
    value.end_at.length > 128 ||
    typeof value.successful_requests !== "number" ||
    !Number.isSafeInteger(value.successful_requests) ||
    value.successful_requests < 0 ||
    typeof value.source_characters !== "number" ||
    !Number.isSafeInteger(value.source_characters) ||
    value.source_characters < 0 ||
    !money(value.cost_usd)
  ) {
    return undefined;
  }
  return {
    startAt: value.start_at,
    endAt: value.end_at,
    successfulRequests: value.successful_requests,
    sourceCharacters: value.source_characters,
    costUsd: value.cost_usd,
  };
}

export async function fetchNorixorUsageSummary(): Promise<NorixorUsageSummary> {
  const response = await authorizedNorixorFetch("/native/usage", {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) return parseFailure(response);
  const payload: unknown = await response.json();
  const data =
    isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
  const balance = data && isRecord(data.balance) ? data.balance : undefined;
  const periods = data && isRecord(data.periods) ? data.periods : undefined;
  const today = usagePeriod(periods?.today);
  const last30Days = usagePeriod(periods?.last_30_days);
  const money = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^\d+(?:\.\d{1,18})?$/u.test(candidate);
  if (
    !data ||
    data.currency !== "USD" ||
    typeof data.timezone !== "string" ||
    data.timezone.length === 0 ||
    data.timezone.length > 128 ||
    typeof data.generated_at !== "string" ||
    data.generated_at.length === 0 ||
    data.generated_at.length > 128 ||
    !balance ||
    !money(balance.available_regular_usd) ||
    !money(balance.available_gift_usd) ||
    !today ||
    !last30Days
  ) {
    throw new NorixorSessionError(
      "temporarily_unavailable",
      "NoriTrans usage summary returned an invalid response.",
    );
  }
  return {
    currency: "USD",
    timezone: data.timezone,
    generatedAt: data.generated_at,
    balance: {
      availableRegularUsd: balance.available_regular_usd,
      availableGiftUsd: balance.available_gift_usd,
    },
    periods: { today, last30Days },
  };
}

function normalizeAccountSummary(
  value: unknown,
): NorixorAccountSummary | undefined {
  if (!isRecord(value)) return undefined;
  const data = isRecord(value.data) ? value.data : value;
  const account = isRecord(data.account) ? data.account : data;
  const membership = isRecord(data.membership) ? data.membership : undefined;
  const grant = isRecord(data.translation) ? data.translation : undefined;
  const quota = isRecord(data.quota)
    ? data.quota
    : isRecord(grant?.quota)
      ? grant.quota
      : undefined;
  const numberOrNull = (candidate: unknown): number | null =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : null;
  const stringOrUndefined = (candidate: unknown): string | undefined =>
    typeof candidate === "string" && candidate.trim().length > 0
      ? candidate.trim().slice(0, 256)
      : undefined;
  const displayName = stringOrUndefined(
    account.display_name ?? account.name ?? account.username,
  );
  const email = stringOrUndefined(account.email);
  const membershipStatus = stringOrUndefined(membership?.status);
  const translationEnabled =
    typeof grant?.available === "boolean"
      ? grant.available
      : typeof grant?.enabled === "boolean"
        ? grant.enabled
        : undefined;
  const limits = Array.isArray(quota?.limits)
    ? quota.limits.filter(isRecord)
    : [];
  const primaryQuota =
    limits.find((limit) => limit.period === "day") ?? limits[0] ?? quota;
  const summary: NorixorAccountSummary = {
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    ...(membershipStatus ? { membershipStatus } : {}),
    ...(translationEnabled !== undefined ? { translationEnabled } : {}),
    ...(primaryQuota
      ? {
          quota: {
            limit: numberOrNull(primaryQuota.limit),
            used: numberOrNull(primaryQuota.used),
            remaining: numberOrNull(primaryQuota.remaining),
            resetAt:
              typeof primaryQuota.reset_at === "string"
                ? primaryQuota.reset_at.slice(0, 128)
                : null,
          },
        }
      : {}),
  };
  return Object.values(summary).some((item) => item !== undefined)
    ? summary
    : undefined;
}
