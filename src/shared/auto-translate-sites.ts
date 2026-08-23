const MAX_SITE_PATTERNS = 500;

const COMPOUND_PUBLIC_SUFFIXES = new Set([
  "co.jp",
  "co.kr",
  "co.nz",
  "co.uk",
  "com.au",
  "com.br",
  "com.cn",
  "com.hk",
  "com.mx",
  "com.sg",
  "com.tw",
  "net.au",
  "net.cn",
  "org.au",
  "org.cn",
  "org.uk",
]);

export interface AutoTranslateSiteRules {
  autoTranslate: boolean;
  autoTranslateSitePatterns: readonly string[];
  autoTranslateExcludedSitePatterns: readonly string[];
}

function normalizedHostname(value: string): string | null {
  const hostname = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/gu, "");
  if (!hostname || hostname.length > 253) return null;
  if (hostname === "localhost" || /^[0-9a-f:.]+$/iu.test(hostname)) {
    return hostname;
  }
  if (
    hostname
      .split(".")
      .some(
        (label) =>
          !label ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  ) {
    return null;
  }
  return hostname;
}

export function normalizeAutoTranslateSitePattern(
  value: string,
): string | null {
  const trimmed = value.trim().toLowerCase();
  const wildcard = trimmed.startsWith("*.");
  const hostname = normalizedHostname(wildcard ? trimmed.slice(2) : trimmed);
  if (!hostname) return null;
  return wildcard && hostname !== "localhost" && !hostname.includes(":")
    ? `*.${hostname}`
    : hostname;
}

export function normalizeAutoTranslateSitePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const patterns = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const pattern = normalizeAutoTranslateSitePattern(candidate);
    if (!pattern) continue;
    patterns.add(pattern);
    if (patterns.size >= MAX_SITE_PATTERNS) break;
  }
  return [...patterns].sort((left, right) => left.localeCompare(right));
}

/** Returns one stable wildcard rule for the current registrable site. */
export function autoTranslateSitePatternForHostname(
  value: string,
): string | null {
  const hostname = normalizedHostname(value);
  if (!hostname) return null;
  if (hostname === "localhost" || hostname.includes(":")) return hostname;
  const labels = hostname.split(".");
  if (labels.length <= 2) return `*.${hostname}`;
  const suffix = labels.slice(-2).join(".");
  const registrableLabelCount = COMPOUND_PUBLIC_SUFFIXES.has(suffix) ? 3 : 2;
  return `*.${labels.slice(-registrableLabelCount).join(".")}`;
}

export function autoTranslateSitePatternForUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return autoTranslateSitePatternForHostname(url.hostname);
  } catch {
    return null;
  }
}

export function autoTranslatePatternMatchesHostname(
  patternValue: string,
  hostnameValue: string,
): boolean {
  const pattern = normalizeAutoTranslateSitePattern(patternValue);
  const hostname = normalizedHostname(hostnameValue);
  if (!pattern || !hostname) return false;
  if (!pattern.startsWith("*.")) return pattern === hostname;
  const suffix = pattern.slice(2);
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function isSiteAutoTranslateEnabled(
  rules: AutoTranslateSiteRules,
  hostname: string,
): boolean {
  if (
    rules.autoTranslateExcludedSitePatterns.some((pattern) =>
      autoTranslatePatternMatchesHostname(pattern, hostname),
    )
  ) {
    return false;
  }
  return (
    rules.autoTranslate ||
    rules.autoTranslateSitePatterns.some((pattern) =>
      autoTranslatePatternMatchesHostname(pattern, hostname),
    )
  );
}

export function updateSiteAutoTranslateRules(
  rules: AutoTranslateSiteRules,
  patternValue: string,
  enabled: boolean,
): {
  autoTranslateSitePatterns: string[];
  autoTranslateExcludedSitePatterns: string[];
} {
  const pattern = normalizeAutoTranslateSitePattern(patternValue);
  if (!pattern) {
    return {
      autoTranslateSitePatterns: [...rules.autoTranslateSitePatterns],
      autoTranslateExcludedSitePatterns: [
        ...rules.autoTranslateExcludedSitePatterns,
      ],
    };
  }
  const included = new Set(rules.autoTranslateSitePatterns);
  const excluded = new Set(rules.autoTranslateExcludedSitePatterns);
  if (enabled) {
    excluded.delete(pattern);
    if (!rules.autoTranslate) included.add(pattern);
  } else {
    included.delete(pattern);
    if (rules.autoTranslate) excluded.add(pattern);
    else excluded.delete(pattern);
  }
  return {
    autoTranslateSitePatterns: normalizeAutoTranslateSitePatterns([
      ...included,
    ]),
    autoTranslateExcludedSitePatterns: normalizeAutoTranslateSitePatterns([
      ...excluded,
    ]),
  };
}
