import { beforeEach, describe, expect, it, vi } from "vitest";

const browserState = vi.hoisted<{ stored: Record<string, unknown> }>(() => ({
  stored: {},
}));

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: {
      getUILanguage: () => "en-US",
    },
    storage: {
      local: {
        get: vi.fn((key: string) =>
          Promise.resolve(
            key in browserState.stored
              ? { [key]: browserState.stored[key] }
              : {},
          ),
        ),
        set: vi.fn((values: Record<string, unknown>) => {
          Object.assign(browserState.stored, values);
          return Promise.resolve();
        }),
        remove: vi.fn((key: string) => {
          delete browserState.stored[key];
          return Promise.resolve();
        }),
      },
    },
  },
}));

const tokenPayload = (accessToken: string, refreshToken: string) => ({
  access_token: accessToken,
  refresh_token: refreshToken,
  token_type: "Bearer",
  expires_in: 3_600,
  scope: "account:read translation:use",
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof URLSearchParams) return init.body.toString();
  throw new Error("expected a form-encoded request body");
}

describe("Norixor APP session", () => {
  beforeEach(() => {
    browserState.stored = {};
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("stores only the APP token session and never exposes tokens in auth state", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(tokenPayload("access-one", "refresh-one")),
      );
    const { loginToNorixor, norixorAuthState } =
      await import("@/src/norixor/session");

    await expect(
      loginToNorixor("reader@example.com", "not-persisted-password"),
    ).resolves.toEqual({ state: "signed-in" });
    await expect(norixorAuthState()).resolves.toEqual({ state: "signed-in" });

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe("https://api.norixor.org/apps/noritrans/auth/login");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept-Language": "en-US",
    });
    expect(bodyText(init)).toBe(
      "username=reader%40example.com&password=not-persisted-password",
    );
    expect(Object.keys(browserState.stored)).toEqual(["norixorAuthSession"]);
    expect(browserState.stored.norixorAuthSession).toMatchObject({
      kind: "tokens",
      accessToken: "access-one",
      refreshToken: "refresh-one",
      tokenType: "Bearer",
    });
    expect(JSON.stringify(browserState.stored)).not.toContain(
      "not-persisted-password",
    );
  });

  it("keeps an email or MFA challenge background-only until completion", async () => {
    const challengeToken = "a".repeat(43);
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          challengeType: "emailVerification",
          challengeToken,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(tokenPayload("challenge-access", "challenge-refresh")),
      );
    const { completeNorixorChallenge, loginToNorixor, norixorAuthState } =
      await import("@/src/norixor/session");

    await expect(
      loginToNorixor("reader@example.com", "secret"),
    ).resolves.toEqual({
      state: "challenge",
      challengeType: "emailVerification",
    });
    const publicState = await norixorAuthState();
    expect(publicState).toEqual({
      state: "challenge",
      challengeType: "emailVerification",
    });
    expect(publicState).not.toHaveProperty("challengeToken");

    await expect(completeNorixorChallenge("123456")).resolves.toEqual({
      state: "signed-in",
    });
    const [url, init] = request.mock.calls[1] ?? [];
    expect(url).toBe(
      "https://api.norixor.org/apps/noritrans/auth/email-verification",
    );
    expect(bodyText(init)).toBe(
      `challenge_token=${challengeToken}&code=123456`,
    );
  });

  it("rotates refresh tokens and retries one unauthorized APP request", async () => {
    browserState.stored.norixorAuthSession = {
      kind: "tokens",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "Bearer",
      expiresAt: Date.now() + 300_000,
    };
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse(tokenPayload("new-access", "new-refresh")),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const { authorizedNorixorFetch } = await import("@/src/norixor/session");

    const response = await authorizedNorixorFetch("/native/account", {
      method: "GET",
    });

    expect(response.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    const initialHeaders = new Headers(request.mock.calls[0]?.[1]?.headers);
    const retryHeaders = new Headers(request.mock.calls[2]?.[1]?.headers);
    expect(initialHeaders.get("Authorization")).toBe("Bearer old-access");
    expect(retryHeaders.get("Authorization")).toBe("Bearer new-access");
    expect(bodyText(request.mock.calls[1]?.[1])).toBe(
      "grant_type=refresh_token&refresh_token=old-refresh",
    );
    expect(browserState.stored.norixorAuthSession).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
  });

  it("normalizes the exact account and quota projection returned by the APP", async () => {
    browserState.stored.norixorAuthSession = {
      kind: "tokens",
      accessToken: "account-access",
      refreshToken: "account-refresh",
      tokenType: "Bearer",
      expiresAt: Date.now() + 300_000,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: {
          account: {
            username: "member@example.com",
            email: "member@example.com",
            email_verified: true,
          },
          membership: { status: "active" },
          translation: {
            available: true,
            quota: {
              unit: "requests",
              limits: [
                {
                  period: "month",
                  limit: 10_000,
                  used: 250,
                  remaining: 9_750,
                  reset_at: "2026-10-01T00:00:00Z",
                },
                {
                  period: "day",
                  limit: 1_000,
                  used: 125,
                  remaining: 875,
                  reset_at: "2026-09-04T00:00:00Z",
                },
              ],
            },
          },
        },
      }),
    );
    const { norixorAuthState } = await import("@/src/norixor/session");

    await expect(norixorAuthState(true)).resolves.toEqual({
      state: "signed-in",
      account: {
        displayName: "member@example.com",
        email: "member@example.com",
        membershipStatus: "active",
        translationEnabled: true,
        quota: {
          limit: 1_000,
          used: 125,
          remaining: 875,
          resetAt: "2026-09-04T00:00:00Z",
        },
      },
    });
  });

  it("parses the authenticated model catalog and privacy-minimized usage summary", async () => {
    browserState.stored.norixorAuthSession = {
      kind: "tokens",
      accessToken: "overview-access",
      refreshToken: "overview-refresh",
      tokenType: "Bearer",
      expiresAt: Date.now() + 300_000,
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            default_model: "deepseek-v4-flash",
            models: [
              {
                id: "deepseek-v4-flash",
                display_name: "DeepSeek V4 Flash",
              },
              { id: "gpt-5.6-luna", display_name: "GPT-5.6 Luna" },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            currency: "USD",
            precision: 8,
            timezone: "Asia/Shanghai",
            generated_at: "2026-09-03T12:00:00+08:00",
            balance: {
              available_regular_usd: "12.50000000",
              available_gift_usd: "1.25000000",
            },
            periods: {
              today: {
                start_at: "2026-09-03T00:00:00+08:00",
                end_at: "2026-09-03T12:00:00+08:00",
                successful_requests: 3,
                source_characters: 420,
                cost_usd: "0.00420000",
              },
              last_30_days: {
                start_at: "2026-08-05T00:00:00+08:00",
                end_at: "2026-09-03T12:00:00+08:00",
                successful_requests: 18,
                source_characters: 9_400,
                cost_usd: "0.09400000",
              },
            },
          },
        }),
      );
    const { fetchNorixorModelCatalog, fetchNorixorUsageSummary } =
      await import("@/src/norixor/session");

    await expect(fetchNorixorModelCatalog()).resolves.toEqual({
      defaultModel: "deepseek-v4-flash",
      models: [
        { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
        { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
      ],
    });
    await expect(fetchNorixorUsageSummary()).resolves.toMatchObject({
      balance: {
        availableRegularUsd: "12.50000000",
        availableGiftUsd: "1.25000000",
      },
      periods: {
        today: {
          successfulRequests: 3,
          sourceCharacters: 420,
          costUsd: "0.00420000",
        },
        last30Days: {
          successfulRequests: 18,
          sourceCharacters: 9_400,
          costUsd: "0.09400000",
        },
      },
    });
  });

  it("completes local logout even when token revocation is unavailable", async () => {
    browserState.stored.norixorAuthSession = {
      kind: "tokens",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: Date.now() + 300_000,
    };
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const { logoutFromNorixor, norixorAuthState } =
      await import("@/src/norixor/session");

    await expect(logoutFromNorixor()).resolves.toBeUndefined();
    await expect(norixorAuthState()).resolves.toEqual({ state: "signed-out" });
    expect(browserState.stored).toEqual({});
  });
});
