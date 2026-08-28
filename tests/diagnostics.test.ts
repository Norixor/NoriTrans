import {
  siteDiagnostic,
  siteDiagnosticsEnabled,
} from "@/src/shared/diagnostics";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("site diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps production diagnostics disabled by default", () => {
    vi.stubEnv("WXT_NTRANS_SITE_DIAGNOSTICS", "");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(siteDiagnosticsEnabled()).toBe(false);
    siteDiagnostic("Netflix", "track-classified", { cues: 20 });

    expect(info).not.toHaveBeenCalled();
  });

  it("emits diagnostics only after an explicit opt-in", () => {
    vi.stubEnv("WXT_NTRANS_SITE_DIAGNOSTICS", "1");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const detail = { cues: 20 };

    expect(siteDiagnosticsEnabled()).toBe(true);
    siteDiagnostic("Netflix", "track-classified", detail);

    expect(info).toHaveBeenCalledWith(
      "[nTrans][Netflix] track-classified",
      detail,
    );
  });
});
