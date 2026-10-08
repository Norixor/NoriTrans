/**
 * Tracks which resource URLs belong to an earlier watch page.
 *
 * Netflix keeps one document across episodes and its signed subtitle URLs give
 * no hint of the episode they belong to, while the browser's Resource Timing
 * buffer still lists the previous episode's requests. Re-fetching such an entry
 * would hand the old episode's subtitles to the new episode's player, so every
 * URL known when the watch path changes is remembered as stale.
 */
const MAX_STALE_URLS = 2_000;

export class WatchEpochTracker {
  private path: string;
  private readonly stale = new Set<string>();

  constructor(initialPath: string) {
    this.path = initialPath;
  }

  get currentPath(): string {
    return this.path;
  }

  /**
   * Starts a new epoch when `path` differs from the current one. `knownUrls`
   * are the URLs requested so far (resource buffer, already-queued URLs); they
   * belong to the previous epoch. Returns whether an epoch change happened.
   */
  roll(path: string, knownUrls: Iterable<string>): boolean {
    if (path === this.path) return false;
    this.path = path;
    for (const url of knownUrls) this.stale.add(url);
    while (this.stale.size > MAX_STALE_URLS) {
      const oldest = this.stale.values().next().value;
      if (oldest === undefined) break;
      this.stale.delete(oldest);
    }
    return true;
  }

  isStale(url: string): boolean {
    return this.stale.has(url);
  }
}
