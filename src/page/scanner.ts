import { createProtectedTextLengthCounter } from "@/src/translation/protected-text";

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "CODE",
  "PRE",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "OPTION",
  "SVG",
  "CANVAS",
  "VIDEO",
  "AUDIO",
  "IFRAME",
  "OBJECT",
  "EMBED",
]);

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "TD",
  "TH",
  "BLOCKQUOTE",
  "ARTICLE",
  "SECTION",
  "MAIN",
  "ASIDE",
  "HEADER",
  "FOOTER",
  "NAV",
  "FIGCAPTION",
  "CAPTION",
  "DT",
  "DD",
  "BUTTON",
  "LABEL",
  "LEGEND",
  "SUMMARY",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

const MAX_SEGMENT_CHARACTERS = 900;
// Leave room below the smallest page translation batch budget. Inline-heavy
// pages add two protected markers per Text node, so raw visible text length
// alone is not a safe request-size bound.
const MAX_PROTECTED_SEGMENT_CHARACTERS = 2_800;
type ScanRoot = Element | ShadowRoot;

const KNOWN_CAPTION_DOM_SELECTOR = [
  ".ytp-caption-segment",
  ".player-timedtext",
].join(",");

const GENERIC_CAPTION_DOM_SELECTOR = [
  '[class*="caption" i]',
  '[class*="subtitle" i]',
  '[id*="caption" i]',
  '[id*="subtitle" i]',
].join(",");

export interface PageSegment {
  id: string;
  text: string;
  documentOrder: number;
  nodes: Text[];
  originalTexts: string[];
  anchor: Element;
  assignedSlot?: {
    slot: HTMLSlotElement;
    source: Element | Text;
  };
}

function assignedSlotPlacement(
  node: Text,
): PageSegment["assignedSlot"] | undefined {
  let current: Node | null = node;
  while (current instanceof Element || current instanceof Text) {
    if (current.assignedSlot) {
      return { slot: current.assignedSlot, source: current };
    }
    current = current.parentNode;
  }
  return undefined;
}

function fnv1a(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

interface ElementPathCache {
  readonly pathByElement: WeakMap<Element, string>;
  readonly siblingIndexByElement: WeakMap<Element, number>;
  readonly indexedSiblingContainers: WeakSet<Node>;
}

function siblingTagIndex(
  element: Element,
  container: Element | ShadowRoot,
  cache: ElementPathCache,
): number {
  if (!cache.indexedSiblingContainers.has(container)) {
    cache.indexedSiblingContainers.add(container);
    const nextIndexByTag = new Map<string, number>();
    for (const child of container.children) {
      const nextIndex = nextIndexByTag.get(child.tagName) ?? 0;
      cache.siblingIndexByElement.set(child, nextIndex);
      nextIndexByTag.set(child.tagName, nextIndex + 1);
    }
  }
  return cache.siblingIndexByElement.get(element) ?? -1;
}

function localElementPath(
  element: Element,
  root: ScanRoot,
  cache: ElementPathCache,
): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== root) {
    const siblingContainer =
      current.parentElement ??
      (root instanceof ShadowRoot && current.getRootNode() === root
        ? root
        : null);
    const siblingIndex = siblingContainer
      ? siblingTagIndex(current, siblingContainer, cache)
      : -1;
    parts.push(`${current.tagName.toLowerCase()}:${siblingIndex}`);
    current = current.parentElement;
  }
  return parts.reverse().join("/") || "root";
}

function composedElementPath(
  element: Element,
  documentRoot: Element,
  cache: ElementPathCache,
): string {
  const cached = cache.pathByElement.get(element);
  if (cached !== undefined) return cached;
  const root = element.getRootNode();
  const path =
    root instanceof ShadowRoot
      ? `${composedElementPath(root.host, documentRoot, cache)}::shadow/${localElementPath(element, root, cache)}`
      : localElementPath(element, documentRoot, cache);
  cache.pathByElement.set(element, path);
  return path;
}

function stableSegmentId(
  documentRoot: Element,
  anchor: Element,
  chunkIndex: number,
  text: string,
  nodes: readonly Text[],
  childIndexByText: WeakMap<Text, number>,
  elementPathCache: ElementPathCache,
): string {
  const nodePaths = nodes
    .map((node) => {
      const parent = node.parentElement;
      if (parent) {
        return `${composedElementPath(parent, documentRoot, elementPathCache)}::text:${childIndexByText.get(node) ?? -1}`;
      }
      const nodeRoot = node.getRootNode();
      if (nodeRoot instanceof ShadowRoot) {
        return `${composedElementPath(nodeRoot.host, documentRoot, elementPathCache)}::shadow/root::text:${childIndexByText.get(node) ?? -1}`;
      }
      return "detached";
    })
    .join("|");
  return `page-${fnv1a(`${composedElementPath(anchor, documentRoot, elementPathCache)}\u001f${nodePaths}\u001f${chunkIndex}\u001f${text}`)}`;
}

function isVisible(element: Element): boolean {
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return false;
  }
  const style = getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    Number(style.opacity) !== 0
  );
}

function hasNearbyVideoContainer(element: Element): boolean {
  let container = element.parentElement;
  for (let depth = 0; container && depth < 6; depth += 1) {
    if (container === document.body || container === document.documentElement)
      return false;
    if (container.querySelector("video")) return true;
    container = container.parentElement;
  }
  return false;
}

function isLikelyCaptionElement(element: Element): boolean {
  if (element.matches(KNOWN_CAPTION_DOM_SELECTOR)) return true;
  const candidate = element.closest(GENERIC_CAPTION_DOM_SELECTOR);
  if (!candidate) return false;
  if (
    candidate.matches(
      '[aria-live="polite"],[aria-live="assertive"],[role="status"],[role="log"]',
    )
  ) {
    return true;
  }
  return hasNearbyVideoContainer(candidate);
}

function shouldSkipElement(element: Element): boolean {
  return (
    SKIP_TAGS.has(element.tagName) ||
    element.tagName.startsWith("NORITRANS-") ||
    element.hasAttribute("data-noritrans-ui") ||
    element.hasAttribute("data-noritrans-translated") ||
    isLikelyCaptionElement(element) ||
    element.getAttribute("translate")?.toLowerCase() === "no" ||
    element.classList.contains("notranslate") ||
    (element instanceof HTMLElement && element.isContentEditable) ||
    !isVisible(element)
  );
}

export function shouldSkipTextNode(node: Text, root: ScanRoot): boolean {
  const text = node.textContent?.trim() ?? "";
  if (text.length === 0) return true;
  const nodeRoot = node.getRootNode();
  const textContainer =
    node.parentElement ??
    (nodeRoot instanceof ShadowRoot ? nodeRoot : undefined);
  if (!textContainer) return true;
  const linguisticContent = /[\p{L}\p{N}]/u;
  if (
    !linguisticContent.test(text) &&
    !linguisticContent.test(textContainer.textContent?.trim() ?? "")
  ) {
    return true;
  }
  const numericOrPunctuation = /^[\d\s.,%$€¥£+\-*/=()[\]{}:;]+$/;
  if (
    numericOrPunctuation.test(text) &&
    numericOrPunctuation.test(textContainer.textContent?.trim() ?? "")
  ) {
    return true;
  }

  const composedParent = (current: Element | Text): Element | null => {
    if (current.assignedSlot) return current.assignedSlot;
    if (current.parentElement) return current.parentElement;
    const currentRoot = current.getRootNode();
    return currentRoot instanceof ShadowRoot ? currentRoot.host : null;
  };
  let element: Element | null = composedParent(node);
  const visited = new WeakSet<Element>();
  while (element) {
    if (visited.has(element)) break;
    visited.add(element);
    if (shouldSkipElement(element)) return true;
    if (element === root) break;
    element = composedParent(element);
  }
  return false;
}

function blockAncestor(node: Text, root: ScanRoot): Element {
  let element = node.parentElement;
  const fallback = element ?? (root instanceof ShadowRoot ? root.host : root);
  while (element && element !== root) {
    if (element.tagName === "A") {
      if (!getComputedStyle(element).display.startsWith("inline")) {
        return element;
      }
    }
    if (BLOCK_TAGS.has(element.tagName) || element.tagName.includes("-"))
      return element;
    element = element.parentElement;
  }
  return root instanceof Element ? root : fallback;
}

function inlineLinkWithin(node: Text, anchor: Element): Element | null {
  let current = node.parentElement;
  while (current && current !== anchor) {
    if (
      current.tagName === "A" &&
      getComputedStyle(current).display.startsWith("inline")
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return anchor.tagName === "A" ? anchor : null;
}

export function pageSegmentAnchor(node: Text, root: Element): Element {
  const nodeRoot = node.getRootNode();
  return blockAncestor(node, nodeRoot instanceof ShadowRoot ? nodeRoot : root);
}

function distanceFromViewport(element: Element): number {
  const rect = element.getBoundingClientRect();
  if (rect.bottom >= 0 && rect.top <= window.innerHeight) return 0;
  return rect.top > window.innerHeight
    ? rect.top - window.innerHeight
    : Math.abs(rect.bottom);
}

export function scanPageSegments(
  root: Element,
  seen = new WeakSet<Text>(),
): PageSegment[] {
  const segments: PageSegment[] = [];
  const composedOrder = new WeakMap<Text, number>();
  const childIndexByText = new WeakMap<Text, number>();
  const elementPathCache: ElementPathCache = {
    pathByElement: new WeakMap<Element, string>(),
    siblingIndexByElement: new WeakMap<Element, number>(),
    indexedSiblingContainers: new WeakSet<Node>(),
  };
  const indexedParents = new WeakSet<Node>();
  const groups = new Map<Element, Map<HTMLSlotElement | null, Text[]>>();
  const processed = new WeakSet<Text>();
  let nextComposedOrder = 0;
  for (const node of composedTextNodes(root)) {
    composedOrder.set(node, nextComposedOrder++);
    const parent = node.parentNode;
    if (parent && !indexedParents.has(parent)) {
      indexedParents.add(parent);
      for (const [index, child] of [...parent.childNodes].entries()) {
        if (child instanceof Text) childIndexByText.set(child, index);
      }
    }
    const nodeRoot = node.getRootNode();
    const scanRoot = nodeRoot instanceof ShadowRoot ? nodeRoot : root;
    if (
      processed.has(node) ||
      seen.has(node) ||
      shouldSkipTextNode(node, scanRoot)
    ) {
      continue;
    }
    processed.add(node);
    const anchor = blockAncestor(node, scanRoot);
    const slot = assignedSlotPlacement(node)?.slot ?? null;
    const anchorGroups =
      groups.get(anchor) ?? new Map<HTMLSlotElement | null, Text[]>();
    const nodes = anchorGroups.get(slot) ?? [];
    nodes.push(node);
    anchorGroups.set(slot, nodes);
    groups.set(anchor, anchorGroups);
  }

  // A link participates in its surrounding sentence only when the same
  // semantic block also contains non-link text. Link-only menus and standalone
  // links keep independent anchors so their click target and bilingual layout
  // remain compact.
  const refinedGroups = new Map<Element, Map<HTMLSlotElement | null, Text[]>>();
  for (const [anchor, anchorGroups] of groups) {
    for (const [slot, nodes] of anchorGroups) {
      const links = nodes.map((node) => inlineLinkWithin(node, anchor));
      if (links.every((link) => link !== null)) {
        for (const [index, node] of nodes.entries()) {
          const link = links[index];
          if (!link) continue;
          const linkGroups =
            refinedGroups.get(link) ??
            new Map<HTMLSlotElement | null, Text[]>();
          const linkNodes = linkGroups.get(slot) ?? [];
          linkNodes.push(node);
          linkGroups.set(slot, linkNodes);
          refinedGroups.set(link, linkGroups);
        }
        continue;
      }
      const refinedAnchorGroups =
        refinedGroups.get(anchor) ?? new Map<HTMLSlotElement | null, Text[]>();
      refinedAnchorGroups.set(slot, nodes);
      refinedGroups.set(anchor, refinedAnchorGroups);
    }
  }

  for (const [anchor, anchorGroups] of refinedGroups) {
    for (const nodes of anchorGroups.values()) {
      let batch: Text[] = [];
      let characters = 0;
      let chunkIndex = 0;
      let protectedLength = createProtectedTextLengthCounter();

      const flush = () => {
        const text = batch
          .map((node) => node.textContent ?? "")
          .join("")
          .replace(/\s+/g, " ")
          .trim();
        if (text.length > 0) {
          for (const node of batch) seen.add(node);
          const assignedSlot = batch.at(-1)
            ? assignedSlotPlacement(batch.at(-1)!)
            : undefined;
          segments.push({
            id: stableSegmentId(
              root,
              anchor,
              chunkIndex,
              text,
              batch,
              childIndexByText,
              elementPathCache,
            ),
            text,
            documentOrder: Math.min(
              ...batch.map(
                (node) => composedOrder.get(node) ?? nextComposedOrder++,
              ),
            ),
            nodes: batch,
            originalTexts: batch.map((node) => node.textContent ?? ""),
            anchor,
            ...(assignedSlot ? { assignedSlot } : {}),
          });
        }
        batch = [];
        characters = 0;
        protectedLength = createProtectedTextLengthCounter();
        chunkIndex += 1;
      };

      for (const node of nodes) {
        const nodeText = node.textContent ?? "";
        const length = nodeText.trim().length;
        const candidateProtectedLength = protectedLength.append(nodeText);
        const protectedTextWouldOverflow =
          batch.length > 0 &&
          candidateProtectedLength > MAX_PROTECTED_SEGMENT_CHARACTERS;
        const shouldFlush =
          batch.length > 0 &&
          (characters + length > MAX_SEGMENT_CHARACTERS ||
            protectedTextWouldOverflow);
        if (shouldFlush) {
          flush();
          protectedLength.append(nodeText);
        }
        batch.push(node);
        characters += length;
      }
      flush();
    }
  }

  return segments.sort(
    (left, right) =>
      distanceFromViewport(left.anchor) - distanceFromViewport(right.anchor),
  );
}

function renderedSlotNodes(slot: HTMLSlotElement): Node[] {
  const assigned = slot.assignedNodes({ flatten: true });
  return assigned.length > 0 ? assigned : [...slot.childNodes];
}

function composedTextNodes(root: Element | ShadowRoot): Text[] {
  const texts: Text[] = [];
  const visited = new WeakSet<Node>();
  const visit = (node: Node): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node instanceof Text) {
      texts.push(node);
      return;
    }
    if (node instanceof HTMLSlotElement) {
      for (const child of renderedSlotNodes(node)) visit(child);
      return;
    }
    // Closed roots intentionally remain opaque: the platform exposes no
    // ShadowRoot through `element.shadowRoot`, so only open roots are entered.
    if (node instanceof Element && node.shadowRoot) {
      visit(node.shadowRoot);
      return;
    }
    for (const child of node.childNodes) visit(child);
  };

  if (root instanceof Element && root.shadowRoot) visit(root.shadowRoot);
  else for (const child of root.childNodes) visit(child);
  return texts;
}

export function composedSlotTextNodes(slot: HTMLSlotElement): Text[] {
  return renderedSlotNodes(slot).flatMap((node) =>
    node instanceof Text
      ? [node]
      : node instanceof Element
        ? composedTextNodes(node)
        : [],
  );
}

export function discoverOpenShadowRoots(root: Element): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  const visited = new WeakSet<Node>();
  const visit = (node: Node): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node instanceof HTMLSlotElement) {
      for (const child of renderedSlotNodes(node)) visit(child);
      return;
    }
    if (node instanceof Element && node.shadowRoot) {
      roots.push(node.shadowRoot);
      visit(node.shadowRoot);
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return roots;
}
