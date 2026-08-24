import { browser } from "wxt/browser";
import { bergamotFailure } from "@/src/local-translation/errors";
import { BergamotLocalRuntime } from "@/src/local-translation/runtime";
import {
  BERGAMOT_BACKGROUND_TARGET,
  BERGAMOT_CLIENT_TARGET,
  BERGAMOT_OFFSCREEN_TARGET,
  isBergamotOffscreenRequest,
  type BergamotOffscreenRequest,
  type BergamotOffscreenResponse,
  type BergamotResponseValue,
} from "@/src/local-translation/types";

const runtime = new BergamotLocalRuntime();
const activeRequests = new Map<string, AbortController>();
const activeTranslations = new Set<Promise<BergamotOffscreenResponse>>();
let bergamotOperationQueue: Promise<void> = Promise.resolve();
let pendingMutations = 0;
let registered = false;

function response(
  request: BergamotOffscreenRequest,
  result:
    | { ok: true; value: BergamotResponseValue }
    | { ok: false; error: ReturnType<typeof bergamotFailure> },
): BergamotOffscreenResponse {
  return {
    target: BERGAMOT_CLIENT_TARGET,
    type: "BERGAMOT_OFFSCREEN_RESPONSE",
    requestId: request.requestId,
    ...result,
  };
}

async function execute(
  request: BergamotOffscreenRequest,
  controller: AbortController,
): Promise<BergamotOffscreenResponse> {
  try {
    switch (request.type) {
      case "BERGAMOT_OFFSCREEN_LIST":
        return response(request, {
          ok: true,
          value: { runtimes: await runtime.list() },
        });
      case "BERGAMOT_OFFSCREEN_INSTALL":
        return response(request, {
          ok: true,
          value: {
            runtime: await runtime.install(request.packId, {
              signal: controller.signal,
              onProgress: (progress) => {
                void browser.runtime
                  .sendMessage({
                    target: BERGAMOT_BACKGROUND_TARGET,
                    type: "BERGAMOT_OFFSCREEN_PROGRESS",
                    requestId: request.requestId,
                    packId: request.packId,
                    progress,
                  })
                  .catch(() => undefined);
              },
            }),
          },
        });
      case "BERGAMOT_OFFSCREEN_DELETE":
        return response(request, {
          ok: true,
          value: { deleted: await runtime.deleteRuntime(request.packId) },
        });
      case "BERGAMOT_OFFSCREEN_TRANSLATE":
        return response(request, {
          ok: true,
          value: {
            translations: await runtime.translate(
              request.sourceLanguage,
              request.targetLanguage,
              request.segments,
              controller.signal,
            ),
          },
        });
      case "BERGAMOT_OFFSCREEN_CANCEL":
        return response(request, { ok: true, value: { deleted: false } });
      case "BERGAMOT_OFFSCREEN_RESET":
        await runtime.resetTranslator();
        return response(request, { ok: true, value: { reset: true } });
    }
  } catch (error) {
    return response(request, { ok: false, error: bergamotFailure(error) });
  }
}

export function registerBergamotOffscreenHandler(): void {
  if (registered) return;
  registered = true;
  browser.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (
        sender.id !== browser.runtime.id ||
        sender.tab !== undefined ||
        !isBergamotOffscreenRequest(message, BERGAMOT_OFFSCREEN_TARGET)
      ) {
        return undefined;
      }
      if (message.type === "BERGAMOT_OFFSCREEN_CANCEL") {
        activeRequests.get(message.requestId)?.abort();
        sendResponse(
          response(message, { ok: true, value: { deleted: false } }),
        );
        return false;
      }
      const controller = new AbortController();
      activeRequests.set(message.requestId, controller);
      const isMutation =
        message.type === "BERGAMOT_OFFSCREEN_INSTALL" ||
        message.type === "BERGAMOT_OFFSCREEN_DELETE" ||
        message.type === "BERGAMOT_OFFSCREEN_RESET";
      const isTranslation = message.type === "BERGAMOT_OFFSCREEN_TRANSLATE";
      const runTranslation = (): Promise<BergamotOffscreenResponse> => {
        const translation = execute(message, controller);
        activeTranslations.add(translation);
        void translation.finally(() => activeTranslations.delete(translation));
        return translation;
      };
      if (isMutation) pendingMutations += 1;
      const operation = isMutation
        ? bergamotOperationQueue
            .then(() => Promise.allSettled([...activeTranslations]))
            .then(() => execute(message, controller))
        : isTranslation
          ? pendingMutations > 0
            ? bergamotOperationQueue.then(runTranslation)
            : runTranslation()
          : execute(message, controller);
      if (isMutation) {
        bergamotOperationQueue = operation.then(
          () => undefined,
          () => undefined,
        );
      }
      void operation
        .finally(() => {
          if (isMutation) pendingMutations -= 1;
          if (activeRequests.get(message.requestId) === controller) {
            activeRequests.delete(message.requestId);
          }
        })
        .then(sendResponse);
      return true;
    },
  );
}
