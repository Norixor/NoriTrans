export const EXTENSION_TRANSLATION_BUCKET = "extension";

interface PendingPermit {
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
 */
export class TranslationRequestGate {
  private readonly buckets = new Map<string, BucketState>();

  constructor(private readonly maxActivePerBucket: number) {
    if (!Number.isInteger(maxActivePerBucket) || maxActivePerBucket < 1) {
      throw new RangeError("maxActivePerBucket must be a positive integer");
    }
  }

  async run<T>(
    bucketKey: string,
    requestId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const bucket = this.getOrCreateBucket(bucketKey);
    bucket.requests.get(requestId)?.controller.abort();

    const entry: RequestEntry = { controller: new AbortController() };
    bucket.requests.set(requestId, entry);

    let release: (() => void) | undefined;
    try {
      release = await this.acquire(bucketKey, bucket, entry.controller.signal);
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

  private acquire(
    bucketKey: string,
    bucket: BucketState,
    signal: AbortSignal,
  ): Promise<() => void> {
    if (signal.aborted) return Promise.reject(cancellationError());
    if (bucket.active < this.maxActivePerBucket) {
      bucket.active += 1;
      return Promise.resolve(this.createRelease(bucketKey, bucket));
    }

    return new Promise<() => void>((resolve, reject) => {
      const pending: PendingPermit = {
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
    while (
      bucket.active < this.maxActivePerBucket &&
      bucket.pending.length > 0
    ) {
      const pending = bucket.pending.shift();
      if (!pending || pending.settled) continue;
      pending.signal.removeEventListener("abort", pending.onAbort);
      if (pending.signal.aborted) {
        pending.settled = true;
        pending.reject(cancellationError());
        continue;
      }
      pending.settled = true;
      bucket.active += 1;
      pending.resolve(this.createRelease(bucketKey, bucket));
    }
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
