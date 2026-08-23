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
