import enMessages from "@/public/_locales/en/messages.json";
import zhCnMessages from "@/public/_locales/zh_CN/messages.json";
import { normalizeUiLanguage, type UiLanguage } from "@/src/shared/settings";
import { browser } from "wxt/browser";

export type ResolvedUiLanguage = Exclude<UiLanguage, "auto">;

interface LocalePlaceholder {
  content: string;
}

interface LocaleMessage {
  message: string;
  placeholders?: Record<string, LocalePlaceholder>;
}

type LocaleCatalog = Record<string, LocaleMessage>;

const CATALOGS: Record<ResolvedUiLanguage, LocaleCatalog> = {
  en: enMessages,
  "zh-CN": zhCnMessages,
};

let selectedLanguage: UiLanguage = "auto";
let resolvedLanguage: ResolvedUiLanguage = "en";

function resolveBrowserLanguage(): ResolvedUiLanguage {
  const locale = browser.i18n.getUILanguage().toLowerCase();
  return locale.startsWith("zh") ? "zh-CN" : "en";
}

export function configureUiLanguage(language: UiLanguage): void {
  selectedLanguage = normalizeUiLanguage(language);
  resolvedLanguage =
    selectedLanguage === "auto" ? resolveBrowserLanguage() : selectedLanguage;
}

export async function initializeUiLanguage(): Promise<UiLanguage> {
  try {
    const stored = await browser.storage.local.get("settings");
    const value =
      stored.settings &&
      typeof stored.settings === "object" &&
      "uiLanguage" in stored.settings
        ? stored.settings.uiLanguage
        : undefined;
    configureUiLanguage(normalizeUiLanguage(value));
  } catch {
    configureUiLanguage("auto");
  }
  return selectedLanguage;
}

export function currentUiLanguage(): UiLanguage {
  return selectedLanguage;
}

export function currentUiLocale(): ResolvedUiLanguage {
  return resolvedLanguage;
}

function substitute(
  entry: LocaleMessage,
  substitutions?: string | string[],
): string {
  const values = Array.isArray(substitutions)
    ? substitutions
    : substitutions === undefined
      ? []
      : [substitutions];
  const escapedDollar = "\u0000NORIXORTRANS_DOLLAR\u0000";
  const placeholders = entry.placeholders ?? {};
  let output = entry.message.replaceAll("$$", escapedDollar);
  output = output.replace(/\$([A-Za-z0-9_]+)\$/gu, (token, name: string) => {
    const placeholder = placeholders[name.toLowerCase()];
    if (!placeholder) return token;
    return placeholder.content.replace(/\$(\d+)/gu, (_match, index: string) => {
      return values[Number(index) - 1] ?? "";
    });
  });
  output = output.replace(/\$(\d+)/gu, (_match, index: string) => {
    return values[Number(index) - 1] ?? "";
  });
  return output.replaceAll(escapedDollar, "$");
}

export function message(
  key: string,
  substitutions?: string | string[],
): string {
  const entry = CATALOGS[resolvedLanguage][key];
  return entry ? substitute(entry, substitutions) : key;
}

export function localizeDocument(root: Document = document): void {
  const resolveMessages = (value: string): string =>
    value.replace(
      /__MSG_([^_]+(?:_[^_]+)*)__/gu,
      (placeholder, key: string) => {
        const localized = message(key);
        return localized === key ? String(placeholder) : localized;
      },
    );
  const walker = root.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode();
  while (textNode) {
    if (textNode.nodeValue?.includes("__MSG_")) {
      textNode.nodeValue = resolveMessages(textNode.nodeValue);
    }
    textNode = walker.nextNode();
  }
  for (const node of root.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.value.includes("__MSG_")) {
        node.setAttribute(attribute.name, resolveMessages(attribute.value));
      }
    }
  }
  root.documentElement.lang = message("documentLanguage");
  root.documentElement.dataset.localized = "true";
}
