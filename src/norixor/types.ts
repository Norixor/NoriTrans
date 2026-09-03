export type NorixorChallengeType = "emailVerification" | "mfa";

export type NorixorAuthState =
  | { state: "signed-out" }
  | { state: "challenge"; challengeType: NorixorChallengeType }
  | {
      state: "signed-in";
      account?: NorixorAccountSummary;
    };

export interface NorixorAccountSummary {
  displayName?: string;
  email?: string;
  membershipStatus?: string;
  translationEnabled?: boolean;
  quota?: {
    limit: number | null;
    used: number | null;
    remaining: number | null;
    resetAt: string | null;
  };
}

export interface NorixorModelOption {
  id: string;
  displayName: string;
}

export interface NorixorModelCatalog {
  defaultModel: string;
  models: NorixorModelOption[];
}

export interface NorixorUsagePeriod {
  startAt: string;
  endAt: string;
  successfulRequests: number;
  sourceCharacters: number;
  costUsd: string;
}

export interface NorixorUsageSummary {
  currency: "USD";
  timezone: string;
  generatedAt: string;
  balance: {
    availableRegularUsd: string;
    availableGiftUsd: string;
  };
  periods: {
    today: NorixorUsagePeriod;
    last30Days: NorixorUsagePeriod;
  };
}

export type NorixorAuthErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "unsupported_grant_type"
  | "unsupported_token_type"
  | "rate_limited"
  | "temporarily_unavailable"
  | "signed_out";

export interface NorixorAuthFailure {
  ok: false;
  error: NorixorAuthErrorCode;
  message?: string;
}

export interface NorixorAuthSuccess {
  ok: true;
  auth: NorixorAuthState;
}

export type NorixorAuthResponse = NorixorAuthSuccess | NorixorAuthFailure;
