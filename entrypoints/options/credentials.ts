import { browser } from "wxt/browser";
import {
  isAllowedProviderBaseUrl,
  mergeSettings,
  type AppSettings,
  type FastProviderId,
  type ProviderSettings,
} from "@/src/shared/settings";

/**
 * Explicit "save" path for the provider group. Credentials, the AI endpoint
 * and the model never travel through `SETTINGS_PATCH`; they are written with
 * the existing `SETTINGS_SET` after the user clicks save. To keep the window
 * for overwriting a concurrent edit small, pending autosaves are flushed and
 * the freshest stored settings are read right before the write, and only the
 * provider fields of this form are replaced.
 */

/** Fields edited by the AI service form. */
export type AiProviderDraft = Pick<
  ProviderSettings,
  "aiProvider" | "baseUrl" | "apiKey" | "model" | "systemPrompt" | "timeoutMs"
>;

/** Key fields of the cloud fast providers. */
export type FastProviderDraft = Pick<
  ProviderSettings,
  | "googleApiKey"
  | "microsoftApiKey"
  | "microsoftRegion"
  | "deeplApiKey"
  | "deeplPlan"
>;

export type CredentialSaveCode =
  | "provider_saved"
  | "provider_url_invalid"
  | "provider_model_missing"
  | "provider_timeout_invalid"
  | "provider_prompt_missing"
  | "provider_permission_denied"
  | "provider_save_failed";

export type CredentialSaveResult =
  | { ok: true; code: "provider_saved"; settings: AppSettings }
  | { ok: false; code: Exclude<CredentialSaveCode, "provider_saved"> };

export type ConnectionTestResult =
  | { ok: true; code: "connection_succeeded" }
  | {
      ok: false;
      code: "connection_failed" | "connection_unreachable";
      /** Bounded, secret-free diagnostic from the background. */
      diagnostic?: string;
    };

export interface CredentialDeps {
  /** Writes pending autosaves first so they are not lost or reordered. */
  flushAutosave(): Promise<unknown>;
  loadSettings(): Promise<AppSettings>;
  /** Resolves true when the needed host permissions are granted. */
  requestPermission(settings: AppSettings): Promise<boolean>;
  sendMessage(message: unknown): Promise<unknown>;
}

export function validateAiDraft(
  draft: AiProviderDraft,
): Exclude<CredentialSaveCode, "provider_saved"> | undefined {
  if (!isAllowedProviderBaseUrl(draft.baseUrl)) return "provider_url_invalid";
  if (!draft.model.trim() || draft.model.length > 256) {
    return "provider_model_missing";
  }
  if (
    !Number.isFinite(draft.timeoutMs) ||
    draft.timeoutMs < 5_000 ||
    draft.timeoutMs > 180_000
  ) {
    return "provider_timeout_invalid";
  }
  if (!draft.systemPrompt.trim()) return "provider_prompt_missing";
  return undefined;
}

export function normalizeAiDraft(draft: AiProviderDraft): AiProviderDraft {
  return {
    aiProvider:
      draft.aiProvider === "anthropic-messages"
        ? "anthropic-messages"
        : "openai-compatible",
    baseUrl: draft.baseUrl.trim().replace(/\/$/u, ""),
    apiKey: draft.apiKey.trim(),
    model: draft.model.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    timeoutMs: Math.round(draft.timeoutMs),
  };
}

export function normalizeFastDraft(
  draft: FastProviderDraft,
): FastProviderDraft {
  return {
    googleApiKey: draft.googleApiKey.trim(),
    microsoftApiKey: draft.microsoftApiKey.trim(),
    microsoftRegion: draft.microsoftRegion.trim().slice(0, 128),
    deeplApiKey: draft.deeplApiKey.trim(),
    deeplPlan: draft.deeplPlan === "pro" ? "pro" : "free",
  };
}

function isOkResponse(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
}

/** Saves provider fields through the explicit `SETTINGS_SET` path. */
export async function saveProviderFields(
  fields: Partial<ProviderSettings>,
  deps: CredentialDeps,
): Promise<CredentialSaveResult> {
  if (
    fields.baseUrl !== undefined &&
    !isAllowedProviderBaseUrl(fields.baseUrl)
  ) {
    return { ok: false, code: "provider_url_invalid" };
  }
  try {
    await deps.flushAutosave();
    const current = await deps.loadSettings();
    const next = mergeSettings({
      ...current,
      provider: { ...current.provider, ...fields },
    });
    if (!(await deps.requestPermission(next))) {
      return { ok: false, code: "provider_permission_denied" };
    }
    const response = await deps.sendMessage({
      type: "SETTINGS_SET",
      settings: next,
    });
    if (!isOkResponse(response)) {
      return { ok: false, code: "provider_save_failed" };
    }
    return { ok: true, code: "provider_saved", settings: next };
  } catch {
    return { ok: false, code: "provider_save_failed" };
  }
}

/** Runs the existing background connection test against stored settings. */
export async function testProviderConnection(
  deps: Pick<CredentialDeps, "sendMessage">,
): Promise<ConnectionTestResult> {
  let response: unknown;
  try {
    response = await deps.sendMessage({ type: "TEST_CONNECTION" });
  } catch {
    return { ok: false, code: "connection_unreachable" };
  }
  if (
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    typeof response.ok !== "boolean"
  ) {
    return { ok: false, code: "connection_unreachable" };
  }
  if (response.ok) return { ok: true, code: "connection_succeeded" };
  const diagnostic =
    "message" in response && typeof response.message === "string"
      ? response.message.trim().slice(0, 2_000)
      : "";
  return {
    ok: false,
    code: "connection_failed",
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/** Host origins a provider configuration needs (beyond `https://*\/*`). */
export function providerPermissionOrigins(settings: AppSettings): string[] {
  const origins = new Set<string>();
  try {
    origins.add(`${new URL(settings.provider.baseUrl).origin}/*`);
  } catch {
    // Validated before; an invalid URL simply adds no origin.
  }
  for (const origin of fastProviderOrigins(
    settings.provider.fastProvider,
    settings.provider.deeplPlan,
  )) {
    origins.add(origin);
  }
  return [...origins];
}

export function fastProviderOrigins(
  provider: FastProviderId,
  deeplPlan: ProviderSettings["deeplPlan"],
): string[] {
  switch (provider) {
    case "google-translate":
      return ["https://translation.googleapis.com/*"];
    case "microsoft-translator":
      return ["https://api.cognitive.microsofttranslator.com/*"];
    case "deepl":
      return [
        deeplPlan === "pro"
          ? "https://api.deepl.com/*"
          : "https://api-free.deepl.com/*",
      ];
    default:
      return [];
  }
}

/** Requests `origins`; a thrown request (no user gesture) counts as denied. */
export async function requestOrigins(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return true;
  try {
    return await browser.permissions.request({ origins });
  } catch {
    return false;
  }
}

/** Optional permission that lets OCR capture the visible tab. */
export async function requestOcrCapturePermission(): Promise<boolean> {
  try {
    return await browser.permissions.request({ origins: ["<all_urls>"] });
  } catch {
    return false;
  }
}

export const LOCAL_PROVIDER_ORIGINS = [
  "http://localhost/*",
  "http://127.0.0.1/*",
] as const;
