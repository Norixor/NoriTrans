import en from "@/public/_locales/en/messages.json";
import zhCn from "@/public/_locales/zh_CN/messages.json";
import {
  aggregatePageStatuses,
  aggregateSubtitleStatuses,
} from "@/src/frames/status";
import {
  isPageStatusValue,
  isSubtitleStatusValue,
  type PageStatus,
  type SubtitleStatus,
} from "@/src/messaging/protocol";
import { NoriTransError } from "@/src/shared/errors";
import { runtimeErrorToken } from "@/src/shared/runtime-errors";
import {
  failureReasonCode,
  isStatusReasonCode,
  STATUS_REASON,
} from "@/src/shared/status-reasons";
import {
  pageStatusView,
  resolveReason,
  STATUS_MESSAGE_KEYS,
  subtitleStatusView,
  type StatusKind,
  type StatusView,
} from "@/src/ui/status";
import { describe, expect, it } from "vitest";

interface LocaleMessage {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

const catalogs: Record<string, Record<string, LocaleMessage>> = {
  en,
  zh_CN: zhCn,
};

const page = (overrides: Partial<PageStatus> = {}): PageStatus => ({
  state: "idle",
  total: 0,
  completed: 0,
  failed: 0,
  ...overrides,
});

const subtitle = (overrides: Partial<SubtitleStatus> = {}): SubtitleStatus => ({
  state: "waiting",
  total: 0,
  completed: 0,
  failed: 0,
  ...overrides,
});

/** Fields that drive repaints of the action slot. */
const slot = (view: StatusView) => ({
  kind: view.kind,
  primary: view.primaryAction,
  secondary: view.secondaryActions.map((item) => item.id),
});

describe("status view model kinds", () => {
  it.each<[PageStatus, StatusKind]>([
    [page({ state: "unavailable" }), "unavailable"],
    [page({ state: "idle" }), "idle"],
    [page({ state: "scanning" }), "scanning"],
    [page({ state: "translating", total: 4, completed: 1 }), "translating"],
    [page({ state: "translated", total: 4, completed: 4 }), "ready"],
    [page({ state: "partial", total: 4, completed: 3, failed: 1 }), "partial"],
    [
      page({ state: "cancelled", total: 4, completed: 1, failed: 3 }),
      "cancelled",
    ],
    [page({ state: "error", total: 4, failed: 4 }), "error"],
    // README §2.2 rule 4: any success beside a failure is partial, and a
    // "partial" without a single success is an error.
    [page({ state: "error", total: 4, completed: 1, failed: 3 }), "partial"],
    [page({ state: "partial", total: 4, failed: 4 }), "error"],
  ])("maps page %o to %s", (status, kind) => {
    expect(pageStatusView(status).kind).toBe(kind);
  });

  it.each<[SubtitleStatus, StatusKind]>([
    [subtitle({ state: "disabled" }), "disabled"],
    [subtitle({ state: "unavailable" }), "unavailable"],
    [subtitle({ state: "waiting" }), "scanning"],
    [subtitle({ state: "translating", total: 3, completed: 1 }), "translating"],
    [subtitle({ state: "ready", total: 3, completed: 3 }), "ready"],
    [
      subtitle({ state: "partial", total: 3, completed: 2, failed: 1 }),
      "partial",
    ],
    [subtitle({ state: "cancelled", total: 3, completed: 1 }), "cancelled"],
    [subtitle({ state: "error", total: 3, failed: 3 }), "error"],
  ])("maps subtitle %o to %s", (status, kind) => {
    expect(subtitleStatusView(status).kind).toBe(kind);
  });

  it("uses a distinct icon shape for every kind", () => {
    const views = [
      subtitleStatusView(subtitle({ state: "disabled" })),
      pageStatusView(page({ state: "unavailable" })),
      pageStatusView(page({ state: "idle" })),
      pageStatusView(page({ state: "scanning" })),
      pageStatusView(page({ state: "translating", total: 2 })),
      pageStatusView(page({ state: "translated", total: 2, completed: 2 })),
      pageStatusView(
        page({ state: "partial", total: 2, completed: 1, failed: 1 }),
      ),
      pageStatusView(
        page({ state: "cancelled", total: 2, completed: 1, failed: 1 }),
      ),
      pageStatusView(page({ state: "error", total: 2, failed: 2 })),
    ];
    expect(new Set(views.map((view) => view.kind)).size).toBe(9);
    expect(new Set(views.map((view) => view.icon)).size).toBe(9);
    expect(
      views.filter((view) => view.badge === "attention").map((v) => v.kind),
    ).toEqual(["partial", "cancelled", "error"]);
  });
});

describe("status view model button rules (README §2.2)", () => {
  it("keeps one primary slot whose label follows the task lifecycle", () => {
    const labels = [
      pageStatusView(page({ state: "idle" })),
      pageStatusView(page({ state: "translating", total: 4, completed: 1 })),
      pageStatusView(
        page({ state: "partial", total: 4, completed: 3, failed: 1 }),
      ),
      pageStatusView(
        page({ state: "cancelled", total: 4, completed: 1, failed: 3 }),
      ),
      pageStatusView(page({ state: "translated", total: 4, completed: 4 })),
    ].map((view) => [view.primaryAction?.id, view.primaryAction?.label.key]);
    expect(labels).toEqual([
      ["translate", "statusActionTranslate"],
      ["stop", "statusActionStop"],
      ["retry", "statusActionRetryBlocks"],
      ["resume", "statusActionResume"],
      ["restore", "statusActionRestore"],
    ]);
  });

  it("does not flip to partial while failures grow during translation", () => {
    const before = pageStatusView(
      page({ state: "translating", total: 10, completed: 2, failed: 0 }),
    );
    const firstFailure = pageStatusView(
      page({
        state: "translating",
        total: 10,
        completed: 3,
        failed: 1,
        reasonCode: "rate_limited",
      }),
    );
    const moreFailures = pageStatusView(
      page({
        state: "translating",
        total: 10,
        completed: 4,
        failed: 3,
        reasonCode: "rate_limited",
      }),
    );
    for (const view of [before, firstFailure, moreFailures]) {
      expect(view.kind).toBe("translating");
      expect(view.primaryAction).toEqual({
        id: "stop",
        label: { key: "statusActionStop", substitutions: [] },
        disabled: false,
        busy: false,
      });
      expect(view.secondaryActions).toEqual([]);
    }
    expect(before.progress.failedSoFar).toBeUndefined();
    expect(before.progressNote).toBeUndefined();
    expect(moreFailures.progress).toEqual({
      done: 4,
      total: 10,
      failed: 3,
      failedSoFar: 3,
    });
    expect(moreFailures.progressNote).toEqual({
      key: "statusProgressFailedSoFar",
      substitutions: ["3"],
    });
    expect(slot(firstFailure)).toEqual(slot(moreFailures));
    expect(moreFailures.reason?.key).toBe("statusReasonRateLimited");
  });

  it("applies the same rule to subtitle pre-translation", () => {
    const view = subtitleStatusView(
      subtitle({
        state: "translating",
        completeness: "full",
        total: 20,
        completed: 5,
        failed: 2,
      }),
    );
    expect(view.kind).toBe("translating");
    expect(view.primaryAction?.id).toBe("stop");
    expect(view.progress.failedSoFar).toBe(2);
  });

  it("ranks disabled above an unavailable or no-track report", () => {
    const offWhileNoTrack = subtitleStatusView(
      subtitle({
        state: "unavailable",
        reasonCode: STATUS_REASON.subtitleNoTrack,
        details: "stale",
      }),
      { featureEnabled: false },
    );
    expect(offWhileNoTrack.kind).toBe("disabled");
    expect(offWhileNoTrack.title.key).toBe("statusTitleDisabledSubtitle");
    expect(offWhileNoTrack.reason).toBeUndefined();
    expect(offWhileNoTrack.diagnostics).toEqual({});
    expect(offWhileNoTrack.tracks).toEqual([]);
    expect(offWhileNoTrack.primaryAction?.id).toBe("enable");

    const offWhileTranslating = pageStatusView(
      page({ state: "translating", total: 3 }),
      { featureEnabled: false },
    );
    expect(offWhileTranslating.kind).toBe("disabled");

    const unavailableBeatsOthers = subtitleStatusView(
      subtitle({ state: "unavailable", total: 0 }),
      { featureEnabled: true },
    );
    expect(unavailableBeatsOthers.kind).toBe("unavailable");
  });

  it("shows an in-flight action as a disabled transitional label in the same slot", () => {
    const translating = page({ state: "translating", total: 6, completed: 2 });
    const stopping = pageStatusView(translating, { pending: "stopping" });
    expect(stopping.primaryAction).toEqual({
      id: "stop",
      label: { key: "statusActionStopping", substitutions: [] },
      disabled: true,
      busy: true,
    });
    // The backend may report intermediate states before confirming; the slot
    // keeps the transitional label instead of flipping to "continue".
    const intermediate = pageStatusView(
      page({ state: "cancelled", total: 6, completed: 2, failed: 4 }),
      { pending: "stopping" },
    );
    expect(intermediate.primaryAction).toEqual(stopping.primaryAction);
    expect(intermediate.secondaryActions.every((a) => a.disabled)).toBe(true);

    const retrying = pageStatusView(
      page({ state: "partial", total: 6, completed: 4, failed: 2 }),
      { pending: "retrying" },
    );
    expect(retrying.primaryAction).toMatchObject({
      id: "retry",
      label: { key: "statusActionRetrying" },
      disabled: true,
      busy: true,
    });
    expect(
      pageStatusView(page({ state: "idle" }), { pending: "starting" })
        .primaryAction?.label.key,
    ).toBe("statusActionStarting");
    expect(
      subtitleStatusView(subtitle({ state: "disabled" }), {
        pending: "starting",
      }).primaryAction?.label.key,
    ).toBe("statusActionEnabling");
    expect(
      pageStatusView(
        page({ state: "cancelled", total: 6, completed: 2, failed: 4 }),
        { pending: "resuming" },
      ).primaryAction?.label.key,
    ).toBe("statusActionResuming");
  });

  it("keeps partial terminal and only enters translating via an explicit retry", () => {
    const partial = pageStatusView(
      page({
        state: "partial",
        total: 10,
        completed: 7,
        failed: 3,
        reasonCode: "rate_limited",
      }),
    );
    expect(partial.kind).toBe("partial");
    expect(partial.animated).toBe(false);
    expect(partial.primaryAction).toEqual({
      id: "retry",
      label: { key: "statusActionRetryBlocks", substitutions: ["3"] },
      disabled: false,
      busy: false,
    });
    expect(partial.secondaryActions.map((a) => a.id)).toEqual(["restore"]);
    expect(partial.title).toEqual({
      key: "statusTitlePartialPage",
      substitutions: ["7", "10", "3"],
    });
    expect(partial.reason?.key).toBe("statusReasonRateLimited");

    const retry = { completedAtStart: 7, count: 3 };
    const retryingView = pageStatusView(
      page({ state: "translating", total: 10, completed: 8, failed: 2 }),
      { retry },
    );
    expect(retryingView.kind).toBe("translating");
    expect(retryingView.retrying).toBe(true);
    expect(retryingView.title).toEqual({
      key: "statusTitleRetryingPage",
      substitutions: ["1", "3"],
    });
    expect(retryingView.primaryAction?.id).toBe("stop");

    const subtitlePartial = subtitleStatusView(
      subtitle({
        state: "partial",
        completeness: "full",
        total: 8,
        completed: 6,
        failed: 2,
      }),
    );
    expect(subtitlePartial.primaryAction?.label).toEqual({
      key: "statusActionRetryCues",
      substitutions: ["2"],
    });
    expect(subtitlePartial.secondaryActions.map((a) => a.id)).toEqual([
      "disable",
    ]);
    expect(
      subtitleStatusView(
        subtitle({ state: "translating", total: 8, completed: 7, failed: 1 }),
        { retry: { completedAtStart: 6, count: 2 } },
      ).title,
    ).toEqual({
      key: "statusTitleRetryingSubtitle",
      substitutions: ["1", "2"],
    });
  });

  it("labels stream tracks with the fixed live constraint", () => {
    const live = subtitleStatusView(
      subtitle({
        state: "ready",
        source: "dom",
        completeness: "stream",
        total: 2,
        completed: 2,
      }),
    );
    expect(live.tracks).toEqual(["stream"]);
    expect(live.title.key).toBe("statusTitleLiveSubtitle");
    expect(live.reason).toEqual({
      key: "statusReasonStreamFallback",
      substitutions: [],
    });
    expect(live.primaryAction?.id).toBe("disable");
    expect(live.secondaryActions.map((a) => a.id)).toEqual(["switchDisplay"]);

    const netflix = subtitleStatusView(
      subtitle({
        state: "translating",
        source: "netflix-manifest",
        completeness: "stream",
        total: 1,
        reasonCode: STATUS_REASON.streamFallbackRefresh,
      }),
    );
    expect(netflix.reason?.key).toBe("statusReasonStreamFallbackRefresh");

    const ocr = subtitleStatusView(
      subtitle({
        state: "ready",
        source: "ocr",
        completeness: "stream",
        total: 1,
        completed: 1,
      }),
    );
    expect(ocr.tracks).toEqual(["stream", "experimental"]);
    expect(ocr.reason?.key).toBe("statusReasonOcrLocalOnly");

    const full = subtitleStatusView(
      subtitle({
        state: "ready",
        source: "texttrack",
        completeness: "full",
        total: 9,
        completed: 9,
      }),
    );
    expect(full.tracks).toEqual(["full"]);
    expect(full.reason).toBeUndefined();
    expect(full.title).toEqual({
      key: "statusTitleReadySubtitle",
      substitutions: ["9"],
    });

    expect(
      subtitleStatusView(subtitle({ state: "ready", total: 1 }), {
        track: "ocr",
      }).tracks,
    ).toEqual(["stream", "experimental"]);
    expect(
      subtitleStatusView(subtitle({ state: "waiting", completeness: "full" }))
        .tracks,
    ).toEqual([]);
  });

  it("names the failure reason ahead of the stream constraint", () => {
    const view = subtitleStatusView(
      subtitle({
        state: "error",
        source: "dom",
        completeness: "stream",
        total: 1,
        failed: 1,
        reasonCode: "request_failed",
      }),
    );
    expect(view.reason?.key).toBe("statusReasonRequestFailed");
    expect(view.tracks).toEqual(["stream"]);
  });

  it("chooses unavailable and error actions by reason", () => {
    expect(
      subtitleStatusView(
        subtitle({
          state: "unavailable",
          reasonCode: STATUS_REASON.sourceLanguageMismatch,
        }),
      ),
    ).toMatchObject({
      title: { key: "statusTitleUnavailableSubtitleLanguage" },
      reason: { key: "statusReasonLanguageMismatch" },
      primaryAction: { id: "useAutoDetect" },
    });
    const noTrack = subtitle({
      state: "unavailable",
      reasonCode: STATUS_REASON.subtitleNoTrack,
    });
    // Without OCR, re-checking is the only remedy and takes the primary slot.
    const withoutOcr = subtitleStatusView(noTrack);
    expect(withoutOcr.primaryAction).toMatchObject({
      id: "rescan",
      label: { key: "statusActionRescan" },
    });
    expect(withoutOcr.secondaryActions).toEqual([]);
    const withOcr = subtitleStatusView(noTrack, { ocrAvailable: true });
    expect(withOcr.primaryAction?.id).toBe("tryOcr");
    expect(withOcr.secondaryActions.map((item) => item.id)).toEqual(["rescan"]);
    // Other unavailable reasons never offer a rescan.
    expect(
      subtitleStatusView(
        subtitle({
          state: "unavailable",
          reasonCode: STATUS_REASON.subtitleNoVideo,
        }),
        { ocrAvailable: true },
      ).secondaryActions,
    ).toEqual([]);
    expect(
      pageStatusView(
        page({
          state: "unavailable",
          reasonCode: STATUS_REASON.frameTranslatorBlocked,
        }),
      ),
    ).toMatchObject({
      reason: { key: "statusReasonRestrictedPage" },
      secondaryActions: [],
    });

    const config = pageStatusView(
      page({
        state: "error",
        total: 2,
        failed: 2,
        reasonCode: "invalid_configuration",
      }),
    );
    expect(config.primaryAction?.id).toBe("openProviderSettings");
    expect(config.secondaryActions.map((a) => a.id)).toEqual(["retry"]);

    const timeout = pageStatusView(
      page({
        state: "error",
        total: 2,
        failed: 2,
        reasonCode: "request_timeout",
      }),
    );
    expect(timeout.primaryAction?.id).toBe("retry");
    expect(timeout.secondaryActions.map((a) => a.id)).toEqual([
      "openProviderSettings",
    ]);

    // A task-level error without failed items restarts instead of "retry 0".
    expect(
      pageStatusView(page({ state: "error", reasonCode: "request_failed" }))
        .primaryAction?.id,
    ).toBe("translate");
  });

  it("titles cancelled tasks with the kept count and offers continue", () => {
    const view = subtitleStatusView(
      subtitle({
        state: "cancelled",
        completeness: "full",
        total: 12,
        completed: 5,
      }),
    );
    expect(view.title).toEqual({
      key: "statusTitleCancelled",
      substitutions: ["5", "12"],
    });
    expect(view.primaryAction?.id).toBe("resume");
    expect(view.reason).toBeUndefined();
  });
});

describe("status reason mapping", () => {
  it.each([
    ["rate_limited", "statusReasonRateLimited"],
    ["request_timeout", "statusReasonTimeout"],
    ["provider_server_error", "statusReasonServerError"],
    ["provider_error", "statusReasonServerError"],
    ["network_error", "statusReasonNetworkError"],
    ["invalid_response", "statusReasonInvalidResponse"],
    ["invalid_configuration", "statusReasonInvalidConfiguration"],
    ["permission_required", "statusReasonPermissionRequired"],
    ["request_failed", "statusReasonRequestFailed"],
    ["page_content_changed", "statusReasonPageChanged"],
    [STATUS_REASON.restrictedPage, "statusReasonRestrictedPage"],
    [STATUS_REASON.frameTranslatorBlocked, "statusReasonRestrictedPage"],
    [STATUS_REASON.subtitleNoTrack, "statusReasonNoTrack"],
    [STATUS_REASON.subtitleNoVideo, "statusReasonNoVideo"],
    [STATUS_REASON.sourceLanguageMismatch, "statusReasonLanguageMismatch"],
    [STATUS_REASON.streamFallback, "statusReasonStreamFallback"],
    [STATUS_REASON.streamFallbackRefresh, "statusReasonStreamFallbackRefresh"],
    [
      STATUS_REASON.ocrLocalTranslationUnavailable,
      "statusReasonOcrTranslationUnavailable",
    ],
    [STATUS_REASON.ocrProtectedVideo, "statusReasonOcrProtectedVideo"],
    ["bergamot_package_missing", "statusReasonLocalModelMissing"],
    ["chrome_pair_unavailable", "statusReasonLanguagePairUnsupported"],
  ])("maps %s to %s", (code, key) => {
    expect(resolveReason(code).text).toEqual({ key, substitutions: [] });
  });

  it("reports unknown and missing codes without guessing a cause", () => {
    expect(resolveReason("some_future_code").text).toEqual({
      key: "statusReasonUnknown",
      substitutions: ["some_future_code"],
    });
    // Object prototype names must not resolve to a known reason.
    expect(resolveReason("constructor").text.key).toBe("statusReasonUnknown");
    expect(resolveReason(undefined).text).toEqual({
      key: "statusReasonUnspecified",
      substitutions: [],
    });
    const view = pageStatusView(
      page({
        state: "partial",
        total: 3,
        completed: 2,
        failed: 1,
        reasonCode: "some_future_code",
        details: "status=418",
      }),
    );
    expect(view.reason?.key).toBe("statusReasonUnknown");
    expect(view.diagnostics).toEqual({
      reasonCode: "some_future_code",
      details: "status=418",
    });
    expect(
      pageStatusView(page({ state: "error", total: 1, failed: 1 })).reason?.key,
    ).toBe("statusReasonUnspecified");
  });

  it("derives failure codes from errors, tokens and contract codes only", () => {
    expect(
      failureReasonCode(
        new NoriTransError(
          "x",
          "request_failed",
          true,
          undefined,
          "rate_limited",
        ),
      ),
    ).toBe("rate_limited");
    expect(
      failureReasonCode({
        code: "request_failed",
        message: runtimeErrorToken("rate_limited"),
        retryable: true,
      }),
    ).toBe("rate_limited");
    expect(
      failureReasonCode({ code: "invalid_configuration", message: "anything" }),
    ).toBe("invalid_configuration");
    expect(failureReasonCode(new Error("free text"))).toBeUndefined();
    expect(failureReasonCode("free text")).toBeUndefined();
  });
});

describe("status locale catalog", () => {
  it("defines every status key in both catalogs with matching placeholders", () => {
    for (const key of STATUS_MESSAGE_KEYS) {
      for (const [locale, catalog] of Object.entries(catalogs)) {
        expect(catalog[key], `${locale} ${key}`).toBeDefined();
      }
      expect(
        Object.keys(catalogs.zh_CN?.[key]?.placeholders ?? {}).sort(),
      ).toEqual(Object.keys(catalogs.en?.[key]?.placeholders ?? {}).sort());
    }
  });

  it("emits substitutions that match each key's placeholder count", () => {
    const views = [
      pageStatusView(page({ state: "translating", total: 4, completed: 1 })),
      pageStatusView(page({ state: "translated", total: 4, completed: 4 })),
      pageStatusView(
        page({ state: "partial", total: 4, completed: 3, failed: 1 }),
      ),
      pageStatusView(
        page({ state: "translating", total: 4, completed: 3, failed: 1 }),
        { retry: { completedAtStart: 2, count: 2 } },
      ),
      subtitleStatusView(
        subtitle({
          state: "cancelled",
          completeness: "full",
          total: 3,
          completed: 1,
        }),
      ),
      pageStatusView(
        page({ state: "error", total: 1, failed: 1, reasonCode: "zzz" }),
      ),
    ];
    const texts = views.flatMap((view) => [
      view.title,
      ...(view.reason ? [view.reason] : []),
      ...(view.progressNote ? [view.progressNote] : []),
      ...(view.primaryAction ? [view.primaryAction.label] : []),
      ...view.secondaryActions.map((item) => item.label),
    ]);
    for (const item of texts) {
      const placeholders = Object.keys(
        catalogs.en?.[item.key]?.placeholders ?? {},
      );
      expect(item.substitutions, item.key).toHaveLength(placeholders.length);
    }
  });

  it("does not name OCR engines or models in user-facing status copy", () => {
    for (const key of STATUS_MESSAGE_KEYS) {
      for (const catalog of Object.values(catalogs)) {
        expect(catalog[key]?.message).not.toMatch(
          /PP-OCR|ONNX|Paddle|sha-?256/iu,
        );
      }
    }
  });
});

describe("reason codes across frames and the protocol", () => {
  it("passes the reason of the frame that supplied the message", () => {
    const aggregated = aggregatePageStatuses(
      page({ state: "translated", total: 2, completed: 2 }),
      [
        page({
          state: "partial",
          total: 2,
          completed: 1,
          failed: 1,
          message: "rate",
          reasonCode: "rate_limited",
        }),
        page({
          state: "error",
          total: 1,
          failed: 1,
          message: "other",
          reasonCode: "request_timeout",
        }),
      ],
    );
    expect(aggregated).toMatchObject({
      state: "partial",
      message: "rate",
      reasonCode: "rate_limited",
    });

    // A message without a code stays unknown instead of borrowing another
    // frame's code.
    const unknown = aggregatePageStatuses(
      page({ state: "error", total: 1, failed: 1, message: "no code" }),
      [
        page({
          state: "error",
          total: 1,
          failed: 1,
          reasonCode: "rate_limited",
        }),
      ],
    );
    expect(unknown.reasonCode).toBeUndefined();
  });

  it("prefers a specific unavailable reason over a frame without video", () => {
    const aggregated = aggregateSubtitleStatuses(
      subtitle({
        state: "unavailable",
        reasonCode: STATUS_REASON.subtitleNoVideo,
      }),
      [
        subtitle({
          state: "unavailable",
          reasonCode: STATUS_REASON.subtitleNoTrack,
        }),
      ],
    );
    expect(aggregated).toEqual({
      state: "unavailable",
      total: 0,
      completed: 0,
      failed: 0,
      reasonCode: STATUS_REASON.subtitleNoTrack,
    });
    const mismatch = aggregateSubtitleStatuses(
      subtitle({
        state: "unavailable",
        reasonCode: STATUS_REASON.subtitleNoTrack,
      }),
      [
        subtitle({
          state: "unavailable",
          message: "mismatch",
          reasonCode: STATUS_REASON.sourceLanguageMismatch,
        }),
      ],
    );
    expect(mismatch.reasonCode).toBe(STATUS_REASON.sourceLanguageMismatch);
  });

  it("drops reasons for a disabled feature and keeps them for active tasks", () => {
    expect(
      aggregateSubtitleStatuses(subtitle({ state: "disabled" }), [
        subtitle({
          state: "unavailable",
          reasonCode: STATUS_REASON.subtitleNoTrack,
        }),
      ]).reasonCode,
    ).toBeUndefined();
    expect(
      aggregateSubtitleStatuses(
        subtitle({
          state: "unavailable",
          reasonCode: STATUS_REASON.subtitleNoVideo,
        }),
        [
          subtitle({
            state: "ready",
            completeness: "stream",
            total: 1,
            completed: 1,
            message: "fallback",
            reasonCode: STATUS_REASON.streamFallback,
          }),
        ],
      ).reasonCode,
    ).toBe(STATUS_REASON.streamFallback);
  });

  it("accepts a missing or well-formed reasonCode and rejects malformed ones", () => {
    expect(isPageStatusValue(page())).toBe(true);
    expect(isPageStatusValue(page({ reasonCode: "rate_limited" }))).toBe(true);
    expect(
      isSubtitleStatusValue(
        subtitle({ reasonCode: STATUS_REASON.subtitleNoTrack }),
      ),
    ).toBe(true);
    for (const reasonCode of [
      "",
      "Rate Limited",
      "rate-limited",
      "x".repeat(65),
      42,
      null,
    ]) {
      expect(isPageStatusValue({ ...page(), reasonCode })).toBe(false);
      expect(isSubtitleStatusValue({ ...subtitle(), reasonCode })).toBe(false);
    }
    expect(isStatusReasonCode("a".repeat(64))).toBe(true);
  });
});
