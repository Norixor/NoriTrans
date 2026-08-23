export class OcrSampler {
  private timer: number | undefined;
  private controller: AbortController | undefined;

  constructor(private readonly intervalMs = 1_000) {
    if (intervalMs < 500) throw new Error("OCR sampling cannot exceed 2 FPS.");
  }

  start(task: (signal: AbortSignal) => Promise<void>): AbortSignal {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    const run = async (): Promise<void> => {
      if (controller.signal.aborted) return;
      const startedAt = performance.now();
      try {
        await task(controller.signal);
      } finally {
        if (!controller.signal.aborted) {
          const remaining = Math.max(
            0,
            this.intervalMs - (performance.now() - startedAt),
          );
          this.timer = window.setTimeout(() => void run(), remaining);
        }
      }
    };
    void run();
    return controller.signal;
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
