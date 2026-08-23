export interface RefreshableTab {
  id?: number | undefined;
  url?: string | undefined;
}

export interface ContentScriptRefreshResult {
  attempted: number;
  refreshed: number;
  failed: number;
}

export interface ContentFrameTarget {
  frameId: number;
  documentId: string;
}

export interface ContentFramePreparationResult {
  discovered: number;
  current: number;
  recovered: number;
  failed: number;
}

export interface ContentFrameBroadcastResult {
  delivered: number;
  failed: number;
  usedFallback: boolean;
}

export interface TabManualTranslationState {
  [tabId: string]: {
    handledFrameInstances: string[];
  };
}

interface TabManualTranslationStorage {
  read: () => Promise<unknown>;
  write: (state: TabManualTranslationState) => Promise<void>;
}

const MAX_HANDLED_FRAME_INSTANCES_PER_TAB = 128;

function normalizeManualTranslationState(
  value: unknown,
): TabManualTranslationState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const normalized: TabManualTranslationState = {};
  for (const [tabId, candidate] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      !/^\d+$/u.test(tabId) ||
      typeof candidate !== "object" ||
      candidate === null ||
      !("handledFrameInstances" in candidate) ||
      !Array.isArray(candidate.handledFrameInstances)
    ) {
      continue;
    }
    const handledFrameInstances = candidate.handledFrameInstances.filter(
      (frameInstanceId): frameInstanceId is string =>
        typeof frameInstanceId === "string" &&
        frameInstanceId.length > 0 &&
        frameInstanceId.length <= 200,
    );
    normalized[tabId] = {
      handledFrameInstances: [...new Set(handledFrameInstances)].slice(
        -MAX_HANDLED_FRAME_INSTANCES_PER_TAB,
      ),
    };
  }
  return normalized;
}

/**
 * Keeps a manual page-translation choice scoped to one tab and browser
 * session. Frames observed before activation are covered by the original
 * tab-wide command; later frame instances need one targeted command.
 */
export class TabManualTranslationIntentStore {
  private readonly observedFrameInstances = new Map<number, Set<string>>();
  private statePromise: Promise<TabManualTranslationState> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: TabManualTranslationStorage) {}

  private load(): Promise<TabManualTranslationState> {
    this.statePromise ??= this.storage
      .read()
      .then(normalizeManualTranslationState, () => ({}));
    return this.statePromise;
  }

  private mutate(
    update: (state: TabManualTranslationState) => boolean,
  ): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      const state = await this.load();
      if (update(state)) await this.storage.write(state);
    });
    this.mutationTail = operation.catch(() => undefined);
    return operation;
  }

  activate(tabId: number): Promise<void> {
    return this.mutate((state) => {
      state[String(tabId)] = {
        handledFrameInstances: [
          ...(this.observedFrameInstances.get(tabId) ?? []),
        ].slice(-MAX_HANDLED_FRAME_INSTANCES_PER_TAB),
      };
      return true;
    });
  }

  deactivate(tabId: number): Promise<void> {
    this.observedFrameInstances.delete(tabId);
    return this.mutate((state) => delete state[String(tabId)]);
  }

  async frameNeedsTranslation(
    tabId: number,
    frameInstanceId: string,
  ): Promise<boolean> {
    let needsTranslation = false;
    const observed =
      this.observedFrameInstances.get(tabId) ?? new Set<string>();
    observed.add(frameInstanceId);
    this.observedFrameInstances.set(tabId, observed);
    await this.mutate((state) => {
      const intent = state[String(tabId)];
      if (!intent || intent.handledFrameInstances.includes(frameInstanceId)) {
        return false;
      }
      needsTranslation = true;
      intent.handledFrameInstances.push(frameInstanceId);
      intent.handledFrameInstances = intent.handledFrameInstances.slice(
        -MAX_HANDLED_FRAME_INSTANCES_PER_TAB,
      );
      return true;
    });
    return needsTranslation;
  }
}

interface ContentScriptRefreshOptions {
  queryTabs: () => Promise<RefreshableTab[]>;
  inject: (tabId: number) => Promise<unknown>;
  isCurrent?: (tabId: number) => Promise<boolean>;
  concurrency?: number;
}

interface ContentFramePreparationOptions {
  discover: () => Promise<ContentFrameTarget[]>;
  isCurrent: (target: ContentFrameTarget) => Promise<boolean>;
  inject: (target: ContentFrameTarget) => Promise<unknown>;
  concurrency?: number;
  readinessAttempts?: number;
  retryDelayMs?: number;
  wait?: (ms: number) => Promise<void>;
}

export function isRefreshablePageUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function isFullDocumentNavigationUpdate(changeInfo: {
  status?: string | undefined;
}): boolean {
  // Same-document history/hash changes may update the tab URL without starting
  // a new document. Keep manual translation active for those SPA transitions.
  return changeInfo.status === "loading";
}

/**
 * Replaces stale content scripts after an extension install, update, or
 * unpacked reload. Individual tabs may be inaccessible because an optional
 * host permission is absent, so failures stay isolated per tab.
 */
export async function refreshExistingContentScripts({
  queryTabs,
  inject,
  isCurrent,
  concurrency = 6,
}: ContentScriptRefreshOptions): Promise<ContentScriptRefreshResult> {
  const tabIds = (await queryTabs()).flatMap((tab) =>
    tab.id !== undefined && isRefreshablePageUrl(tab.url) ? [tab.id] : [],
  );
  let nextIndex = 0;
  let refreshed = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const tabId = tabIds[index];
      if (tabId === undefined) return;
      let current = false;
      try {
        current = (await isCurrent?.(tabId)) ?? false;
      } catch {
        // A stale or invalidated content script has no receiving endpoint.
      }
      if (current) continue;
      try {
        await inject(tabId);
        refreshed += 1;
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), tabIds.length) },
      () => worker(),
    ),
  );
  return { attempted: tabIds.length, refreshed, failed };
}

/**
 * Makes every scriptable document ready before a single tab-wide command is
 * broadcast. Discovery and recovery failures remain local to each frame; the
 * caller must still perform the broadcast so already-running related frames
 * such as about:blank continue to receive it.
 */
export async function prepareContentFramesForBroadcast({
  discover,
  isCurrent,
  inject,
  concurrency = 6,
  readinessAttempts = 5,
  retryDelayMs = 50,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: ContentFramePreparationOptions): Promise<ContentFramePreparationResult> {
  let discoveredTargets: ContentFrameTarget[];
  try {
    discoveredTargets = await discover();
  } catch {
    return { discovered: 0, current: 0, recovered: 0, failed: 0 };
  }
  const targets = [
    ...new Map(
      discoveredTargets.map((target) => [target.documentId, target]),
    ).values(),
  ];
  let nextIndex = 0;
  let current = 0;
  let recovered = 0;
  let failed = 0;

  const runtimeIsCurrent = async (
    target: ContentFrameTarget,
  ): Promise<boolean> => {
    try {
      return await isCurrent(target);
    } catch {
      return false;
    }
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const target = targets[index];
      if (!target) return;
      if (await runtimeIsCurrent(target)) {
        current += 1;
        continue;
      }
      try {
        await inject(target);
      } catch {
        failed += 1;
        continue;
      }
      let ready = false;
      for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
        if (await runtimeIsCurrent(target)) {
          ready = true;
          break;
        }
        if (attempt + 1 < readinessAttempts) await wait(retryDelayMs);
      }
      if (ready) recovered += 1;
      else failed += 1;
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), targets.length) },
      () => worker(),
    ),
  );
  return {
    discovered: targets.length,
    current,
    recovered,
    failed,
  };
}

/**
 * Sends one command to every discovered document explicitly. Relying on a
 * tab-wide send is ambiguous across browser implementations and can leave an
 * embedded video frame running after the top-frame UI reports cancellation.
 * The tab-wide path is retained only when frame discovery itself yielded no
 * targets.
 */
export async function sendCommandToContentFrames({
  targets,
  send,
  fallback,
}: {
  targets: readonly ContentFrameTarget[];
  send: (target: ContentFrameTarget) => Promise<unknown>;
  fallback: () => Promise<unknown>;
}): Promise<ContentFrameBroadcastResult> {
  const uniqueTargets = [
    ...new Map(targets.map((target) => [target.documentId, target])).values(),
  ];
  if (uniqueTargets.length === 0) {
    await fallback();
    return { delivered: 1, failed: 0, usedFallback: true };
  }
  const settled = await Promise.allSettled(uniqueTargets.map(send));
  const delivered = settled.filter(
    (result) => result.status === "fulfilled",
  ).length;
  const failed = settled.length - delivered;
  if (delivered === 0) {
    const rejection = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw rejection?.reason instanceof Error
      ? rejection.reason
      : new Error("No content frame received the command.");
  }
  return { delivered, failed, usedFallback: false };
}
