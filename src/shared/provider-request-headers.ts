import { browser, type Browser } from "wxt/browser";
import type { AppSettings } from "@/src/shared/settings";

/**
 * Chrome adds `Origin: chrome-extension://<id>` to every POST the extension
 * sends. The extension is a server-to-server API client that relies on host
 * permissions rather than CORS, yet some OpenAI-compatible gateways refuse
 * credentialed requests that carry a browser origin (HTTP 403 "Origin is not
 * allowed for credentialed requests"). A session rule removes that header so
 * extension requests behave like curl or a server SDK.
 *
 * Scope is deliberately narrow: only requests initiated by this extension, to
 * cloud translation hosts it may call. Page requests to the same host keep
 * their Origin.
 */
export const PROVIDER_ORIGIN_RULE_ID = 1;

// Fixed machine-translation endpoints. Removing Origin from the extension's
// own requests to them is harmless, and covering all of them avoids tracking
// per-feature or per-site Provider overrides.
const FIXED_PROVIDER_HOSTS = [
  "translation.googleapis.com",
  "api.cognitive.microsofttranslator.com",
  "api.deepl.com",
  "api-free.deepl.com",
] as const;

export function providerRequestDomains(settings: AppSettings): string[] {
  const domains = new Set<string>(FIXED_PROVIDER_HOSTS);
  try {
    const { hostname } = new URL(settings.provider.baseUrl.trim());
    // URL keeps IPv6 brackets; requestDomains expects the bare host.
    const host = hostname.replace(/^\[|\]$/gu, "");
    if (host) domains.add(host);
  } catch {
    // An invalid Base URL cannot be requested, so it needs no rule.
  }
  return [...domains].sort();
}

export function providerOriginRule(
  domains: readonly string[],
  extensionId: string,
): Browser.declarativeNetRequest.Rule {
  return {
    id: PROVIDER_ORIGIN_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        {
          header: "origin",
          operation: "remove",
        },
      ],
    },
    condition: {
      initiatorDomains: [extensionId],
      requestDomains: [...domains],
      // Service-worker fetch() is reported as "xmlhttprequest"; "other"
      // covers offscreen-document and future request paths.
      resourceTypes: [
        "xmlhttprequest",
        "other",
      ] as Browser.declarativeNetRequest.ResourceType[],
    },
  };
}

type SessionRulesApi = Pick<
  typeof browser.declarativeNetRequest,
  "updateSessionRules"
>;

/**
 * Replaces the session rule for the current settings. Failure never blocks
 * translation: the request still goes out, and a gateway that rejects the
 * Origin is reported by the Provider diagnostics.
 */
export async function syncProviderOriginRule(
  settings: AppSettings,
  api: SessionRulesApi | undefined = browser.declarativeNetRequest,
  extensionId: string = browser.runtime.id,
): Promise<boolean> {
  if (!api?.updateSessionRules) return false;
  try {
    await api.updateSessionRules({
      removeRuleIds: [PROVIDER_ORIGIN_RULE_ID],
      addRules: [
        providerOriginRule(providerRequestDomains(settings), extensionId),
      ],
    });
    return true;
  } catch (error) {
    console.warn(
      "[NoriTrans][ProviderHeaders] origin_rule_sync_failed",
      error instanceof Error ? error.name : typeof error,
    );
    return false;
  }
}
