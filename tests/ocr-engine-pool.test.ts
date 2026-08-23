import { OcrPackEnginePool } from "@/src/ocr/engine-pool";
import { describe, expect, it, vi } from "vitest";

describe("OCR physical model engine pool", () => {
  it("shares one engine across logical languages in the same pack", async () => {
    const engines: Array<{
      language: string;
      destroy: ReturnType<typeof vi.fn>;
    }> = [];
    const pool = new OcrPackEnginePool((language) => {
      const engine = { language, destroy: vi.fn(() => Promise.resolve()) };
      engines.push(engine);
      return engine;
    });

    const english = await pool.assign("session-en", "eng");
    const chinese = await pool.assign("session-zh", "chi_sim");

    expect(english.key).toBe("zh");
    expect(chinese.key).toBe("zh");
    expect(chinese.engine).toBe(english.engine);
    expect(engines).toHaveLength(1);
    expect(pool.engineForSession("session-en")).toBe(english.engine);
    expect(pool.engineForSession("session-zh")).toBe(english.engine);

    await pool.release("session-en");
    expect(engines[0]?.destroy).not.toHaveBeenCalled();
    await pool.release("session-zh");
    expect(engines[0]?.destroy).toHaveBeenCalledOnce();
  });

  it("keeps different physical packs separate and invalidates one pack", async () => {
    const engines: Array<{
      language: string;
      destroy: ReturnType<typeof vi.fn>;
    }> = [];
    const pool = new OcrPackEnginePool((language) => {
      const engine = { language, destroy: vi.fn(() => Promise.resolve()) };
      engines.push(engine);
      return engine;
    });

    const chinese = await pool.assign("session-zh", "jpn");
    const latin = await pool.assign("session-latin", "fra");
    expect(chinese.engine).not.toBe(latin.engine);
    expect(engines).toHaveLength(2);

    await pool.invalidate("eng");
    expect(chinese.engine.destroy).toHaveBeenCalledOnce();
    expect(latin.engine.destroy).not.toHaveBeenCalled();
    expect(() => pool.engineForSession("session-zh")).toThrow(
      "ocr_session_not_prepared",
    );
    expect(pool.engineForSession("session-latin")).toBe(latin.engine);
  });

  it("keeps shared-pack sessions alive when a logical sibling remains installed", async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const pool = new OcrPackEnginePool(() => ({ destroy }));
    const japanese = await pool.assign("session-ja", "jpn");

    // Deleting chi_sim while jpn remains installed does not call invalidatePack.
    expect(pool.engineForSession("session-ja")).toBe(japanese.engine);
    expect(destroy).not.toHaveBeenCalled();

    await pool.invalidatePack("zh");
    expect(destroy).toHaveBeenCalledOnce();
    expect(() => pool.engineForSession("session-ja")).toThrow(
      "ocr_session_not_prepared",
    );
  });
});
