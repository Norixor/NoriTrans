import type { TranslationMode } from "@/src/translation/types";

const TRANSLATION_PROTOCOL_CACHE_VERSION = "explicit-segment-text-v3";

export interface TranslationCacheIdentity {
  providerId: string;
  model: string;
  promptVersion: string;
  sourceLanguage: string;
  targetLanguage: string;
  mode: TranslationMode;
  text: string;
  scope?: string;
}

function canonicalIdentity(identity: TranslationCacheIdentity): string {
  return JSON.stringify({
    providerId: identity.providerId,
    model: identity.model,
    promptVersion: identity.promptVersion,
    sourceLanguage: identity.sourceLanguage,
    targetLanguage: identity.targetLanguage,
    mode: identity.mode,
    text: identity.text,
    scope: identity.scope ?? "",
  });
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function promptVersion(prompt: string): string {
  let hash = 2166136261;
  for (const character of `${TRANSLATION_PROTOCOL_CACHE_VERSION}\u001f${prompt}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function translationCacheKey(
  identity: TranslationCacheIdentity,
): Promise<string> {
  return sha256(canonicalIdentity(identity));
}

export function subtitleTrackKey(parts: {
  site: string;
  videoId: string;
  sourceLanguage: string;
  targetLanguage: string;
  providerId: string;
  model: string;
  promptVersion: string;
}): string {
  return [
    parts.site,
    parts.videoId,
    parts.sourceLanguage,
    parts.targetLanguage,
    parts.providerId,
    parts.model,
    parts.promptVersion,
  ]
    .map((part) => encodeURIComponent(part))
    .join(":");
}
