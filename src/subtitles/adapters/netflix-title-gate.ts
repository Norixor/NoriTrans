import type { NetflixTimedTextCandidate } from "@/src/subtitles/adapters/netflix-manifest";

/**
 * Bound on remembered manifest candidates. One manifest parse yields at most
 * 48, so this keeps the current episode plus a prefetched neighbour.
 */
const MAX_REMEMBERED_CANDIDATES = 96;

/** Returns the numeric id of a `/watch/<id>` path, or undefined elsewhere. */
export function netflixWatchTitleId(pathname: string): string | undefined {
  return /^\/watch\/(\d+)/u.exec(pathname)?.[1];
}

export interface NetflixTitleGateAdmission {
  /** Candidates stored by this call. */
  stored: number;
  /** Stored candidates currently held back as belonging to another title. */
  foreign: number;
  /** Title id of the first held candidate, for bounded diagnostics. */
  foreignTitleId?: string;
}

export interface NetflixTitleGateRoll {
  /** Candidates declared for the new watch page and kept for fetching. */
  adopted: NetflixTimedTextCandidate[];
  /** Candidates of other titles (or without a title id) that were dropped. */
  dropped: number;
}

/**
 * Separates Netflix manifest candidates of the watched title from those of a
 * prefetched title (typically the next episode, whose manifest Netflix parses
 * before the watch path changes).
 *
 * Filtering is opt-in per watch page: it starts only after a parsed manifest's
 * `movieId` equals the `/watch/<id>` page id, which proves the two ids share a
 * namespace on this page. Until then, and for candidates without a title id,
 * every candidate is treated as current, exactly as before this gate existed.
 */
export class NetflixTitleGate {
  private watchId: string | undefined;
  private learned = false;
  private readonly candidates = new Map<string, NetflixTimedTextCandidate>();

  constructor(pathname: string) {
    this.watchId = netflixWatchTitleId(pathname);
  }

  get isLearned(): boolean {
    return this.learned;
  }

  /** Stores freshly parsed candidates, learning from a matching title id. */
  remember(
    candidates: readonly NetflixTimedTextCandidate[],
  ): NetflixTitleGateAdmission {
    if (
      this.watchId !== undefined &&
      candidates.some((candidate) => candidate.titleId === this.watchId)
    ) {
      this.learned = true;
    }
    let foreign = 0;
    let foreignTitleId: string | undefined;
    for (const candidate of candidates) {
      // Re-inserting refreshes the entry so eviction drops the oldest parse.
      this.candidates.delete(candidate.url);
      this.candidates.set(candidate.url, candidate);
      if (this.isForeignCandidate(candidate, this.watchId)) {
        foreign += 1;
        foreignTitleId ??= candidate.titleId;
      }
    }
    while (this.candidates.size > MAX_REMEMBERED_CANDIDATES) {
      const oldest = this.candidates.keys().next().value;
      if (oldest === undefined) break;
      this.candidates.delete(oldest);
    }
    return {
      stored: candidates.length,
      foreign,
      ...(foreignTitleId === undefined ? {} : { foreignTitleId }),
    };
  }

  /** Candidates that may be fetched and dispatched for the watched title. */
  current(): NetflixTimedTextCandidate[] {
    return [...this.candidates.values()].filter(
      (candidate) => !this.isForeignCandidate(candidate, this.watchId),
    );
  }

  /**
   * Returns the title id when `url` is a remembered candidate of another title
   * than the one in `pathname`, otherwise undefined. The path is passed
   * explicitly so a capture racing a watch-page change is judged against the
   * page that is actually showing.
   */
  foreignTitleIdFor(url: string, pathname: string): string | undefined {
    const candidate = this.candidates.get(url);
    return candidate !== undefined &&
      this.isForeignCandidate(candidate, netflixWatchTitleId(pathname))
      ? candidate.titleId
      : undefined;
  }

  /**
   * Moves to a new watch page. Only candidates whose title id equals the new
   * page id survive; everything else belonged to the previous page. Surviving
   * candidates are the same evidence a matching manifest parse would give, so
   * the new page starts learned when any survive and unlearned otherwise.
   */
  roll(pathname: string): NetflixTitleGateRoll {
    this.watchId = netflixWatchTitleId(pathname);
    const adopted: NetflixTimedTextCandidate[] = [];
    let dropped = 0;
    for (const [url, candidate] of [...this.candidates]) {
      if (
        this.watchId !== undefined &&
        candidate.titleId !== undefined &&
        candidate.titleId === this.watchId
      ) {
        adopted.push(candidate);
      } else {
        this.candidates.delete(url);
        dropped += 1;
      }
    }
    this.learned = adopted.length > 0;
    return { adopted, dropped };
  }

  private isForeignCandidate(
    candidate: NetflixTimedTextCandidate,
    watchId: string | undefined,
  ): boolean {
    return (
      this.learned &&
      watchId !== undefined &&
      candidate.titleId !== undefined &&
      candidate.titleId !== watchId
    );
  }
}
