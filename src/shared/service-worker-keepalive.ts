/**
 * Keeps the MV3 service worker alive while long-running work is in flight.
 *
 * Chrome terminates an idle extension service worker after ~30 seconds even
 * when a `runtime.onMessage` response is still pending (for example a
 * non-streaming AI request with a long client timeout). Any extension API call
 * resets the idle timer, so a cheap periodic call is issued only while at
 * least one hold is active and stops as soon as the last hold is released.
 */
export class ServiceWorkerKeepalive {
  private holds = 0;
  private timer: ReturnType<typeof globalThis.setInterval> | undefined;

  constructor(
    private readonly ping: () => Promise<unknown>,
    private readonly intervalMs = 20_000,
  ) {}

  get activeHolds(): number {
    return this.holds;
  }

  /** Returns an idempotent release function; callers must release in `finally`. */
  hold(): () => void {
    this.holds += 1;
    if (this.holds === 1) {
      this.timer = globalThis.setInterval(() => {
        void this.ping().catch(() => undefined);
      }, this.intervalMs);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds = Math.max(0, this.holds - 1);
      if (this.holds === 0 && this.timer !== undefined) {
        globalThis.clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }
}
