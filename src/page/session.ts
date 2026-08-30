import type { PageStatus, TranslationResponse } from "@/src/messaging/protocol";
import {
  getSharedCachedTranslation,
  setSharedCachedTranslation,
} from "@/src/cache/content-client";
import { promptVersion, translationCacheKey } from "@/src/cache/keys";
import { PageRenderer } from "@/src/page/renderer";
import { composedContains } from "@/src/page/composed-tree";
import { pageTranslationScope } from "@/src/page/navigation";
import {
  composedSlotTextNodes,
  discoverOpenShadowRoots,
  pageSegmentAnchor,
  scanPageSegments,
  shouldSkipTextNode,
  type PageSegment,
} from "@/src/page/scanner";
import type { ContentSettings } from "@/src/shared/settings";
import { ChromeLocalProvider } from "@/src/translation/providers/chrome-local";
import {
  contextualizeSegments,
  translationSegmentCacheText,
  translationSegmentReuseIdentity,
} from "@/src/translation/context";
import {
  normalizeTranslationText,
  scheduleTranslation,
} from "@/src/translation/scheduler";
import {
  assertValidProtectedTranslation,
  createProtectedText,
} from "@/src/translation/protected-text";
import { subscribeTranslationProgress } from "@/src/translation/progress-channel";
import type {
  TranslationResult,
  TranslationSegment,
} from "@/src/translation/types";
import { browser } from "wxt/browser";
import { runtimeId } from "@/src/shared/runtime-id";
import { NoriTransError } from "@/src/shared/errors";
import {
  translationDiagnostic,
  translationRuntimeDiagnosticContext,
} from "@/src/shared/diagnostics";
import {
  detectDominantSourceLanguage,
  hasTranslatableLanguageContent,
  isPredominantlyTargetScript,
  supportedSourceLanguageHint,
} from "@/src/translation/language-detection";
import { hasInstalledBergamotRoute } from "@/src/local-translation/languages";
import { normalizeBergamotLanguage } from "@/src/local-translation/types";
import { queryInstalledBergamotPackIds } from "@/src/translation/provider-capabilities";

type StatusListener = (status: PageStatus) => void;

const FAST_BATCH_MAX_SEGMENTS = 20;
const FAST_BATCH_MAX_CHARACTERS = 4_000;
const FAST_BATCH_CONCURRENCY = 8;
// Send one small viewport-first batch for quick visible feedback, then fill
// larger batches close to (but below) the OpenAI-compatible Provider's declared
// 60-segment / 12k-character limits. Eight bounded workers still cover large
// pages, while ordinary pages avoid extra RTT and repeated prompt overhead.
const AI_FIRST_BATCH_MAX_SEGMENTS = 12;
const AI_FIRST_BATCH_MAX_CHARACTERS = 3_000;
const AI_STREAM_BATCH_MAX_SEGMENTS = 48;
const AI_STREAM_BATCH_MAX_CHARACTERS = 10_000;
const AI_FULL_RESPONSE_BATCH_MAX_SEGMENTS = 48;
const AI_FULL_RESPONSE_BATCH_MAX_CHARACTERS = 10_000;
const AI_BATCH_CONCURRENCY = 8;
const AI_BATCH_MAX_ATTEMPTS = 2;
const MAX_REQUEST_FRAGMENT_CHARACTERS = 3_000;
const MAX_CONTEXT_FRAGMENT_CHARACTERS = 600;
const MAX_ATTRIBUTE_TEXT_CHECKS = 400;
const SHADOW_ROOT_DISCOVERY_INTERVAL_MS = 750;
const DYNAMIC_SCAN_DEBOUNCE_MS = 120;
const DYNAMIC_SCAN_MAX_WAIT_MS = 320;
const INTERACTION_SCAN_DEBOUNCE_MS = 90;
const INTERACTION_SCAN_ROOT_LIMIT = 8;
const INTERACTION_PATH_ROOT_LIMIT = 8;
const RESPONSIVE_SCAN_DEBOUNCE_MS = 160;
const RESPONSIVE_SCAN_ROOT_LIMIT = 128;
const PAGE_CACHE_READ_TIMEOUT_MS = 200;
const PAGE_CACHE_READ_CONCURRENCY = 8;
const SOURCE_DETECTION_CONCURRENCY = 8;
const SOURCE_MAJORITY_FALLBACK_MAX_CHARACTERS = 48;
const DOCUMENT_BODY_WAIT_TIMEOUT_MS = 5_000;
const RENDER_APPLY_MAX_ATTEMPTS = 3;
const RENDER_APPLY_RETRY_DELAY_MS = 60;
const PAGE_BATCH_CONCURRENCY = Math.max(
  FAST_BATCH_CONCURRENCY,
  AI_BATCH_CONCURRENCY,
);

type PageTranslationClaimResult =
  | { status: "translated"; translatedText: string }
  | { status: "skipped" }
  | { status: "failed" };

interface PageTranslationClaim {
  promise: Promise<PageTranslationClaimResult>;
  resolve(value: PageTranslationClaimResult): void;
  settled: boolean;
}

interface BatchPermitWaiter {
  signal: AbortSignal;
  resolve: () => void;
  reject: (reason: DOMException) => void;
  abort: () => void;
}

class BatchPermitPool {
  private active = 0;
  private readonly waiters: BatchPermitWaiter[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(
        new DOMException("Translation cancelled", "AbortError"),
      );
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: BatchPermitWaiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.abort);
          reject(new DOMException("Translation cancelled", "AbortError"));
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) continue;
      this.active += 1;
      waiter.resolve();
      return;
    }
  }
}

function createPageTranslationClaim(): PageTranslationClaim {
  let settle: (value: PageTranslationClaimResult) => void = () => undefined;
  const claim: PageTranslationClaim = {
    promise: new Promise<PageTranslationClaimResult>((resolve) => {
      settle = resolve;
    }),
    resolve: (value) => {
      if (claim.settled) return;
      claim.settled = true;
      settle(value);
    },
    settled: false,
  };
  return claim;
}

function waitForDocumentBody(signal: AbortSignal): Promise<HTMLElement | null> {
  if (document.body) return Promise.resolve(document.body);
  if (signal.aborted) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const observer = new MutationObserver(() => finish(document.body));
    const cleanup = (): void => {
      observer.disconnect();
      document.removeEventListener("DOMContentLoaded", check);
      signal.removeEventListener("abort", abort);
      globalThis.clearTimeout(timer);
    };
    const finish = (body: HTMLElement | null): void => {
      if (settled || (!body && !signal.aborted)) return;
      settled = true;
      cleanup();
      resolve(body);
    };
    const check = (): void => finish(document.body);
    const abort = (): void => finish(null);

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    document.addEventListener("DOMContentLoaded", check);
    signal.addEventListener("abort", abort, { once: true });
    const timer = globalThis.setTimeout(() => {
      if (document.body) finish(document.body);
      else {
        settled = true;
        cleanup();
        resolve(null);
      }
    }, DOCUMENT_BODY_WAIT_TIMEOUT_MS);
    check();
  });
}

interface ViewportPriority {
  measurable: boolean;
  visible: boolean;
  distance: number;
  documentOrder: number;
}

interface PageCacheReadResult {
  translatedText: string | undefined;
  timedOut: boolean;
}

interface PageCacheReadWaiter {
  signal: AbortSignal;
  resolve: (acquired: boolean) => void;
  abort: () => void;
}

class PageCacheReadPool {
  private active = 0;
  private stopped = false;
  private readonly waiters: PageCacheReadWaiter[] = [];

  async read(key: string, signal: AbortSignal): Promise<PageCacheReadResult> {
    if (!(await this.acquire(signal))) {
      return { translatedText: undefined, timedOut: false };
    }
    const underlying = getSharedCachedTranslation(key);
    void underlying.then(
      () => this.release(),
      () => this.release(),
    );
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let resolveAbort: ((result: PageCacheReadResult) => void) | undefined;
    const onAbort = () =>
      resolveAbort?.({ translatedText: undefined, timedOut: false });
    const abort = new Promise<PageCacheReadResult>((resolve) => {
      resolveAbort = resolve;
      if (signal.aborted) {
        resolve({ translatedText: undefined, timedOut: false });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([
        underlying.then((translatedText) => ({
          translatedText,
          timedOut: false,
        })),
        new Promise<PageCacheReadResult>((resolve) => {
          timer = globalThis.setTimeout(
            () => resolve({ translatedText: undefined, timedOut: true }),
            PAGE_CACHE_READ_TIMEOUT_MS,
          );
        }),
        abort,
      ]);
      if (result.timedOut || signal.aborted) this.stopQueuedReads();
      return result;
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private acquire(signal: AbortSignal): Promise<boolean> {
    if (this.stopped || signal.aborted) return Promise.resolve(false);
    if (this.active < PAGE_CACHE_READ_CONCURRENCY) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: PageCacheReadWaiter = {
        signal,
        resolve,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.abort);
          resolve(false);
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private stopQueuedReads(): void {
    this.stopped = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve(false);
    }
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.stopped) {
      if (this.active === 0) this.stopped = false;
      return;
    }
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.resolve(false);
        continue;
      }
      this.active += 1;
      waiter.resolve(true);
      return;
    }
  }
}

interface NormalizedPageSegmentGroup {
  representative: PageSegment;
  members: PageSegment[];
}

function pageFastProvider(settings: ContentSettings) {
  return settings.page.fastProviderOverride ?? settings.provider.fastProvider;
}

function usesAutomaticLocalPageSource(settings: ContentSettings): boolean {
  const provider = pageFastProvider(settings);
  return (
    settings.page.sourceLanguage === "auto" &&
    settings.page.mode === "fast" &&
    (provider === "chrome-local" || provider === "bergamot-local")
  );
}

function isAutomaticLocalUnsupportedSource(
  error: unknown,
  settings: ContentSettings,
): boolean {
  const provider = pageFastProvider(settings);
  return (
    usesAutomaticLocalPageSource(settings) &&
    error instanceof NoriTransError &&
    error.code === "provider_unavailable" &&
    ((provider === "bergamot-local" &&
      (error.reason === "bergamot_package_missing" ||
        error.reason === "bergamot_unsupported_language")) ||
      (provider === "chrome-local" &&
        (error.reason === "chrome_language_detection_failed" ||
          error.reason === "chrome_pair_unavailable")))
  );
}

async function detectSegmentSourceLanguages(
  segments: readonly PageSegment[],
  declaredSourceLanguage: string | undefined,
  signal: AbortSignal,
  resolvedByScript: Map<string, Map<string, number>>,
): Promise<Map<string, string>> {
  const sourceById = new Map<string, string>();
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const segment = segments[nextIndex++];
      if (!segment) return;
      const detected = await detectDominantSourceLanguage(
        segment.text,
        declaredSourceLanguage,
      );
      if (signal.aborted) return;
      sourceById.set(segment.id, detected ?? "auto");
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(SOURCE_DETECTION_CONCURRENCY, segments.length),
      },
      () => worker(),
    ),
  );
  for (const sourceLanguage of sourceById.values()) {
    if (sourceLanguage === "auto") continue;
    const script = sourceLanguageScriptFamily(sourceLanguage);
    if (!script) continue;
    const counts = resolvedByScript.get(script) ?? new Map<string, number>();
    counts.set(sourceLanguage, (counts.get(sourceLanguage) ?? 0) + 1);
    resolvedByScript.set(script, counts);
  }
  for (const segment of segments) {
    if (sourceById.get(segment.id) !== "auto") continue;
    const normalizedLength = segment.text
      .normalize("NFKC")
      .replace(/\s+/gu, " ")
      .trim().length;
    if (normalizedLength > SOURCE_MAJORITY_FALLBACK_MAX_CHARACTERS) continue;
    const candidates = [
      ...(resolvedByScript.get(dominantScriptFamily(segment.text))?.entries() ??
        []),
    ].sort((left, right) => right[1] - left[1]);
    const strongest = candidates[0];
    const runnerUp = candidates[1];
    if (strongest && (!runnerUp || strongest[1] > runnerUp[1])) {
      sourceById.set(segment.id, strongest[0]);
    }
  }
  return sourceById;
}

function sourceLanguageScriptFamily(language: string): string | undefined {
  const primary = language.trim().toLowerCase().split("-")[0];
  if (["en", "es", "fr", "de"].includes(primary ?? "")) return "latin";
  if (primary === "zh") return "han";
  if (primary === "ja") return "kana";
  if (primary === "ko") return "hangul";
  return undefined;
}

function dominantScriptFamily(text: string): string {
  const kanaCount =
    text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  const hanCount = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const counts = [
    {
      script: "kana",
      count: kanaCount > 0 ? kanaCount + hanCount : 0,
    },
    {
      script: "hangul",
      count: text.match(/\p{Script=Hangul}/gu)?.length ?? 0,
    },
    {
      script: "han",
      count: kanaCount === 0 ? hanCount : 0,
    },
    {
      script: "latin",
      count: text.match(/\p{Script=Latin}/gu)?.length ?? 0,
    },
  ].sort((left, right) => right.count - left.count);
  const dominant = counts[0];
  const runnerUp = counts[1];
  if (!dominant || dominant.count === 0) return "other";
  return runnerUp?.count === dominant.count ? "mixed" : dominant.script;
}

function sourceBucketIdentity(
  segment: Pick<PageSegment, "id" | "text">,
  sourceLanguage: string,
) {
  if (sourceLanguage !== "auto") return sourceLanguage;
  const script = dominantScriptFamily(segment.text);
  // If statistical detection is unavailable, keep unresolved segments
  // separated by script family. The Provider can detect one homogeneous
  // fallback batch without allowing CJK text to dictate a Latin route.
  return `auto:${script}`;
}

function partitionBatchesBySource(
  batches: readonly PageSegment[][],
  sourceById: ReadonlyMap<string, string>,
): PageSegment[][] {
  return batches.flatMap((batch) => {
    const partitions = new Map<string, PageSegment[]>();
    for (const segment of batch) {
      const sourceLanguage = sourceById.get(segment.id) ?? "auto";
      const key = sourceBucketIdentity(segment, sourceLanguage);
      const partition = partitions.get(key) ?? [];
      partition.push(segment);
      partitions.set(key, partition);
    }
    return [...partitions.values()];
  });
}

function pageAiModel(settings: ContentSettings): string {
  return settings.page.modelOverride?.trim() || settings.provider.model;
}

function pageTranslationConfigurationIdentity(
  settings: ContentSettings,
): string {
  return JSON.stringify({
    mode: settings.page.mode,
    sourceLanguage: settings.page.sourceLanguage,
    targetLanguage: settings.page.targetLanguage,
    provider:
      settings.page.mode === "ai"
        ? settings.provider.aiProvider
        : pageFastProvider(settings),
    baseUrl: settings.provider.baseUrl,
    microsoftRegion: settings.provider.microsoftRegion,
    deeplPlan: settings.provider.deeplPlan,
    model: pageAiModel(settings),
    systemPrompt: settings.provider.systemPrompt,
  });
}

function groupNormalizedPageSegments(
  segments: readonly PageSegment[],
  identityById?: ReadonlyMap<string, string>,
): NormalizedPageSegmentGroup[] {
  const groups: NormalizedPageSegmentGroup[] = [];
  const byIdentity = new Map<string, NormalizedPageSegmentGroup>();
  for (const segment of segments) {
    const identity =
      identityById?.get(segment.id) ?? normalizeTranslationText(segment.text);
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.members.push(segment);
      continue;
    }
    const group = { representative: segment, members: [segment] };
    groups.push(group);
    byIdentity.set(identity, group);
  }
  return groups;
}

function viewportPriority(segment: PageSegment): ViewportPriority {
  try {
    const rect = segment.anchor.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const measurable =
      Number.isFinite(rect.top) &&
      Number.isFinite(rect.bottom) &&
      Number.isFinite(rect.left) &&
      Number.isFinite(rect.right) &&
      (rect.width > 0 || rect.height > 0);
    if (!measurable) {
      return {
        measurable: false,
        visible: false,
        distance: Number.POSITIVE_INFINITY,
        documentOrder: segment.documentOrder,
      };
    }

    const verticalDistance =
      rect.bottom < 0
        ? -rect.bottom
        : rect.top > viewportHeight
          ? rect.top - viewportHeight
          : 0;
    const horizontalDistance =
      rect.right < 0
        ? -rect.right
        : rect.left > viewportWidth
          ? rect.left - viewportWidth
          : 0;
    return {
      measurable: true,
      visible: verticalDistance === 0 && horizontalDistance === 0,
      distance: Math.hypot(verticalDistance, horizontalDistance),
      documentOrder: segment.documentOrder,
    };
  } catch {
    return {
      measurable: false,
      visible: false,
      distance: Number.POSITIVE_INFINITY,
      documentOrder: segment.documentOrder,
    };
  }
}

/**
 * Prioritizes semantic blocks in the viewport, then orders by viewport
 * distance. Preserves document order when layout cannot be measured reliably,
 * such as in test DOMs or for recently detached nodes.
 */
function prioritizeSegmentsForViewport(
  segments: readonly PageSegment[],
): PageSegment[] {
  const prioritized = segments.map((segment) => ({
    segment,
    priority: viewportPriority(segment),
  }));
  if (!prioritized.some(({ priority }) => priority.measurable)) {
    return [...segments];
  }
  return prioritized
    .sort((left, right) => {
      if (left.priority.measurable !== right.priority.measurable) {
        return left.priority.measurable ? -1 : 1;
      }
      if (left.priority.visible !== right.priority.visible) {
        return left.priority.visible ? -1 : 1;
      }
      return (
        left.priority.distance - right.priority.distance ||
        left.priority.documentOrder - right.priority.documentOrder
      );
    })
    .map(({ segment }) => segment);
}

function isExtensionUiNode(node: Node): boolean {
  let element: Element | null =
    node instanceof Element ? node : node.parentElement;
  while (element) {
    if (
      element.tagName.startsWith("NORIXOR-") ||
      element.hasAttribute("data-norixortrans-ui") ||
      element.hasAttribute("data-norixor-ui") ||
      element.hasAttribute("data-norixor-translated")
    ) {
      return true;
    }
    const parent = element.parentElement;
    if (parent) {
      element = parent;
      continue;
    }
    const root = element.getRootNode();
    element = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

function isExtensionOnlyMutation(mutation: MutationRecord): boolean {
  if (isExtensionUiNode(mutation.target)) return true;
  if (mutation.type !== "childList") return false;
  const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return (
    changedNodes.length > 0 &&
    changedNodes.every((node) => isExtensionUiNode(node))
  );
}

function controlledElementById(
  controller: Element,
  id: string,
): HTMLElement | null {
  const root = controller.getRootNode();
  if (root instanceof Document || root instanceof ShadowRoot) {
    return root.getElementById(id);
  }
  return document.getElementById(id);
}

const CONTROLLED_REVEAL_ATTRIBUTES = new Set([
  "aria-expanded",
  "data-state",
  "data-open",
  "open",
  "popovertarget",
]);

const VISIBILITY_REVEAL_ATTRIBUTES = new Set([
  "style",
  "class",
  "hidden",
  "aria-hidden",
  "aria-expanded",
  "inert",
  "open",
  "data-state",
  "data-open",
]);

function classContainsNoTranslate(value: string | null): boolean {
  return value?.split(/\s+/u).includes("notranslate") ?? false;
}

function contentEditableAttributeEnabled(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "true" ||
    normalized === "plaintext-only"
  );
}

function changesExplicitTranslationExclusion(
  mutation: MutationRecord,
): mutation is MutationRecord & { target: Element } {
  if (mutation.type !== "attributes" || !(mutation.target instanceof Element)) {
    return false;
  }
  const current = mutation.target.getAttribute(mutation.attributeName ?? "");
  if (mutation.attributeName === "translate") {
    return (
      mutation.oldValue?.toLowerCase() === "no" ||
      current?.toLowerCase() === "no"
    );
  }
  if (mutation.attributeName === "class") {
    return (
      classContainsNoTranslate(mutation.oldValue) ||
      classContainsNoTranslate(current)
    );
  }
  if (mutation.attributeName === "contenteditable") {
    return (
      contentEditableAttributeEnabled(mutation.oldValue) ||
      contentEditableAttributeEnabled(current)
    );
  }
  return false;
}

function controlledRevealRoots(controller: Element): Element[] {
  const controlled = new Set<Element>();
  for (const attribute of [
    "aria-controls",
    "aria-owns",
    "popovertarget",
  ] as const) {
    for (const id of controller.getAttribute(attribute)?.split(/\s+/u) ?? []) {
      const element = id ? controlledElementById(controller, id) : null;
      if (element) controlled.add(element);
    }
  }
  return [...controlled];
}

function composedParentElement(node: Node): Element | null {
  if (node instanceof Element || node instanceof Text) {
    if (node.assignedSlot) return node.assignedSlot;
    if (node.parentElement) return node.parentElement;
  }
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function isHiddenRevealRoot(element: Element): boolean {
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return true;
  }
  const style = getComputedStyle(element);
  return (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    Number(style.opacity) === 0
  );
}

function responsiveRevealRoot(node: Text, scanRoot: Element): Element | null {
  let current = composedParentElement(node);
  let hiddenRoot: Element | null = null;
  const visited = new WeakSet<Element>();
  while (current) {
    if (visited.has(current) || isExtensionUiNode(current)) break;
    visited.add(current);
    if (isHiddenRevealRoot(current)) hiddenRoot = current;
    if (current === scanRoot) break;
    current = composedParentElement(current);
  }
  return hiddenRoot;
}

function descendantTextNodes(nodes: Iterable<Node>): Text[] {
  const texts: Text[] = [];
  const visit = (node: Node): void => {
    if (node instanceof Text) {
      texts.push(node);
      return;
    }
    for (const child of node.childNodes) visit(child);
    if (node instanceof Element && node.shadowRoot) visit(node.shadowRoot);
  };
  for (const node of nodes) visit(node);
  return texts;
}

function addedTextNodes(mutation: MutationRecord): Text[] {
  return mutation.type === "childList"
    ? descendantTextNodes(mutation.addedNodes)
    : [];
}

function visibilityMutationChangesSegmentMembership(
  target: Element,
  segment: PageSegment,
  scanRoot: Element,
): boolean {
  if (target !== segment.anchor && !composedContains(segment.anchor, target)) {
    return false;
  }
  const previousNodes = segment.nodes.filter((node) =>
    composedContains(target, node),
  );
  const currentNodes = descendantTextNodes([target]).filter(
    (node) => !isExtensionUiNode(node) && !shouldSkipTextNode(node, scanRoot),
  );
  // Hiding the whole source anchor only needs the renderer's existing
  // visibility synchronization. Descendant membership changes require a new
  // semantic block and therefore invalidate the previous translation.
  if (
    target === segment.anchor &&
    previousNodes.length > 0 &&
    currentNodes.length === 0
  ) {
    return false;
  }
  return (
    previousNodes.length !== currentNodes.length ||
    previousNodes.some((node) => !currentNodes.includes(node))
  );
}

function attributeMayRevealUnseenText(
  mutation: MutationRecord,
  seen: WeakSet<Text>,
): boolean {
  if (mutation.type !== "attributes" || !(mutation.target instanceof Element))
    return false;
  if (mutation.target instanceof HTMLSlotElement) {
    for (const node of composedSlotTextNodes(mutation.target).slice(
      0,
      MAX_ATTRIBUTE_TEXT_CHECKS,
    )) {
      const nodeRoot = node.getRootNode();
      const scanRoot =
        nodeRoot instanceof ShadowRoot
          ? nodeRoot
          : (document.body ?? document.documentElement);
      if (!seen.has(node) && !shouldSkipTextNode(node, scanRoot)) return true;
    }
  }
  const roots: Array<Element | ShadowRoot> = [mutation.target];
  if (mutation.target.shadowRoot) roots.push(mutation.target.shadowRoot);
  roots.push(...discoverOpenShadowRoots(mutation.target));
  let inspected = 0;
  for (const [rootIndex, root] of roots.entries()) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && inspected < MAX_ATTRIBUTE_TEXT_CHECKS) {
      inspected += 1;
      if (
        node instanceof Text &&
        !seen.has(node) &&
        !shouldSkipTextNode(node, root)
      ) {
        return true;
      }
      node = walker.nextNode();
    }
    if (inspected >= MAX_ATTRIBUTE_TEXT_CHECKS) {
      // The bounded probe only decides whether a full debounced scan is
      // worthwhile. If text remains outside the probe budget, scan
      // conservatively instead of silently missing a revealed tail item.
      return node !== null || rootIndex < roots.length - 1;
    }
  }
  return false;
}

function validatedResultMap(
  segments: PageSegment[],
  results: TranslationResult[],
): Map<string, string> {
  const expected = new Set(segments.map((segment) => segment.id));
  if (
    expected.size !== segments.length ||
    segments.some((segment) => segment.id.length === 0)
  ) {
    throw new NoriTransError(
      "页面翻译批次包含空白或重复的段落 ID。",
      "invalid_response",
      false,
      `Page batch request has ${segments.length} segments but ${expected.size} unique non-empty IDs.`,
    );
  }

  const byId = new Map<string, string>();
  for (const result of results) {
    if (
      typeof result?.id !== "string" ||
      typeof result.translatedText !== "string" ||
      !result.translatedText.trim()
    ) {
      throw new NoriTransError(
        "翻译服务返回了无效译文。",
        "invalid_response",
        false,
        `Result item ${byId.size + 1} has a missing ID or empty translation. Expected ${expected.size} results.`,
      );
    }
    if (!expected.has(result.id) || byId.has(result.id)) {
      throw new NoriTransError(
        "翻译服务返回了未知或重复的段落 ID。",
        "invalid_response",
        false,
        `${expected.has(result.id) ? "Duplicate" : "Unknown"} result ID: ${result.id.slice(0, 120)}.`,
      );
    }
    byId.set(result.id, result.translatedText);
  }

  if (byId.size !== expected.size) {
    const missing = [...expected].filter((id) => !byId.has(id));
    throw new NoriTransError(
      "翻译服务没有返回全部段落。",
      "invalid_response",
      true,
      `Missing result IDs: ${missing
        .slice(0, 20)
        .map((id) => id.slice(0, 120))
        .join(
          ", ",
        )}${missing.length > 20 ? `, ... (${missing.length} total)` : ""}. Received ${byId.size} of ${expected.size}.`,
    );
  }
  return byId;
}

function safeFragmentEnd(text: string, start: number): number {
  let end = Math.min(start + MAX_REQUEST_FRAGMENT_CHARACTERS, text.length);
  const minimumPreferred = start + MAX_REQUEST_FRAGMENT_CHARACTERS * 0.6;
  for (let candidate = end; candidate > minimumPreferred; candidate -= 1) {
    if (/\s|[,.!?;:，。！？；：]/u.test(text[candidate - 1] ?? "")) {
      end = candidate;
      break;
    }
  }
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  ) {
    end -= 1;
  }
  return Math.max(start + 1, end);
}

function splitRequestText(text: string): string[] {
  if (text.length <= MAX_REQUEST_FRAGMENT_CHARACTERS) return [text];
  const fragments: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = safeFragmentEnd(text, start);
    fragments.push(text.slice(start, end));
    start = end;
  }
  return fragments;
}

function joinTranslatedFragments(
  partIds: readonly string[],
  sourceById: ReadonlyMap<string, TranslationSegment>,
  translatedById: (id: string) => string | undefined,
): string | undefined {
  let joined = "";
  let previousSource = "";
  let previousTranslation = "";
  for (const [index, id] of partIds.entries()) {
    const source = sourceById.get(id)?.text;
    const translated = translatedById(id);
    if (
      source === undefined ||
      translated === undefined ||
      !translated.trim()
    ) {
      return undefined;
    }
    const trimmed = translated.trim();
    if (index > 0) {
      const sourceHasWhitespaceBoundary =
        /\s$/u.test(previousSource) || /^\s/u.test(source);
      const providerHasWhitespaceBoundary =
        /\s$/u.test(previousTranslation) || /^\s/u.test(translated);
      if (sourceHasWhitespaceBoundary || providerHasWhitespaceBoundary) {
        joined += " ";
      }
    }
    joined += trimmed;
    previousSource = source;
    previousTranslation = translated;
  }
  return joined;
}

function boundedContext(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  return values.map((value) =>
    value.length <= MAX_CONTEXT_FRAGMENT_CHARACTERS
      ? value
      : value.slice(0, MAX_CONTEXT_FRAGMENT_CHARACTERS),
  );
}

function pageTranslationSegments(
  allSegments: readonly PageSegment[],
  selectedSegments: readonly PageSegment[],
  includeContext: boolean,
): TranslationSegment[] {
  const plainAll = allSegments.map(({ id, text }) => ({ id, text }));
  const plainSelected: TranslationSegment[] = selectedSegments.map(
    ({ id, text }) => ({ id, text }),
  );
  const contextualized: TranslationSegment[] = includeContext
    ? contextualizeSegments(plainAll, plainSelected)
    : plainSelected;
  const contextById = new Map(
    contextualized.map((segment) => [segment.id, segment]),
  );

  return selectedSegments.map((segment) => {
    const context = contextById.get(segment.id);
    if (segment.nodes.length <= 1) {
      return {
        id: segment.id,
        text: segment.text,
        ...(context?.contextBefore
          ? { contextBefore: context.contextBefore }
          : {}),
        ...(context?.contextAfter
          ? { contextAfter: context.contextAfter }
          : {}),
      };
    }
    return {
      id: segment.id,
      text: createProtectedText(segment.originalTexts),
      format: "protected-text-v1",
      ...(context?.contextBefore
        ? { contextBefore: context.contextBefore }
        : {}),
      ...(context?.contextAfter ? { contextAfter: context.contextAfter } : {}),
    };
  });
}

function expandRequestSegments(segments: TranslationSegment[]): {
  segments: TranslationSegment[];
  partsByOriginalId: Map<string, string[]>;
} {
  const expanded: TranslationSegment[] = [];
  const partsByOriginalId = new Map<string, string[]>();
  for (const segment of segments) {
    const fragments =
      segment.format === "protected-text-v1"
        ? [segment.text]
        : splitRequestText(segment.text);
    const ids: string[] = [];
    for (const [index, text] of fragments.entries()) {
      const id =
        fragments.length === 1 ? segment.id : `${segment.id}:part:${index}`;
      const contextBefore =
        index === 0 ? boundedContext(segment.contextBefore) : undefined;
      const contextAfter =
        index === fragments.length - 1
          ? boundedContext(segment.contextAfter)
          : undefined;
      ids.push(id);
      expanded.push({
        id,
        text,
        ...(segment.format ? { format: segment.format } : {}),
        ...(contextBefore ? { contextBefore } : {}),
        ...(contextAfter ? { contextAfter } : {}),
      });
    }
    partsByOriginalId.set(segment.id, ids);
  }
  return { segments: expanded, partsByOriginalId };
}

function collapseRequestResults(
  originalSegments: TranslationSegment[],
  expandedSegments: TranslationSegment[],
  partsByOriginalId: Map<string, string[]>,
  results: TranslationResult[],
): TranslationResult[] {
  const expected = new Set(expandedSegments.map((segment) => segment.id));
  const expectedById = new Map(
    expandedSegments.map((segment) => [segment.id, segment]),
  );
  const byId = new Map<string, string>();
  for (const result of results) {
    if (
      typeof result?.id !== "string" ||
      typeof result.translatedText !== "string" ||
      !result.translatedText.trim()
    ) {
      throw new NoriTransError(
        "翻译服务返回了无效译文。",
        "invalid_response",
        false,
        `Expanded result item ${byId.size + 1} has a missing ID or empty translation. Expected ${expected.size} results.`,
      );
    }
    if (!expected.has(result.id) || byId.has(result.id)) {
      throw new NoriTransError(
        "翻译服务返回了未知或重复的段落 ID。",
        "invalid_response",
        false,
        `${expected.has(result.id) ? "Duplicate" : "Unknown"} expanded result ID: ${result.id.slice(0, 120)}.`,
      );
    }
    const requestSegment = expectedById.get(result.id);
    if (requestSegment) {
      assertValidProtectedTranslation(requestSegment, result.translatedText);
    }
    byId.set(result.id, result.translatedText.trim());
  }
  if (byId.size !== expected.size) {
    const missing = [...expected].filter((id) => !byId.has(id));
    throw new NoriTransError(
      "翻译服务没有返回全部段落。",
      "invalid_response",
      true,
      `Missing expanded result IDs: ${missing
        .slice(0, 20)
        .map((id) => id.slice(0, 120))
        .join(
          ", ",
        )}${missing.length > 20 ? `, ... (${missing.length} total)` : ""}. Received ${byId.size} of ${expected.size}.`,
    );
  }
  return originalSegments.flatMap((segment) => {
    const partIds = partsByOriginalId.get(segment.id) ?? [];
    const translatedText = joinTranslatedFragments(
      partIds,
      expectedById,
      (id) => byId.get(id),
    );
    return translatedText !== undefined && partIds.length > 0
      ? [{ id: segment.id, translatedText }]
      : [];
  });
}

function createProgressiveBatches(
  segments: PageSegment[],
  documentSegments: PageSegment[],
  settings: ContentSettings,
  reuseIdentityById?: ReadonlyMap<string, string>,
): PageSegment[][] {
  const requestSegments = pageTranslationSegments(
    documentSegments,
    segments,
    settings.page.mode === "ai",
  );
  const requestById = new Map(
    requestSegments.map((segment) => [segment.id, segment]),
  );
  const batches: PageSegment[][] = [];
  let batch: PageSegment[] = [];
  let characters = 0;
  let contexts = new Set<string>();
  let identitiesByNormalizedText = new Map<string, string>();

  for (const segment of segments) {
    const isFirstAiBatch = settings.page.mode === "ai" && batches.length === 0;
    const maxSegments =
      settings.page.mode === "ai"
        ? isFirstAiBatch
          ? AI_FIRST_BATCH_MAX_SEGMENTS
          : settings.page.aiResponseMode === "stream"
            ? AI_STREAM_BATCH_MAX_SEGMENTS
            : AI_FULL_RESPONSE_BATCH_MAX_SEGMENTS
        : FAST_BATCH_MAX_SEGMENTS;
    const maxCharacters =
      settings.page.mode === "ai"
        ? isFirstAiBatch
          ? AI_FIRST_BATCH_MAX_CHARACTERS
          : settings.page.aiResponseMode === "stream"
            ? AI_STREAM_BATCH_MAX_CHARACTERS
            : AI_FULL_RESPONSE_BATCH_MAX_CHARACTERS
        : FAST_BATCH_MAX_CHARACTERS;
    const requestSegment = requestById.get(segment.id);
    const contextValues = requestSegment
      ? [
          ...new Set([
            ...(requestSegment.contextBefore ?? []),
            ...(requestSegment.contextAfter ?? []),
          ]),
        ]
      : [];
    const contextCharacters = contextValues.reduce(
      (total, context) => total + (contexts.has(context) ? 0 : context.length),
      0,
    );
    let nextCharacters =
      (requestSegment?.text.length ?? segment.text.length) + contextCharacters;
    const normalizedText = normalizeTranslationText(segment.text);
    const reuseIdentity = reuseIdentityById?.get(segment.id);
    const existingIdentity = identitiesByNormalizedText.get(normalizedText);
    if (
      batch.length > 0 &&
      (batch.length >= maxSegments ||
        characters + nextCharacters > maxCharacters ||
        (settings.page.mode === "ai" &&
          reuseIdentity !== undefined &&
          existingIdentity !== undefined &&
          existingIdentity !== reuseIdentity))
    ) {
      batches.push(batch);
      batch = [];
      characters = 0;
      contexts = new Set<string>();
      identitiesByNormalizedText = new Map<string, string>();
      nextCharacters =
        (requestSegment?.text.length ?? segment.text.length) +
        contextValues.reduce((total, context) => total + context.length, 0);
    }
    batch.push(segment);
    characters += nextCharacters;
    for (const context of contextValues) contexts.add(context);
    if (reuseIdentity !== undefined) {
      identitiesByNormalizedText.set(normalizedText, reuseIdentity);
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export class PageTranslationSession {
  private readonly renderer = new PageRenderer();
  private seen = new WeakSet<Text>();
  private controller: AbortController | undefined;
  private observer: MutationObserver | undefined;
  private observedRoots = new WeakSet<Node>();
  private mutationTimer: number | undefined;
  private mutationQueuedAt: number | undefined;
  private interactionTimer: number | undefined;
  private interactionScanRoots = new Set<Element>();
  private responsiveScanTimer: number | undefined;
  private responsiveScanRoots = new Set<Element>();
  private observedVisualViewport: VisualViewport | undefined;
  private shadowDiscoveryTimer: number | undefined;
  private toggleEventRoots = new Set<Document | ShadowRoot>();
  private observedSlots = new Map<
    HTMLSlotElement,
    { listener: EventListener; nodes: Text[] }
  >();
  private activeRoot: Element | undefined;
  private settings: ContentSettings | undefined;
  private localProvider: ChromeLocalProvider | undefined;
  private localProviderConfiguration: string | undefined;
  private sourceDetectionConfiguration: string | undefined;
  private resolvedSourceLanguagesByScript = new Map<
    string,
    Map<string, number>
  >();
  private failureMessage: string | undefined;
  private failureDetails: string | undefined;
  private readonly translationsByConfiguration = new Map<
    string,
    Map<string, string>
  >();
  private readonly inFlightTranslationsByConfiguration = new Map<
    string,
    Map<string, PageTranslationClaim>
  >();
  private readonly batchPermits = new BatchPermitPool(PAGE_BATCH_CONCURRENCY);
  private readonly cacheReads = new PageCacheReadPool();
  private activeTranslationRuns = 0;
  private documentSegments: PageSegment[] = [];
  private invalidatedSegments = new WeakSet<PageSegment>();
  private segmentOutcomes = new WeakMap<PageSegment, "completed" | "failed">();
  private status: PageStatus = {
    state: "idle",
    total: 0,
    completed: 0,
    failed: 0,
  };

  constructor(private readonly onStatus: StatusListener) {}

  getStatus(): PageStatus {
    return { ...this.status };
  }

  updateSettings(settings: ContentSettings): void {
    if (this.controller && !this.controller.signal.aborted) {
      this.settings = settings;
      if (this.activeTranslationRuns === 0) {
        this.configureLocalProvider(settings);
      }
    }
  }

  async translate(settings: ContentSettings): Promise<PageStatus> {
    this.restore();
    this.settings = settings;
    const runtimeContext = translationRuntimeDiagnosticContext();
    if (
      settings.page.mode === "fast" &&
      pageFastProvider(settings) === "chrome-local" &&
      runtimeContext.frame === "child" &&
      runtimeContext.translatorPolicy === false
    ) {
      translationDiagnostic("PageTranslation", "restricted-frame-skipped", {
        ...runtimeContext,
        configuredSourceLanguage: settings.page.sourceLanguage,
        targetLanguage: settings.page.targetLanguage,
      });
      this.update({ state: "idle", total: 0, completed: 0, failed: 0 });
      return this.getStatus();
    }
    this.configureLocalProvider(settings);
    const controller = new AbortController();
    this.controller = controller;
    this.failureMessage = undefined;
    this.failureDetails = undefined;
    this.translationsByConfiguration.clear();
    this.clearInFlightTranslationClaims();
    this.update({ state: "scanning", total: 0, completed: 0, failed: 0 });

    let root: HTMLElement | null = document.body;
    if (!root) {
      root = await waitForDocumentBody(controller.signal);
      if (this.controller !== controller || controller.signal.aborted) {
        return this.getStatus();
      }
    }
    if (!root) {
      this.update({ ...this.status, state: "error" });
      return this.getStatus();
    }

    // Register before the first scan so DOM inserted while a provider request is
    // in flight always causes a later debounced rescan.
    this.observeDynamicContent(root);
    const segments = scanPageSegments(root, this.seen);
    this.trackResponsiveRevealRoots(root);
    this.documentSegments = segments;
    this.update({
      state: segments.length > 0 ? "translating" : "idle",
      total: segments.length,
      completed: 0,
      failed: 0,
    });

    await this.runTranslationSegments(segments, settings, controller);
    return this.getStatus();
  }

  restore(): PageStatus {
    this.controller?.abort();
    this.controller = undefined;
    this.stopDynamicObservation();
    this.renderer.restore();
    this.seen = new WeakSet<Text>();
    this.settings = undefined;
    this.releaseLocalProvider();
    this.sourceDetectionConfiguration = undefined;
    this.resolvedSourceLanguagesByScript.clear();
    this.failureMessage = undefined;
    this.failureDetails = undefined;
    this.translationsByConfiguration.clear();
    this.clearInFlightTranslationClaims();
    this.activeTranslationRuns = 0;
    this.documentSegments = [];
    this.invalidatedSegments = new WeakSet<PageSegment>();
    this.segmentOutcomes = new WeakMap<PageSegment, "completed" | "failed">();
    this.update({ state: "idle", total: 0, completed: 0, failed: 0 });
    return this.getStatus();
  }

  stopFollowingDynamicContent(): void {
    this.stopDynamicObservation();
  }

  resumeFollowingDynamicContent(): void {
    if (this.observer || !this.settings) return;
    if (!this.controller || this.controller.signal.aborted) {
      this.controller = new AbortController();
      this.configureLocalProvider(this.settings);
    }
    const root = document.body ?? document.documentElement;
    if (root) {
      this.observeDynamicContent(root);
      this.scheduleDynamicScan(root);
    }
  }

  private stopDynamicObservation(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.observedRoots = new WeakSet<Node>();
    if (this.mutationTimer !== undefined)
      window.clearTimeout(this.mutationTimer);
    this.mutationTimer = undefined;
    this.mutationQueuedAt = undefined;
    if (this.interactionTimer !== undefined)
      window.clearTimeout(this.interactionTimer);
    this.interactionTimer = undefined;
    this.interactionScanRoots.clear();
    if (this.responsiveScanTimer !== undefined)
      window.clearTimeout(this.responsiveScanTimer);
    this.responsiveScanTimer = undefined;
    this.responsiveScanRoots.clear();
    window.removeEventListener("resize", this.handleViewportResize);
    this.observedVisualViewport?.removeEventListener(
      "resize",
      this.handleViewportResize,
    );
    this.observedVisualViewport = undefined;
    document.removeEventListener("pointerover", this.handleInteractionReveal, {
      capture: true,
    });
    document.removeEventListener("focusin", this.handleInteractionReveal, {
      capture: true,
    });
    document.removeEventListener("click", this.handleInteractionReveal, {
      capture: true,
    });
    for (const eventRoot of this.toggleEventRoots) {
      eventRoot.removeEventListener("toggle", this.handleToggleReveal, {
        capture: true,
      });
    }
    this.toggleEventRoots.clear();
    if (this.shadowDiscoveryTimer !== undefined)
      window.clearInterval(this.shadowDiscoveryTimer);
    this.shadowDiscoveryTimer = undefined;
    for (const [slot, observation] of this.observedSlots) {
      slot.removeEventListener("slotchange", observation.listener);
    }
    this.observedSlots.clear();
    this.activeRoot = undefined;
  }

  cancelPendingTranslations(): PageStatus {
    if (!this.controller || this.controller.signal.aborted)
      return this.getStatus();
    if (this.activeTranslationRuns === 0) return this.getStatus();
    const resumeDynamicObservation = this.observer !== undefined;
    const root = this.activeRoot?.isConnected
      ? this.activeRoot
      : (document.body ?? document.documentElement);
    this.controller.abort();
    this.renderer.clearPending();
    this.stopDynamicObservation();
    this.controller = undefined;
    this.releaseLocalProvider();
    this.activeTranslationRuns = 0;
    const remaining = Math.max(
      0,
      this.status.total - this.status.completed - this.status.failed,
    );
    this.status.failed += remaining;
    this.finishStatus();
    if (resumeDynamicObservation && this.settings && root) {
      this.controller = new AbortController();
      this.configureLocalProvider(this.settings);
      // Reattach without scheduling a scan: cache clearing cancels the current
      // page task but future SPA, click and hover content must still translate.
      this.observeDynamicContent(root);
    }
    return this.getStatus();
  }

  handleCacheCleared(): PageStatus {
    const status = this.cancelPendingTranslations();
    this.translationsByConfiguration.clear();
    this.clearInFlightTranslationClaims();
    return status;
  }

  private async runTranslationSegments(
    segments: PageSegment[],
    settings: ContentSettings,
    controller: AbortController,
    documentSegments: PageSegment[] = segments,
  ): Promise<void> {
    if (this.controller !== controller || controller.signal.aborted) return;
    this.activeTranslationRuns += 1;
    this.renderer.markPending(segments);
    try {
      await this.translateSegments(
        segments,
        documentSegments,
        settings,
        controller,
        this.localProvider,
      );
    } finally {
      this.renderer.clearPending(segments);
      if (this.controller === controller) {
        this.activeTranslationRuns = Math.max(
          0,
          this.activeTranslationRuns - 1,
        );
        if (!controller.signal.aborted && this.activeTranslationRuns === 0) {
          if (this.settings) this.configureLocalProvider(this.settings);
          this.finishStatus();
        }
      }
    }
  }

  private configureLocalProvider(settings: ContentSettings): void {
    const fallbackSourceLanguage = supportedSourceLanguageHint(
      document.documentElement.lang,
    );
    const configuration =
      settings.page.mode === "fast" &&
      pageFastProvider(settings) === "chrome-local"
        ? [
            settings.page.sourceLanguage,
            settings.page.targetLanguage,
            fallbackSourceLanguage ?? "",
          ].join("\u001f")
        : undefined;
    if (configuration === this.localProviderConfiguration) return;
    this.releaseLocalProvider();
    this.localProviderConfiguration = configuration;
    if (configuration) {
      this.localProvider = new ChromeLocalProvider({
        keepAliveForTask: true,
        dynamicSourceLanguage: settings.page.sourceLanguage === "auto",
        ...(fallbackSourceLanguage ? { fallbackSourceLanguage } : {}),
      });
    }
  }

  private releaseLocalProvider(): void {
    const provider = this.localProvider;
    this.localProvider = undefined;
    this.localProviderConfiguration = undefined;
    void provider?.dispose();
  }

  private clearInFlightTranslationClaims(): void {
    for (const claims of this.inFlightTranslationsByConfiguration.values()) {
      for (const claim of claims.values()) {
        claim.resolve({ status: "failed" });
      }
    }
    this.inFlightTranslationsByConfiguration.clear();
  }

  private async translateSegments(
    segments: PageSegment[],
    allDocumentSegments: PageSegment[],
    settings: ContentSettings,
    controller: AbortController,
    localProvider?: ChromeLocalProvider,
  ): Promise<void> {
    const signal = controller.signal;
    const translationScope = pageTranslationScope();
    const documentSegments = [...allDocumentSegments].sort(
      (left, right) => left.documentOrder - right.documentOrder,
    );
    const automaticLocalSource = usesAutomaticLocalPageSource(settings);
    const skippedSegments = automaticLocalSource
      ? segments.filter(
          (segment) =>
            !hasTranslatableLanguageContent(segment.text) ||
            isPredominantlyTargetScript(
              segment.text,
              settings.page.targetLanguage,
            ),
        )
      : [];
    const skippedSet = new Set(skippedSegments);
    const translatableSegments =
      skippedSegments.length > 0
        ? segments.filter((segment) => !skippedSet.has(segment))
        : segments;
    if (skippedSegments.length > 0) {
      this.renderer.clearPending(skippedSegments);
      for (const segment of skippedSegments) {
        this.status.completed += 1;
        this.segmentOutcomes.set(segment, "completed");
      }
      this.update({ ...this.status, state: "translating" });
    }
    if (translatableSegments.length === 0) return;

    const detectionSegments = automaticLocalSource
      ? documentSegments.filter(
          (segment) =>
            hasTranslatableLanguageContent(segment.text) &&
            !isPredominantlyTargetScript(
              segment.text,
              settings.page.targetLanguage,
            ),
        )
      : documentSegments;
    const declaredSourceLanguage = supportedSourceLanguageHint(
      document.documentElement.lang,
    );
    const sourceLanguage =
      settings.page.sourceLanguage === "auto"
        ? automaticLocalSource
          ? "auto"
          : ((await detectDominantSourceLanguage(
              detectionSegments.map((segment) => segment.text),
              declaredSourceLanguage,
            )) ?? "auto")
        : settings.page.sourceLanguage;
    const sourceDetectionConfiguration = [
      pageFastProvider(settings),
      settings.page.sourceLanguage,
      settings.page.targetLanguage,
    ].join("\u001f");
    if (
      automaticLocalSource &&
      this.sourceDetectionConfiguration !== sourceDetectionConfiguration
    ) {
      this.sourceDetectionConfiguration = sourceDetectionConfiguration;
      this.resolvedSourceLanguagesByScript.clear();
    }
    const sourceLanguageById = automaticLocalSource
      ? await detectSegmentSourceLanguages(
          translatableSegments,
          declaredSourceLanguage,
          signal,
          this.resolvedSourceLanguagesByScript,
        )
      : new Map(
          translatableSegments.map((segment) => [segment.id, sourceLanguage]),
        );
    let routableSegments = translatableSegments;
    let unsupportedSourceSegments: PageSegment[] = [];
    if (
      automaticLocalSource &&
      pageFastProvider(settings) === "bergamot-local"
    ) {
      const installedPackIds = await queryInstalledBergamotPackIds();
      const targetLanguage = normalizeBergamotLanguage(
        settings.page.targetLanguage,
      );
      if (installedPackIds && targetLanguage) {
        const installed = new Set(installedPackIds);
        unsupportedSourceSegments = translatableSegments.filter((segment) => {
          const detected = sourceLanguageById.get(segment.id);
          const source = detected
            ? normalizeBergamotLanguage(detected)
            : undefined;
          return (
            source !== undefined &&
            source !== targetLanguage &&
            !hasInstalledBergamotRoute(source, targetLanguage, installed)
          );
        });
        // Automatic source selection translates every installed route and
        // leaves unsupported languages unchanged. An explicit source choice
        // still reaches the Provider and reports a missing package normally.
        if (unsupportedSourceSegments.length > 0) {
          const unsupported = new Set(unsupportedSourceSegments);
          routableSegments = translatableSegments.filter(
            (segment) => !unsupported.has(segment),
          );
          this.renderer.clearPending(unsupportedSourceSegments);
          for (const segment of unsupportedSourceSegments) {
            this.status.completed += 1;
            this.segmentOutcomes.set(segment, "completed");
          }
          this.update({ ...this.status, state: "translating" });
        }
      }
    }
    if (
      settings.page.mode === "fast" &&
      (pageFastProvider(settings) === "chrome-local" ||
        pageFastProvider(settings) === "bergamot-local")
    ) {
      const sourceDistribution = [...sourceLanguageById.values()].reduce<
        Record<string, number>
      >((counts, language) => {
        counts[language] = (counts[language] ?? 0) + 1;
        return counts;
      }, {});
      translationDiagnostic("PageTranslation", "plan", {
        ...translationRuntimeDiagnosticContext(),
        provider: pageFastProvider(settings),
        configuredSourceLanguage: settings.page.sourceLanguage,
        declaredSourceLanguage: declaredSourceLanguage ?? "",
        resolvedSourceLanguage: sourceLanguage,
        sourceDistribution,
        targetLanguage: settings.page.targetLanguage,
        inputSegments: segments.length,
        inputCharacters: segments.reduce(
          (total, segment) => total + segment.text.length,
          0,
        ),
        targetScriptSkippedSegments: skippedSegments.length,
        targetScriptSkippedCharacters: skippedSegments.reduce(
          (total, segment) => total + segment.text.length,
          0,
        ),
        translatableSegments: translatableSegments.length,
        routableSegments: routableSegments.length,
        unsupportedSourceSkippedSegments: unsupportedSourceSegments.length,
        detectionSegments: detectionSegments.length,
      });
    }
    if (
      signal.aborted ||
      this.controller !== controller ||
      pageTranslationScope() !== translationScope
    ) {
      return;
    }

    const prioritizedSegments = prioritizeSegmentsForViewport(routableSegments);
    const contextualizedSegments = pageTranslationSegments(
      documentSegments,
      prioritizedSegments,
      settings.page.mode === "ai",
    );
    const configurationIdentity = `${translationScope}\u001f${pageTranslationConfigurationIdentity(settings)}\u001f${sourceLanguage}`;
    const translationsByReuseIdentity =
      this.translationsByConfiguration.get(configurationIdentity) ??
      new Map<string, string>();
    this.translationsByConfiguration.set(
      configurationIdentity,
      translationsByReuseIdentity,
    );
    const claimsByReuseIdentity =
      this.inFlightTranslationsByConfiguration.get(configurationIdentity) ??
      new Map<string, PageTranslationClaim>();
    this.inFlightTranslationsByConfiguration.set(
      configurationIdentity,
      claimsByReuseIdentity,
    );
    const reuseIdentityById = new Map(
      contextualizedSegments.map((segment) => [
        segment.id,
        `${sourceBucketIdentity(
          segment,
          sourceLanguageById.get(segment.id) ?? sourceLanguage,
        )}\u001f${
          settings.page.mode === "ai"
            ? translationSegmentReuseIdentity(segment)
            : `${segment.format ?? "plain-text"}\u001f${normalizeTranslationText(segment.text)}`
        }`,
      ]),
    );
    const normalizedGroups = groupNormalizedPageSegments(
      prioritizedSegments,
      reuseIdentityById,
    );
    const groupByRepresentativeId = new Map(
      normalizedGroups.map((group) => [group.representative.id, group]),
    );
    const batches = partitionBatchesBySource(
      createProgressiveBatches(
        normalizedGroups.map((group) => group.representative),
        documentSegments,
        settings,
        reuseIdentityById,
      ),
      sourceLanguageById,
    );
    const translateBatch = async (batch: PageSegment[]): Promise<void> => {
      if (signal.aborted) return;
      const batchSourceLanguage =
        sourceLanguageById.get(batch[0]?.id ?? "") ?? sourceLanguage;
      const processedIds = new Set<string>();
      const exhaustedIds = new Set<string>();
      const receivedResults = new Map<string, string>();
      const completedMembers = new Set<PageSegment>();
      const failedMembers = new Set<PageSegment>();
      const applyAttempts = new Map<string, number>();
      const applyRetries = new Map<string, Promise<void>>();
      const applyResult = (result: TranslationResult): void => {
        if (
          signal.aborted ||
          this.controller !== controller ||
          pageTranslationScope() !== translationScope ||
          processedIds.has(result.id) ||
          exhaustedIds.has(result.id)
        ) {
          return;
        }
        const group = groupByRepresentativeId.get(result.id);
        if (!group) return;
        // A complete segment result is available now. Remove its pending cue
        // before attempting DOM application, including the short retry path.
        this.renderer.clearPending(group.members);
        receivedResults.set(result.id, result.translatedText);
        const reuseIdentity = reuseIdentityById.get(group.representative.id);
        if (reuseIdentity) {
          translationsByReuseIdentity.set(reuseIdentity, result.translatedText);
        }
        for (const segment of group.members) {
          if (
            this.invalidatedSegments.has(segment) ||
            completedMembers.has(segment) ||
            failedMembers.has(segment)
          ) {
            continue;
          }
          const applied = this.renderer.apply(
            segment,
            result.translatedText,
            settings.page.displayMode,
            settings.page.targetLanguage,
          );
          if (applied) {
            this.status.completed += 1;
            completedMembers.add(segment);
            this.segmentOutcomes.set(segment, "completed");
          }
        }
        const pendingMembers = group.members.filter(
          (segment) =>
            !this.invalidatedSegments.has(segment) &&
            !completedMembers.has(segment) &&
            !failedMembers.has(segment),
        );
        if (pendingMembers.length === 0) {
          processedIds.add(result.id);
          applyRetries.delete(result.id);
        } else {
          const attempts = (applyAttempts.get(result.id) ?? 0) + 1;
          applyAttempts.set(result.id, attempts);
          if (attempts >= RENDER_APPLY_MAX_ATTEMPTS) {
            exhaustedIds.add(result.id);
            for (const segment of pendingMembers) {
              failedMembers.add(segment);
              this.status.failed += 1;
              this.segmentOutcomes.set(segment, "failed");
            }
            this.failureMessage ??=
              "页面内容在翻译期间发生变化，译文未能写入。";
            applyRetries.delete(result.id);
          } else if (!applyRetries.has(result.id)) {
            const retry = new Promise<void>((resolve) => {
              window.setTimeout(() => {
                applyRetries.delete(result.id);
                applyResult(result);
                resolve();
              }, RENDER_APPLY_RETRY_DELAY_MS);
            });
            applyRetries.set(result.id, retry);
          }
        }
        this.update({
          ...this.status,
          state: "translating",
          ...(this.failureMessage ? { message: this.failureMessage } : {}),
        });
      };
      const drainApplyRetries = async (): Promise<void> => {
        while (applyRetries.size > 0) {
          await Promise.all([...applyRetries.values()]);
        }
      };
      for (const segment of batch) {
        const reuseIdentity = reuseIdentityById.get(segment.id);
        const translatedText = reuseIdentity
          ? translationsByReuseIdentity.get(reuseIdentity)
          : undefined;
        if (translatedText) applyResult({ id: segment.id, translatedText });
      }
      const requestBatch = batch.filter(
        (segment) => !receivedResults.has(segment.id),
      );
      if (requestBatch.length === 0) {
        await drainApplyRetries();
        return;
      }
      const ownedRequestBatch: PageSegment[] = [];
      const ownedClaims = new Map<string, PageTranslationClaim>();
      const waitingClaims: Array<{
        segment: PageSegment;
        claim: PageTranslationClaim;
      }> = [];
      for (const segment of requestBatch) {
        const reuseIdentity = reuseIdentityById.get(segment.id);
        const existing = reuseIdentity
          ? claimsByReuseIdentity.get(reuseIdentity)
          : undefined;
        if (existing) {
          waitingClaims.push({ segment, claim: existing });
          continue;
        }
        ownedRequestBatch.push(segment);
        if (reuseIdentity) {
          const claim = createPageTranslationClaim();
          claimsByReuseIdentity.set(reuseIdentity, claim);
          ownedClaims.set(segment.id, claim);
        }
      }
      const settleOwnedClaim = (
        segment: PageSegment,
        result: PageTranslationClaimResult,
      ): void => {
        const claim = ownedClaims.get(segment.id);
        if (!claim) return;
        claim.resolve(result);
        const reuseIdentity = reuseIdentityById.get(segment.id);
        if (
          reuseIdentity &&
          claimsByReuseIdentity.get(reuseIdentity) === claim
        ) {
          claimsByReuseIdentity.delete(reuseIdentity);
        }
      };
      const markFailed = (
        representatives: readonly PageSegment[],
      ): PageSegment[] => {
        const currentSegments = representatives.flatMap((representative) =>
          (
            groupByRepresentativeId.get(representative.id)?.members ?? [
              representative,
            ]
          ).filter(
            (segment) =>
              !this.invalidatedSegments.has(segment) &&
              !completedMembers.has(segment) &&
              !failedMembers.has(segment),
          ),
        );
        this.status.failed += currentSegments.length;
        for (const segment of currentSegments) {
          this.renderer.clearPending([segment]);
          failedMembers.add(segment);
          this.segmentOutcomes.set(segment, "failed");
        }
        return currentSegments;
      };
      const completeWithoutTranslation = (
        representatives: readonly PageSegment[],
      ): void => {
        const currentSegments = representatives.flatMap((representative) =>
          (
            groupByRepresentativeId.get(representative.id)?.members ?? [
              representative,
            ]
          ).filter(
            (segment) =>
              !this.invalidatedSegments.has(segment) &&
              !completedMembers.has(segment) &&
              !failedMembers.has(segment),
          ),
        );
        for (const segment of currentSegments) {
          this.renderer.clearPending([segment]);
          completedMembers.add(segment);
          this.status.completed += 1;
          this.segmentOutcomes.set(segment, "completed");
        }
      };
      const ownedWork = async (): Promise<void> => {
        if (ownedRequestBatch.length === 0) return;
        const applyOwnedResult = (result: TranslationResult): void => {
          applyResult(result);
          const segment = ownedRequestBatch.find(
            (candidate) => candidate.id === result.id,
          );
          if (segment && result.translatedText.trim()) {
            settleOwnedClaim(segment, {
              status: "translated",
              translatedText: result.translatedText,
            });
          }
        };
        let pendingRequestBatch = [...ownedRequestBatch];
        let lastError: unknown;
        let attempts = 0;
        try {
          for (
            let attempt = 0;
            attempt < AI_BATCH_MAX_ATTEMPTS && pendingRequestBatch.length > 0;
            attempt += 1
          ) {
            attempts += 1;
            try {
              const attemptedBatch = pendingRequestBatch;
              const results = await this.batchPermits.run(signal, () =>
                this.execute(
                  attemptedBatch,
                  documentSegments,
                  settings,
                  batchSourceLanguage,
                  signal,
                  applyOwnedResult,
                  localProvider,
                ),
              );
              if (
                signal.aborted ||
                this.controller !== controller ||
                pageTranslationScope() !== translationScope
              ) {
                return;
              }
              const byId = validatedResultMap(attemptedBatch, results);
              for (const segment of attemptedBatch) {
                if (processedIds.has(segment.id)) continue;
                const translatedText = byId.get(segment.id);
                if (translatedText !== undefined) {
                  applyOwnedResult({ id: segment.id, translatedText });
                }
              }
              pendingRequestBatch = ownedRequestBatch.filter(
                (segment) => !receivedResults.has(segment.id),
              );
              lastError = undefined;
            } catch (error) {
              if (signal.aborted) return;
              await drainApplyRetries();
              lastError = error;
              pendingRequestBatch = ownedRequestBatch.filter(
                (segment) => !receivedResults.has(segment.id),
              );
              if (isAutomaticLocalUnsupportedSource(error, settings)) {
                completeWithoutTranslation(pendingRequestBatch);
                for (const segment of pendingRequestBatch) {
                  settleOwnedClaim(segment, { status: "skipped" });
                }
                pendingRequestBatch = [];
                lastError = undefined;
                this.update({ ...this.status, state: "translating" });
                break;
              }
              const canRetry =
                settings.page.mode === "ai" &&
                attempt + 1 < AI_BATCH_MAX_ATTEMPTS &&
                pendingRequestBatch.length > 0 &&
                error instanceof NoriTransError &&
                error.retryable;
              if (!canRetry) break;
            }
          }

          if (pendingRequestBatch.length > 0) {
            const currentSegments = markFailed(pendingRequestBatch);
            if (currentSegments.length > 0) {
              this.failureMessage ??=
                lastError instanceof Error
                  ? lastError.message
                  : "翻译请求失败。";
              if (lastError instanceof NoriTransError) {
                const receivedRequestIds = ownedRequestBatch.filter((segment) =>
                  receivedResults.has(segment.id),
                ).length;
                this.failureDetails ??=
                  lastError.details ??
                  `Provider error code: ${lastError.code}. Provider message: ${lastError.message.slice(0, 400)}. This batch received ${receivedRequestIds} of ${ownedRequestBatch.length} requested result IDs; ${ownedRequestBatch.length - receivedRequestIds} result IDs were missing after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.`;
              }
            }
          }
        } finally {
          for (const segment of ownedRequestBatch) {
            settleOwnedClaim(segment, { status: "failed" });
          }
        }
      };
      const waitingWork = Promise.all(
        waitingClaims.map(async ({ segment, claim }) => {
          const result = await claim.promise;
          if (
            signal.aborted ||
            this.controller !== controller ||
            pageTranslationScope() !== translationScope
          )
            return;
          if (result.status === "translated") {
            applyResult({
              id: segment.id,
              translatedText: result.translatedText,
            });
            return;
          }
          if (result.status === "skipped") {
            completeWithoutTranslation([segment]);
            return;
          }
          markFailed([segment]);
          this.failureMessage ??= "翻译请求失败。";
        }),
      );
      await Promise.all([ownedWork(), waitingWork]);
      await drainApplyRetries();
      if (signal.aborted) return;
      if (claimsByReuseIdentity.size === 0) {
        this.inFlightTranslationsByConfiguration.delete(configurationIdentity);
      }
      if (this.controller !== controller) return;
      this.update({
        ...this.status,
        // Concurrent workers may still be translating later batches. Keep
        // the task cancellable until every active run has settled; only
        // finishStatus publishes partial/error terminal states.
        state: "translating",
        ...(this.failureMessage ? { message: this.failureMessage } : {}),
        ...(this.failureDetails ? { details: this.failureDetails } : {}),
      });
    };

    // Keep both local and remote providers bounded while allowing independent
    // page batches to make visible progress together.
    let nextBatch = 0;
    const worker = async (): Promise<void> => {
      while (!signal.aborted && this.controller === controller) {
        const batch = batches[nextBatch++];
        if (!batch) return;
        await translateBatch(batch);
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            settings.page.mode === "ai"
              ? AI_BATCH_CONCURRENCY
              : FAST_BATCH_CONCURRENCY,
            batches.length,
          ),
        },
        () => worker(),
      ),
    );
  }

  private async execute(
    segments: PageSegment[],
    documentSegments: PageSegment[],
    settings: ContentSettings,
    sourceLanguage: string,
    signal: AbortSignal,
    onProgress?: (result: TranslationResult) => void,
    localProvider?: ChromeLocalProvider,
  ): Promise<TranslationResult[]> {
    const pageScope = pageTranslationScope();
    const requestSegments = pageTranslationSegments(
      documentSegments,
      segments,
      settings.page.mode === "ai",
    );
    const expanded = expandRequestSegments(requestSegments);
    const progressByPartId = new Map<string, TranslationResult>();
    const expectedPartIds = new Set(
      expanded.segments.map((segment) => segment.id),
    );
    const expandedById = new Map(
      expanded.segments.map((segment) => [segment.id, segment]),
    );
    const reportExpandedProgress = (result: TranslationResult): void => {
      if (
        !expectedPartIds.has(result.id) ||
        progressByPartId.has(result.id) ||
        !result.translatedText.trim()
      ) {
        return;
      }
      progressByPartId.set(result.id, result);
      for (const segment of requestSegments) {
        const partIds = expanded.partsByOriginalId.get(segment.id) ?? [];
        if (
          partIds.length === 0 ||
          !partIds.every((id) => progressByPartId.has(id))
        ) {
          continue;
        }
        const translatedText = joinTranslatedFragments(
          partIds,
          expandedById,
          (id) => progressByPartId.get(id)?.translatedText,
        );
        if (translatedText !== undefined) {
          onProgress?.({ id: segment.id, translatedText });
        }
      }
    };
    const request = {
      sourceLanguage,
      targetLanguage: settings.page.targetLanguage,
      mode: settings.page.mode,
      responseMode: settings.page.aiResponseMode,
      segments: expanded.segments,
      prompt: settings.provider.systemPrompt,
      scope: pageScope,
      ...(settings.page.mode === "ai" && settings.page.modelOverride
        ? { modelOverride: settings.page.modelOverride }
        : {}),
      ...(settings.page.mode === "fast"
        ? { providerOverride: pageFastProvider(settings) }
        : {}),
    } as const;

    if (
      settings.page.mode === "fast" &&
      pageFastProvider(settings) === "chrome-local"
    ) {
      const cached: TranslationResult[] = [];
      const cacheEntries: Array<{
        segment: TranslationSegment;
        key: string;
        translatedText: string | undefined;
      }> = await Promise.all(
        expanded.segments.map(async (segment) => {
          const key = await translationCacheKey({
            providerId: "chrome-local",
            model: "",
            promptVersion: promptVersion(settings.provider.systemPrompt),
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
            mode: "fast",
            text: translationSegmentCacheText(segment),
            scope: request.scope,
          });
          return {
            segment,
            key,
            translatedText: undefined,
          };
        }),
      );
      const entriesByKey = new Map<string, typeof cacheEntries>();
      for (const entry of cacheEntries) {
        const matches = entriesByKey.get(entry.key) ?? [];
        matches.push(entry);
        entriesByKey.set(entry.key, matches);
      }
      await Promise.all(
        [...entriesByKey.values()].map(async (entries) => {
          const first = entries[0];
          if (!first) return;
          const read = await this.cacheReads.read(first.key, signal);
          for (const entry of entries) {
            let translatedText = read.translatedText;
            if (translatedText !== undefined) {
              try {
                assertValidProtectedTranslation(entry.segment, translatedText);
              } catch {
                translatedText = undefined;
              }
            }
            entry.translatedText = translatedText;
          }
        }),
      );
      const missing: Array<{ segment: TranslationSegment; key: string }> = [];
      for (const entry of cacheEntries) {
        if (entry.translatedText === undefined) missing.push(entry);
        else {
          const result = {
            id: entry.segment.id,
            translatedText: entry.translatedText,
          };
          cached.push(result);
          reportExpandedProgress(result);
        }
      }
      translationDiagnostic("PageTranslation", "chrome-local-cache", {
        ...translationRuntimeDiagnosticContext(),
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        requestedSegments: cacheEntries.length,
        requestedCharacters: cacheEntries.reduce(
          (total, entry) => total + entry.segment.text.length,
          0,
        ),
        cacheHits: cached.length,
        cacheMisses: missing.length,
      });
      if (missing.length > 0) {
        const keys = new Map(
          missing.map(({ segment, key }) => [segment.id, key]),
        );
        const progressed = new Set<string>();
        const persistAndReport = async (
          result: TranslationResult,
        ): Promise<void> => {
          if (signal.aborted || progressed.has(result.id)) return;
          const key = keys.get(result.id);
          if (key) await setSharedCachedTranslation(key, result.translatedText);
          if (signal.aborted) return;
          progressed.add(result.id);
          reportExpandedProgress(result);
        };
        const translated = await scheduleTranslation(
          localProvider ?? new ChromeLocalProvider(),
          {
            ...request,
            segments: missing.map(({ segment }) => segment),
          },
          signal,
          persistAndReport,
        );
        if (signal.aborted) {
          throw new DOMException("Translation cancelled", "AbortError");
        }
        await Promise.all(
          translated.map(async (result) => {
            if (!progressed.has(result.id)) await persistAndReport(result);
          }),
        );
        cached.push(...translated);
      }
      return collapseRequestResults(
        requestSegments,
        expanded.segments,
        expanded.partsByOriginalId,
        cached,
      );
    }

    const requestId = runtimeId("page-translation");
    const abort = () => {
      void browser.runtime.sendMessage({ type: "TRANSLATE_CANCEL", requestId });
    };
    signal.addEventListener("abort", abort, { once: true });
    const unsubscribeProgress = subscribeTranslationProgress(
      requestId,
      reportExpandedProgress,
    );
    try {
      const response: TranslationResponse = await browser.runtime.sendMessage({
        type: "TRANSLATE",
        requestId,
        request,
      });
      if (!response.ok || !response.results) {
        throw new NoriTransError(
          response.error?.message ?? "翻译请求失败。",
          response.error?.code ?? "request_failed",
          response.error?.retryable ?? false,
          response.error?.details,
          response.error?.reason,
        );
      }
      return collapseRequestResults(
        requestSegments,
        expanded.segments,
        expanded.partsByOriginalId,
        response.results,
      );
    } finally {
      unsubscribeProgress();
      signal.removeEventListener("abort", abort);
    }
  }

  private observeDynamicContent(root: Element): void {
    this.observer?.disconnect();
    this.activeRoot = root;
    this.observer = new MutationObserver((mutations) => {
      const pageMutations = mutations.filter(
        (mutation) => !isExtensionOnlyMutation(mutation),
      );
      const currentRoot = document.body ?? document.documentElement;
      const rootChanged = currentRoot !== this.activeRoot;
      this.activeRoot = currentRoot;
      const discoveredRoot = this.observeAvailableRoots(currentRoot);
      const changedTextNodes = pageMutations.flatMap((mutation) =>
        mutation.type === "characterData" &&
        mutation.target instanceof Text &&
        !this.renderer.ownsCurrentText(mutation.target)
          ? [mutation.target]
          : [],
      );
      const changedAnchors = new Set<Element>();
      const controlledRoots = new Set<Element>();
      const failedRevealRoots = new Set<Element>();
      for (const mutation of pageMutations) {
        for (const node of addedTextNodes(mutation)) {
          if (node.isConnected) {
            changedAnchors.add(pageSegmentAnchor(node, currentRoot));
          }
        }
        if (
          mutation.type === "characterData" &&
          mutation.target instanceof Text &&
          mutation.target.isConnected &&
          !this.renderer.ownsCurrentText(mutation.target)
        ) {
          changedAnchors.add(pageSegmentAnchor(mutation.target, currentRoot));
        }
        if (changesExplicitTranslationExclusion(mutation)) {
          for (const segment of this.documentSegments) {
            if (
              segment.anchor === mutation.target ||
              composedContains(segment.anchor, mutation.target) ||
              composedContains(mutation.target, segment.anchor)
            ) {
              changedAnchors.add(segment.anchor);
            }
          }
        }
        if (
          mutation.type === "attributes" &&
          mutation.target instanceof Element &&
          (mutation.attributeName === "slot" ||
            mutation.attributeName === "name")
        ) {
          const textNodes =
            mutation.target instanceof HTMLSlotElement
              ? composedSlotTextNodes(mutation.target)
              : descendantTextNodes([mutation.target]);
          for (const node of textNodes) {
            if (node.isConnected && !isExtensionUiNode(node)) {
              changedAnchors.add(pageSegmentAnchor(node, currentRoot));
            }
          }
        }
        if (
          mutation.type === "attributes" &&
          mutation.target instanceof Element &&
          mutation.attributeName &&
          CONTROLLED_REVEAL_ATTRIBUTES.has(mutation.attributeName)
        ) {
          controlledRoots.add(mutation.target);
          for (const controlled of controlledRevealRoots(mutation.target)) {
            controlledRoots.add(controlled);
          }
        }
        if (
          mutation.type === "attributes" &&
          mutation.target instanceof Element &&
          mutation.attributeName &&
          VISIBILITY_REVEAL_ATTRIBUTES.has(mutation.attributeName)
        ) {
          failedRevealRoots.add(mutation.target);
          // A nested visibility change alters the text membership of its
          // enclosing semantic block. Replace that block as one unit so a
          // newly visible child cannot create a second bilingual companion.
          for (const segment of this.documentSegments) {
            if (
              visibilityMutationChangesSegmentMembership(
                mutation.target,
                segment,
                currentRoot,
              )
            ) {
              changedAnchors.add(segment.anchor);
            }
          }
        }
        if (mutation.type === "childList" && mutation.removedNodes.length > 0) {
          const renderedAnchor = this.renderer.sourceAnchorContaining(
            mutation.target,
          );
          if (renderedAnchor) changedAnchors.add(renderedAnchor);
        }
      }
      // A Provider result can arrive while a previously visible source is
      // temporarily hidden by a menu, carousel, responsive breakpoint, or
      // SPA transition. The short renderer retry window deliberately stops
      // waiting, but a later visibility mutation must make that failed source
      // eligible again. Invalidating only failed segments keeps already
      // translated content stable and lets the in-memory translation map apply
      // the received result without another Provider request.
      for (const controlledRoot of controlledRoots) {
        failedRevealRoots.add(controlledRoot);
      }
      if (failedRevealRoots.size > 0) {
        for (const segment of this.documentSegments) {
          if (this.segmentOutcomes.get(segment) !== "failed") continue;
          const affected = [...failedRevealRoots].some(
            (revealRoot) =>
              revealRoot === segment.anchor ||
              composedContains(revealRoot, segment.anchor) ||
              segment.nodes.some((node) => composedContains(revealRoot, node)),
          );
          if (affected) changedAnchors.add(segment.anchor);
        }
      }
      this.invalidateAnchors(changedAnchors);
      const discardedDetachedSegments = this.discardDetachedSegments();
      const hasVisibilityAttributeChange = pageMutations.some(
        (mutation) =>
          !(
            mutation.type === "attributes" &&
            mutation.attributeName &&
            CONTROLLED_REVEAL_ATTRIBUTES.has(mutation.attributeName)
          ) && attributeMayRevealUnseenText(mutation, this.seen),
      );
      this.queueInteractionScanRoots(controlledRoots);
      if (
        changedTextNodes.length === 0 &&
        changedAnchors.size === 0 &&
        !hasVisibilityAttributeChange &&
        !rootChanged &&
        !discoveredRoot &&
        !discardedDetachedSegments &&
        !pageMutations.some((mutation) => mutation.addedNodes.length > 0)
      ) {
        return;
      }
      for (const node of changedTextNodes) this.seen.delete(node);
      if (discardedDetachedSegments) this.finishStatus();
      this.scheduleDynamicScan(currentRoot);
    });
    this.observeAvailableRoots(root);
    document.addEventListener("pointerover", this.handleInteractionReveal, {
      capture: true,
    });
    document.addEventListener("focusin", this.handleInteractionReveal, {
      capture: true,
    });
    document.addEventListener("click", this.handleInteractionReveal, {
      capture: true,
    });
    window.addEventListener("resize", this.handleViewportResize, {
      passive: true,
    });
    this.observedVisualViewport = window.visualViewport ?? undefined;
    this.observedVisualViewport?.addEventListener(
      "resize",
      this.handleViewportResize,
      { passive: true },
    );
    this.shadowDiscoveryTimer = window.setInterval(() => {
      const currentRoot = document.body ?? document.documentElement;
      const rootChanged = currentRoot !== this.activeRoot;
      this.activeRoot = currentRoot;
      if (rootChanged || this.observeAvailableRoots(currentRoot)) {
        this.scheduleDynamicScan(currentRoot);
      }
    }, SHADOW_ROOT_DISCOVERY_INTERVAL_MS);
  }

  private readonly handleInteractionReveal = (event: Event): void => {
    if (!this.settings || !this.controller || this.controller.signal.aborted)
      return;
    const target = event
      .composedPath()
      .find(
        (candidate): candidate is Element =>
          candidate instanceof Element &&
          candidate !== document.body &&
          candidate !== document.documentElement &&
          !isExtensionUiNode(candidate),
      );
    if (!target || !target.isConnected) return;
    if (
      event instanceof MouseEvent &&
      event.relatedTarget instanceof Node &&
      target.contains(event.relatedTarget)
    ) {
      return;
    }

    const candidates = new Set<Element>();
    for (const candidate of event.composedPath()) {
      if (
        !(candidate instanceof Element) ||
        candidate === document.body ||
        candidate === document.documentElement ||
        isExtensionUiNode(candidate)
      ) {
        continue;
      }
      candidates.add(candidate);
      if (candidates.size >= INTERACTION_PATH_ROOT_LIMIT) break;
    }
    const controller = target.closest<HTMLElement>(
      "[aria-controls],[aria-owns],[popovertarget]",
    );
    if (controller) {
      for (const controlled of controlledRevealRoots(controller)) {
        candidates.add(controlled);
      }
    }

    this.queueInteractionScanRoots(candidates);
  };

  private readonly handleToggleReveal = (event: Event): void => {
    const target = event
      .composedPath()
      .find(
        (candidate): candidate is Element =>
          candidate instanceof Element && !isExtensionUiNode(candidate),
      );
    if (!target || !target.isConnected) return;
    this.queueInteractionScanRoots([target]);
  };

  private queueInteractionScanRoots(candidates: Iterable<Element>): void {
    if (!this.settings || !this.controller || this.controller.signal.aborted)
      return;
    for (const candidate of candidates) {
      if (!candidate.isConnected || isExtensionUiNode(candidate)) continue;
      if (this.interactionScanRoots.size >= INTERACTION_SCAN_ROOT_LIMIT) {
        if (this.interactionTimer !== undefined) {
          window.clearTimeout(this.interactionTimer);
          this.interactionTimer = undefined;
        }
        // Flush the bounded group before accepting more reveal roots. Rapid
        // hover/focus activity can otherwise drop the ninth menu permanently.
        this.scanInteractionReveals();
      }
      this.interactionScanRoots.add(candidate);
    }
    if (this.interactionTimer !== undefined)
      window.clearTimeout(this.interactionTimer);
    this.interactionTimer = window.setTimeout(() => {
      this.interactionTimer = undefined;
      this.scanInteractionReveals();
    }, INTERACTION_SCAN_DEBOUNCE_MS);
  }

  private scanInteractionReveals(): void {
    if (!this.settings || !this.controller || this.controller.signal.aborted) {
      this.interactionScanRoots.clear();
      return;
    }
    const roots = [...this.interactionScanRoots];
    this.interactionScanRoots.clear();
    this.invalidateFailedRevealSegments(roots);
    let segments = roots.flatMap((root) =>
      root.isConnected ? scanPageSegments(root, this.seen) : [],
    );
    const existingAnchors = new Set(
      this.documentSegments.map((segment) => segment.anchor),
    );
    const expandedAnchors = new Set(
      segments
        .filter((segment) => existingAnchors.has(segment.anchor))
        .map((segment) => segment.anchor),
    );
    if (expandedAnchors.size > 0) {
      // A pure CSS :hover/:focus reveal does not emit a DOM mutation. When an
      // unseen inline child joins an already translated semantic block, rebuild
      // that whole block instead of appending a second bilingual companion for
      // only the newly visible child.
      for (const segment of segments) {
        if (!expandedAnchors.has(segment.anchor)) continue;
        for (const node of segment.nodes) this.seen.delete(node);
      }
      this.invalidateAnchors(expandedAnchors);
      const documentRoot = document.body ?? document.documentElement;
      segments = [
        ...segments.filter((segment) => !expandedAnchors.has(segment.anchor)),
        ...scanPageSegments(documentRoot, this.seen),
      ];
    }
    for (const root of roots) this.trackResponsiveRevealRoots(root);
    this.startDynamicSegments(segments);
  }

  private invalidateFailedRevealSegments(roots: readonly Element[]): void {
    if (roots.length === 0) return;
    const changedAnchors = new Set<Element>();
    for (const segment of this.documentSegments) {
      if (this.segmentOutcomes.get(segment) !== "failed") continue;
      const affected = roots.some(
        (root) =>
          root === segment.anchor ||
          composedContains(root, segment.anchor) ||
          composedContains(segment.anchor, root) ||
          segment.nodes.some(
            (node) =>
              composedContains(root, node) || composedContains(node, root),
          ),
      );
      if (affected) changedAnchors.add(segment.anchor);
    }
    this.invalidateAnchors(changedAnchors);
  }

  private readonly handleViewportResize = (): void => {
    if (!this.settings || !this.controller || this.controller.signal.aborted)
      return;
    if (this.responsiveScanTimer !== undefined) {
      window.clearTimeout(this.responsiveScanTimer);
    }
    this.responsiveScanTimer = window.setTimeout(() => {
      this.responsiveScanTimer = undefined;
      this.scanResponsiveReveals();
    }, RESPONSIVE_SCAN_DEBOUNCE_MS);
  };

  private scanResponsiveReveals(): void {
    if (!this.settings || !this.controller || this.controller.signal.aborted) {
      this.responsiveScanRoots.clear();
      return;
    }
    this.renderer.reconcile();
    const roots = [...this.responsiveScanRoots].filter(
      (root) => root.isConnected,
    );
    this.responsiveScanRoots.clear();
    const segments = roots.flatMap((root) => scanPageSegments(root, this.seen));
    for (const root of roots) this.trackResponsiveRevealRoots(root);
    this.startDynamicSegments(segments);
  }

  private trackResponsiveRevealRoots(root: Element): void {
    for (const node of descendantTextNodes([root])) {
      if (this.seen.has(node) || isExtensionUiNode(node)) continue;
      const hiddenRoot = responsiveRevealRoot(node, root);
      if (!hiddenRoot || this.responsiveScanRoots.has(hiddenRoot)) continue;
      for (const existing of this.responsiveScanRoots) {
        if (hiddenRoot.contains(existing)) {
          this.responsiveScanRoots.delete(existing);
        }
      }
      if (
        [...this.responsiveScanRoots].some((existing) =>
          existing.contains(hiddenRoot),
        )
      ) {
        continue;
      }
      if (this.responsiveScanRoots.size >= RESPONSIVE_SCAN_ROOT_LIMIT) return;
      this.responsiveScanRoots.add(hiddenRoot);
    }
  }

  private scheduleDynamicScan(root: Element): void {
    const now = Date.now();
    this.mutationQueuedAt ??= now;
    const elapsed = Math.max(0, now - this.mutationQueuedAt);
    const delay = Math.max(
      0,
      Math.min(DYNAMIC_SCAN_DEBOUNCE_MS, DYNAMIC_SCAN_MAX_WAIT_MS - elapsed),
    );
    if (this.mutationTimer !== undefined)
      window.clearTimeout(this.mutationTimer);
    this.mutationTimer = window.setTimeout(() => {
      this.mutationTimer = undefined;
      this.mutationQueuedAt = undefined;
      if (!this.settings || !this.controller || this.controller.signal.aborted)
        return;
      const currentRoot = this.activeRoot?.isConnected
        ? this.activeRoot
        : (document.body ?? document.documentElement);
      this.discardDetachedSegments();
      const segments = scanPageSegments(currentRoot ?? root, this.seen);
      this.trackResponsiveRevealRoots(currentRoot ?? root);
      this.startDynamicSegments(segments);
    }, delay);
  }

  private startDynamicSegments(segments: PageSegment[]): void {
    if (
      segments.length === 0 ||
      !this.settings ||
      !this.controller ||
      this.controller.signal.aborted
    ) {
      return;
    }
    this.documentSegments = [...this.documentSegments, ...segments].sort(
      (left, right) => {
        if (left.anchor === right.anchor)
          return left.documentOrder - right.documentOrder;
        const position = left.anchor.compareDocumentPosition(right.anchor);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return left.documentOrder - right.documentOrder;
      },
    );
    for (const [index, segment] of this.documentSegments.entries()) {
      segment.documentOrder = index;
    }
    this.status.total += segments.length;
    this.update({ ...this.status, state: "translating" });
    void this.runTranslationSegments(
      segments,
      this.settings,
      this.controller,
      this.documentSegments,
    );
  }

  private observeAvailableRoots(root: Element): boolean {
    if (!this.observer) return false;
    const shadowRoots = discoverOpenShadowRoots(root).filter(
      (candidate) => !isExtensionUiNode(candidate.host),
    );
    const candidates: Node[] = [document, ...shadowRoots];
    let discovered = false;
    for (const candidate of candidates) {
      if (this.observedRoots.has(candidate)) continue;
      this.observedRoots.add(candidate);
      discovered = true;
      this.observer.observe(candidate, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          "style",
          "class",
          "hidden",
          "aria-hidden",
          "aria-expanded",
          "inert",
          "open",
          "data-state",
          "data-open",
          "popovertarget",
          "translate",
          "contenteditable",
          "slot",
          "name",
        ],
        attributeOldValue: true,
      });
      if (candidate instanceof Document || candidate instanceof ShadowRoot) {
        candidate.addEventListener("toggle", this.handleToggleReveal, {
          capture: true,
        });
        this.toggleEventRoots.add(candidate);
      }
    }
    if (this.observeSlots(shadowRoots)) discovered = true;
    return discovered;
  }

  private observeSlots(shadowRoots: ShadowRoot[]): boolean {
    const available = new Set(
      shadowRoots.flatMap((root) => [
        ...root.querySelectorAll<HTMLSlotElement>("slot"),
      ]),
    );
    for (const [slot, observation] of this.observedSlots) {
      if (available.has(slot) && slot.isConnected) continue;
      slot.removeEventListener("slotchange", observation.listener);
      this.observedSlots.delete(slot);
    }

    let discovered = false;
    for (const slot of available) {
      if (this.observedSlots.has(slot)) continue;
      const observation = {
        nodes: composedSlotTextNodes(slot).filter(
          (node) => !isExtensionUiNode(node),
        ),
        listener: (() => undefined) as EventListener,
      };
      observation.listener = () => {
        if (
          !this.settings ||
          !this.controller ||
          this.controller.signal.aborted
        )
          return;
        const nodes = composedSlotTextNodes(slot).filter(
          (node) => !isExtensionUiNode(node),
        );
        const unchanged =
          nodes.length === observation.nodes.length &&
          nodes.every((node, index) => node === observation.nodes[index]);
        if (unchanged) return;
        const currentRoot = document.body ?? document.documentElement;
        const changedAnchors = new Set<Element>();
        for (const node of [...observation.nodes, ...nodes]) {
          if (node.isConnected) {
            changedAnchors.add(pageSegmentAnchor(node, currentRoot));
          }
        }
        observation.nodes = nodes;
        this.invalidateAnchors(changedAnchors);
        this.observeAvailableRoots(currentRoot);
        this.scheduleDynamicScan(currentRoot);
      };
      slot.addEventListener("slotchange", observation.listener);
      this.observedSlots.set(slot, observation);
      discovered = true;
    }
    return discovered;
  }

  private invalidateAnchors(changedAnchors: ReadonlySet<Element>): void {
    const restoredNodes = this.renderer.restoreAnchors(changedAnchors);
    this.renderer.reconcile();
    for (const node of restoredNodes) this.seen.delete(node);
    const invalidatedDocumentSegments = this.documentSegments.filter(
      (segment) => changedAnchors.has(segment.anchor),
    );
    for (const segment of invalidatedDocumentSegments) {
      for (const node of segment.nodes) this.seen.delete(node);
      this.invalidatedSegments.add(segment);
      this.status.total = Math.max(0, this.status.total - 1);
      const outcome = this.segmentOutcomes.get(segment);
      if (outcome === "completed") {
        this.status.completed = Math.max(0, this.status.completed - 1);
      } else if (outcome === "failed") {
        this.status.failed = Math.max(0, this.status.failed - 1);
      }
    }
    this.documentSegments = this.documentSegments.filter(
      (segment) => !changedAnchors.has(segment.anchor),
    );
  }

  private discardDetachedSegments(): boolean {
    const discardedByRenderer = new Set(this.renderer.reconcile());
    const discarded = this.documentSegments.filter(
      (segment) =>
        discardedByRenderer.has(segment) ||
        !segment.anchor.isConnected ||
        segment.nodes.some(
          (node) =>
            !node.isConnected || !composedContains(segment.anchor, node),
        ),
    );
    if (discarded.length === 0) return false;
    const discardedSet = new Set(discarded);
    for (const segment of discarded) {
      this.invalidatedSegments.add(segment);
      for (const node of segment.nodes) this.seen.delete(node);
      this.status.total = Math.max(0, this.status.total - 1);
      const outcome = this.segmentOutcomes.get(segment);
      if (outcome === "completed") {
        this.status.completed = Math.max(0, this.status.completed - 1);
      } else if (outcome === "failed") {
        this.status.failed = Math.max(0, this.status.failed - 1);
      }
      this.segmentOutcomes.delete(segment);
    }
    this.documentSegments = this.documentSegments.filter(
      (segment) => !discardedSet.has(segment),
    );
    if (this.status.failed === 0) {
      this.failureMessage = undefined;
      this.failureDetails = undefined;
    }
    return true;
  }

  private finishStatus(): void {
    const statusWithoutMessage = { ...this.status };
    delete statusWithoutMessage.message;
    delete statusWithoutMessage.details;
    const state =
      this.status.total === 0
        ? "idle"
        : this.status.completed + this.status.failed < this.status.total
          ? "translating"
          : this.status.total > 0 &&
              this.status.completed === 0 &&
              this.status.failed >= this.status.total
            ? "error"
            : this.status.failed > 0
              ? "partial"
              : "translated";
    if (
      this.settings?.page.mode === "fast" &&
      (pageFastProvider(this.settings) === "chrome-local" ||
        pageFastProvider(this.settings) === "bergamot-local")
    ) {
      translationDiagnostic("PageTranslation", "terminal-status", {
        ...translationRuntimeDiagnosticContext(),
        provider: pageFastProvider(this.settings),
        state,
        total: this.status.total,
        completed: this.status.completed,
        failed: this.status.failed,
      });
    }
    this.update({
      ...statusWithoutMessage,
      state,
      ...(state !== "translated" && this.failureMessage
        ? { message: this.failureMessage }
        : {}),
      ...(state !== "translated" && this.failureDetails
        ? { details: this.failureDetails }
        : {}),
    });
  }

  private update(status: PageStatus): void {
    this.status = status;
    this.onStatus(this.getStatus());
  }
}
