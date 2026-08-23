import type { OcrRuntimeLanguage } from "@/src/ocr/languages";
import {
  getOcrRuntimeLanguage,
  type OcrRuntimePack,
} from "@/src/ocr/runtime-catalog";

interface DestroyableOcrEngine {
  destroy?(): Promise<void> | void;
}

/**
 * Shares one initialized OCR engine per physical model pack. Several logical
 * languages intentionally map to the same recognizer and dictionary; keeping
 * separate engines for them duplicates ONNX sessions and tens of MB of memory.
 */
export class OcrPackEnginePool<Engine extends DestroyableOcrEngine> {
  private readonly engines = new Map<OcrRuntimePack, Engine>();
  private readonly sessionPacks = new Map<string, OcrRuntimePack>();

  constructor(
    private readonly createEngine: (language: OcrRuntimeLanguage) => Engine,
  ) {}

  async assign(
    sessionId: string,
    language: OcrRuntimeLanguage,
  ): Promise<{ key: OcrRuntimePack; engine: Engine }> {
    const key = getOcrRuntimeLanguage(language).pack;
    let engine = this.engines.get(key);
    if (!engine) {
      engine = this.createEngine(language);
      this.engines.set(key, engine);
    }
    const previousKey = this.sessionPacks.get(sessionId);
    this.sessionPacks.set(sessionId, key);
    if (previousKey !== key) await this.releasePackIfUnused(previousKey);
    return { key, engine };
  }

  engineForSession(sessionId: string): Engine {
    const key = this.sessionPacks.get(sessionId);
    const engine = key ? this.engines.get(key) : undefined;
    if (!engine) throw new Error("ocr_session_not_prepared");
    return engine;
  }

  async release(sessionId: string): Promise<void> {
    const key = this.sessionPacks.get(sessionId);
    this.sessionPacks.delete(sessionId);
    await this.releasePackIfUnused(key);
  }

  async invalidate(language: OcrRuntimeLanguage): Promise<void> {
    await this.invalidatePack(getOcrRuntimeLanguage(language).pack);
  }

  /** Invalidates active sessions only after the physical pack was deleted. */
  async invalidatePack(key: OcrRuntimePack): Promise<void> {
    for (const [sessionId, sessionKey] of this.sessionPacks) {
      if (sessionKey === key) this.sessionPacks.delete(sessionId);
    }
    const engine = this.engines.get(key);
    this.engines.delete(key);
    await engine?.destroy?.();
  }

  private async releasePackIfUnused(
    key: OcrRuntimePack | undefined,
  ): Promise<void> {
    if (!key || [...this.sessionPacks.values()].includes(key)) return;
    const engine = this.engines.get(key);
    this.engines.delete(key);
    await engine?.destroy?.();
  }
}
