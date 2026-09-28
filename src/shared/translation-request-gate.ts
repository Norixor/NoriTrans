export const EXTENSION_TRANSLATION_BUCKET = "extension";

/**
 * `urgent` marks time-critical work (current subtitle window, streamed cues,
 * selection lookups) that must not wait behind long background batches.
 */
export type TranslationRequestPriority = "urgent" | "normal";

interface PendingPermit {
  priority: TranslationRequestPriority;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: DOMException) => void;
  onAbort: () => void;
  settled: boolean;
}

interface RequestEntry {
  controller: AbortController;
}

interface BucketState {
  active: number;
  pending: PendingPermit[];
  requests: Map<string, RequestEntry>;
}

function cancellationError(): DOMException {
  return new DOMException("Translation cancelled", "AbortError");
}

export function translationBucketForTab(tabId?: number): string {
  return tabId === undefined ? EXTENSION_TRANSLATION_BUCKET : `tab:${tabId}`;
}

/**
 * Caps active translation operations independently for every browser tab.
 * Requests waiting for a permit remain cancellable and never invoke their
 * operation after cancellation.
 *
 * `reservedUrgentPerBucket` permits are only granted to urgent requests, and
 * queued urgent requests are granted before queued normal ones, so long
 * normal batches cannot starve playback-critical work. The total number of
 * active operations per bucket never exceeds `maxActivePerBucket`.
 */
export class TranslationRequestGate {
  private readonly buckets = new Map<string, BucketState>();

  constructor(
    private readonly maxActivePerBucket: number,
    private readonly reservedUrgentPerBucket = 0,
  ) {
    if (!Number.isInteger(maxActivePerBucket) || maxActivePerBucket < 1) {
      throw new RangeError("maxActivePerBucket must be a positive integer");
    }
    if (
      !Number.isInteger(reservedUrgentPerBucket) ||
      reservedUrgentPerBucket < 0 ||
      reservedUrgentPerBucket >= maxActivePerBucket
    ) {
      throw new RangeError(
        "reservedUrgentPerBucket must be a non-negative integer below maxActivePerBucket",
      );
    }
  }

  async run<T>(
    bucketKey: string,
    requestId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    priority: TranslationRequestPriority = "normal",
  ): Promise<T> {
    const bucket = this.getOrCreateBucket(bucketKey);
    bucket.requests.get(requestId)?.controller.abort();

    const entry: RequestEntry = { controller: new AbortController() };
    bucket.requests.set(requestId, entry);

    let release: (() => void) | undefined;
    try {
      release = await this.acquire(
        bucketKey,
        bucket,
        entry.controller.signal,
        priority,
      );
      if (entry.controller.signal.aborted) throw cancellationError();
      return await operation(entry.controller.signal);
    } finally {
      release?.();
      if (bucket.requests.get(requestId) === entry) {
        bucket.requests.delete(requestId);
      }
      this.deleteBucketIfEmpty(bucketKey, bucket);
    }
  }

  cancel(bucketKey: string, requestId: string): void {
    this.buckets.get(bucketKey)?.requests.get(requestId)?.controller.abort();
  }

  cancelBucket(bucketKey: string): void {
    const bucket = this.buckets.get(bucketKey);
    if (!bucket) return;
    for (const entry of bucket.requests.values()) entry.controller.abort();
    this.deleteBucketIfEmpty(bucketKey, bucket);
  }

  cancelAll(): void {
    for (const bucket of this.buckets.values()) {
      for (const entry of bucket.requests.values()) entry.controller.abort();
    }
  }

  get bucketCount(): number {
    return this.buckets.size;
  }

  private getOrCreateBucket(bucketKey: string): BucketState {
    const existing = this.buckets.get(bucketKey);
    if (existing) return existing;
    const bucket: BucketState = {
      active: 0,
      pending: [],
      requests: new Map(),
    };
    this.buckets.set(bucketKey, bucket);
    return bucket;
  }

  private limitFor(priority: TranslationRequestPriority): number {
    return priority === "urgent"
      ? this.maxActivePerBucket
      : this.maxActivePerBucket - this.reservedUrgentPerBucket;
  }

  private acquire(
    bucketKey: string,
    bucket: BucketState,
    signal: AbortSignal,
    priority: TranslationRequestPriority,
  ): Promise<() => void> {
    if (signal.aborted) return Promise.reject(cancellationError());
    // grantNext() runs on every release, so a request is only queued while
    // its priority's limit is reached; no same-or-higher priority waiter can
    // be skipped by granting immediately here.
    if (bucket.active < this.limitFor(priority)) {
      bucket.active += 1;
      return Promise.resolve(this.createRelease(bucketKey, bucket));
    }

    return new Promise<() => void>((resolve, reject) => {
      const pending: PendingPermit = {
        priority,
        signal,
        resolve,
        reject,
        settled: false,
        onAbort: () => {
          if (pending.settled) return;
          pending.settled = true;
          const index = bucket.pending.indexOf(pending);
          if (index >= 0) bucket.pending.splice(index, 1);
          signal.removeEventListener("abort", pending.onAbort);
          reject(cancellationError());
          this.deleteBucketIfEmpty(bucketKey, bucket);
        },
      };
      signal.addEventListener("abort", pending.onAbort, { once: true });
      bucket.pending.push(pending);
    });
  }

  private createRelease(bucketKey: string, bucket: BucketState): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bucket.active -= 1;
      this.grantNext(bucketKey, bucket);
      this.deleteBucketIfEmpty(bucketKey, bucket);
    };
  }

  private grantNext(bucketKey: string, bucket: BucketState): void {
    for (;;) {
      // Urgent requests keep FIFO order among themselves and jump ahead of
      // queued normal requests; normal requests never use reserved permits.
      const nextIndex =
        bucket.active < this.maxActivePerBucket
          ? this.firstPending(bucket, "urgent")
          : -1;
      const index =
        nextIndex >= 0
          ? nextIndex
          : bucket.active < this.limitFor("normal")
            ? this.firstPending(bucket, "normal")
            : -1;
      if (index < 0) return;
      const [pending] = bucket.pending.splice(index, 1);
      if (!pending || pending.settled) continue;
      pending.settled = true;
      pending.signal.removeEventListener("abort", pending.onAbort);
      if (pending.signal.aborted) {
        pending.reject(cancellationError());
        continue;
      }
      bucket.active += 1;
      pending.resolve(this.createRelease(bucketKey, bucket));
    }
  }

  private firstPending(
    bucket: BucketState,
    priority: TranslationRequestPriority,
  ): number {
    return bucket.pending.findIndex((pending) => pending.priority === priority);
  }

  private deleteBucketIfEmpty(bucketKey: string, bucket: BucketState): void {
    if (
      bucket.active === 0 &&
      bucket.pending.length === 0 &&
      bucket.requests.size === 0 &&
      this.buckets.get(bucketKey) === bucket
    ) {
      this.buckets.delete(bucketKey);
    }
  }
}
