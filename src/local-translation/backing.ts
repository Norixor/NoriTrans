import { TranslatorBacking } from "@mkljczk/bergamot-translator";
import { BergamotRuntimeError } from "@/src/local-translation/errors";
import type { BergamotLanguage } from "@/src/local-translation/types";
import type {
  BergamotRuntimeStorage,
  LoadedBergamotModel,
} from "@/src/local-translation/runtime-storage";

interface BackingModel {
  from: string;
  to: string;
  files: Record<
    string,
    { name: string; size: number; expectedSha256Hash: string }
  >;
}

/** Supplies only verified CacheStorage bytes to the Bergamot worker. */
export class InstalledBergamotBacking extends TranslatorBacking {
  private storage: BergamotRuntimeStorage | undefined;

  constructor(storage: BergamotRuntimeStorage, workerUrl: string) {
    super({
      workerUrl,
      pivotLanguage: "en",
      downloadTimeout: 0,
      cacheSize: 256,
      useNativeIntGemm: false,
    });
    this.storage = storage;
  }

  override async loadModelRegistry(): Promise<BackingModel[]> {
    // The base constructor invokes this override before assigning our field.
    // Yield once so the subclass constructor can finish initialization.
    await Promise.resolve();
    const storage = this.storage;
    if (!storage) {
      throw new BergamotRuntimeError(
        "bergamot_runtime_failed",
        "Bergamot model storage was not initialized.",
        true,
      );
    }
    return (await storage.installedModels()).map(({ from, to }) => ({
      from,
      to,
      files: {},
    }));
  }

  override async loadTranslationModel({
    from,
    to,
  }: {
    from: string;
    to: string;
  }): Promise<LoadedBergamotModel> {
    const storage = this.storage;
    if (!storage) {
      throw new BergamotRuntimeError(
        "bergamot_runtime_failed",
        "Bergamot model storage was not initialized.",
        true,
      );
    }
    return storage.loadModel(from as BergamotLanguage, to as BergamotLanguage);
  }

  override fetch(): Promise<ArrayBuffer> {
    return Promise.reject(
      new BergamotRuntimeError(
        "bergamot_package_missing",
        "Bergamot may load only explicitly installed language packages.",
        false,
      ),
    );
  }
}
