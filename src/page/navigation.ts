function hashTarget(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}

function hasExplicitDocumentAnchor(url: URL, document: Document): boolean {
  const target = hashTarget(url.hash);
  if (!target) return false;
  if (
    !document.getElementById(target) &&
    document.getElementsByName(target).length === 0
  ) {
    return false;
  }
  return Array.from(
    document.querySelectorAll<HTMLAnchorElement>("a[href]"),
  ).some((anchor) => {
    try {
      const href = new URL(anchor.getAttribute("href") ?? "", url.href);
      return (
        href.origin === url.origin &&
        href.pathname === url.pathname &&
        href.search === url.search &&
        href.hash === url.hash
      );
    } catch {
      return false;
    }
  });
}

/** Preserves SPA route fragments while ignoring explicit in-document anchors. */
export function pageRouteKey(
  value = location.href,
  document: Document = globalThis.document,
): string {
  const url = new URL(value);
  if (
    url.hash &&
    !/^#(?:!\/|\/)/u.test(url.hash) &&
    hasExplicitDocumentAnchor(url, document)
  ) {
    url.hash = "";
  }
  return url.href;
}

export const pageTranslationScope = pageRouteKey;
