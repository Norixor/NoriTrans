import {
  localizeRuntimeError,
  runtimeErrorCode,
  runtimeErrorToken,
  safeRuntimeErrorToken,
} from "@/src/shared/runtime-errors";
import { describe, expect, it } from "vitest";

const english = {
  runtimeErrorInvalidResponse: "The provider response is invalid.",
  runtimeErrorRequestFailed: "The request failed.",
} as const;

describe("runtime error localization", () => {
  it("maps a stable provider token through the active locale", () => {
    expect(
      localizeRuntimeError(runtimeErrorToken("invalid_response"), (key) =>
        key in english ? english[key as keyof typeof english] : "",
      ),
    ).toBe("The provider response is invalid.");
  });

  it("maps legacy runtime messages without displaying Chinese in English", () => {
    expect(
      localizeRuntimeError("翻译服务没有返回全部段落。", (key) =>
        key in english ? english[key as keyof typeof english] : "",
      ),
    ).toBe("The provider response is invalid.");
  });

  it("preserves the background permission code across its legacy message", () => {
    expect(
      runtimeErrorCode(
        "尚未授权访问当前翻译服务，请在设置中重新保存 Provider。",
      ),
    ).toBe("permission_required");
  });

  it("replaces unknown details with a generic safe token", () => {
    const detail = "upstream body: secret response content";
    expect(runtimeErrorCode(detail)).toBeUndefined();
    expect(safeRuntimeErrorToken(detail)).toBe(
      runtimeErrorToken("request_failed"),
    );
    expect(
      localizeRuntimeError(detail, (key) =>
        key in english ? english[key as keyof typeof english] : "",
      ),
    ).toBe("The request failed.");
  });

  it("does not expose an unknown Error message across runtime boundaries", () => {
    expect(
      safeRuntimeErrorToken(
        new Error("Authorization: Bearer private-provider-credential"),
      ),
    ).toBe(runtimeErrorToken("request_failed"));
  });
});
