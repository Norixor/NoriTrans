import { isTranslationProgressMessage } from "@/src/messaging/protocol";
import type { TranslationResult } from "@/src/translation/types";
import { browser } from "wxt/browser";

type ProgressListener = (result: TranslationResult) => void;
type RuntimeMessageListener = (
  message: unknown,
  sender: Browser.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => unknown;

const listeners = new Map<string, Set<ProgressListener>>();
let listening = false;

const handleProgressMessage: RuntimeMessageListener = (message) => {
  if (!isTranslationProgressMessage(message)) return undefined;
  for (const listener of listeners.get(message.requestId) ?? []) {
    try {
      listener(message.result);
    } catch {
      // The final response remains authoritative if a UI listener fails.
    }
  }
  return undefined;
};

function runtimeMessageEvent():
  | {
      addListener(listener: RuntimeMessageListener): void;
      removeListener(listener: RuntimeMessageListener): void;
    }
  | undefined {
  return (
    browser.runtime as unknown as {
      onMessage?: {
        addListener(listener: RuntimeMessageListener): void;
        removeListener(listener: RuntimeMessageListener): void;
      };
    }
  ).onMessage;
}

export function subscribeTranslationProgress(
  requestId: string,
  listener: ProgressListener,
): () => void {
  const subscribers = listeners.get(requestId) ?? new Set<ProgressListener>();
  subscribers.add(listener);
  listeners.set(requestId, subscribers);
  const event = runtimeMessageEvent();
  if (!listening && event) {
    event.addListener(handleProgressMessage);
    listening = true;
  }
  return () => {
    const current = listeners.get(requestId);
    current?.delete(listener);
    if (current?.size === 0) listeners.delete(requestId);
    if (listeners.size === 0 && listening) {
      runtimeMessageEvent()?.removeListener(handleProgressMessage);
      listening = false;
    }
  };
}
