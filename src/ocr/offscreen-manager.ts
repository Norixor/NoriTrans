export interface OcrOffscreenDocumentApi {
  getContexts(): Promise<readonly unknown[]>;
  createDocument(): Promise<void>;
}

/** Coalesces concurrent service-worker requests into one document creation. */
export function createOcrOffscreenDocumentEnsurer(
  api: OcrOffscreenDocumentApi,
): () => Promise<void> {
  let creating: Promise<void> | undefined;
  return async (): Promise<void> => {
    if (creating) return creating;
    const contexts = await api.getContexts();
    if (contexts.length > 0) return;
    if (!creating) {
      const pending = api.createDocument();
      const tracked = pending.finally(() => {
        if (creating === tracked) creating = undefined;
      });
      creating = tracked;
    }
    return creating;
  };
}
