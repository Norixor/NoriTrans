declare global {
  interface ImportMetaEnv {
    readonly WXT_NORIXORTRANS_SITE_DIAGNOSTICS?: string;
  }
}

export function siteDiagnosticsEnabled(): boolean {
  return import.meta.env.WXT_NORIXORTRANS_SITE_DIAGNOSTICS === "1";
}

/** Emits bounded site diagnostics only for explicitly opted-in development builds. */
export function siteDiagnostic(
  site: "Netflix" | "YouTube",
  event: string,
  detail: Readonly<Record<string, unknown>>,
): void {
  if (!siteDiagnosticsEnabled()) return;
  console.info(`[NorixorTrans][${site}] ${event}`, detail);
}

export type TranslationDiagnosticScope = "ChromeTranslator" | "PageTranslation";

export interface TranslationRuntimeDiagnosticContext {
  hostname: string;
  frame: "child" | "top" | "unknown";
  sameOriginTop: boolean | "unknown";
  documentLanguage: string;
  secureContext: boolean;
  translatorPolicy: boolean | "unknown";
}

export function translationRuntimeDiagnosticContext(): TranslationRuntimeDiagnosticContext {
  const currentWindow = typeof window === "undefined" ? undefined : window;
  const currentDocument =
    typeof document === "undefined" ? undefined : document;
  let frame: TranslationRuntimeDiagnosticContext["frame"] = "unknown";
  let sameOriginTop: TranslationRuntimeDiagnosticContext["sameOriginTop"] =
    "unknown";
  if (currentWindow) {
    frame = currentWindow === currentWindow.top ? "top" : "child";
    try {
      sameOriginTop =
        currentWindow.top?.location.origin === currentWindow.location.origin;
    } catch {
      sameOriginTop = false;
    }
  }
  const policy = currentDocument as
    | (Document & {
        permissionsPolicy?: { allowsFeature(feature: string): boolean };
        featurePolicy?: { allowsFeature(feature: string): boolean };
      })
    | undefined;
  let translatorPolicy: boolean | "unknown" = "unknown";
  try {
    const featurePolicy = policy?.permissionsPolicy ?? policy?.featurePolicy;
    if (featurePolicy) {
      translatorPolicy = featurePolicy.allowsFeature("translator");
    }
  } catch {
    translatorPolicy = "unknown";
  }
  return {
    hostname: currentWindow?.location.hostname.slice(0, 253) ?? "",
    frame,
    sameOriginTop,
    documentLanguage:
      currentDocument?.documentElement.lang.trim().slice(0, 80) ?? "",
    secureContext: globalThis.isSecureContext === true,
    translatorPolicy,
  };
}

/** Emits bounded translation metadata without source text or complete URLs. */
export function translationDiagnostic(
  scope: TranslationDiagnosticScope,
  event: string,
  detail: Readonly<Record<string, unknown>>,
  level: "info" | "warn" = "info",
): void {
  console[level](`[NorixorTrans][${scope}] ${event} ${JSON.stringify(detail)}`);
}
