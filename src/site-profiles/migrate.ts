/** Preserve published site Profiles without silently routing AI text to another provider. */
export function migrateRemovedAiRoute(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return value;
  const profile = structuredClone(value) as Record<string, unknown>;
  const overrides = profile.overrides;
  if (typeof overrides !== "object" || overrides === null) return profile;
  for (const surface of ["page", "selection", "subtitles"] as const) {
    const override = (overrides as Record<string, unknown>)[surface];
    if (typeof override !== "object" || override === null) continue;
    const entry = override as Record<string, unknown>;
    if (entry.aiRoute === "norixor" && entry.mode === "ai") {
      entry.mode = "fast";
      entry.modelOverride = "";
      if (surface === "page") entry.autoTranslate = false;
      else entry.enabled = false;
    }
    if (entry.aiRoute === "norixor" || entry.aiRoute === "configured") {
      delete entry.aiRoute;
    }
  }
  return profile;
}
