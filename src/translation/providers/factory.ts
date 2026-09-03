import { NoriTransError } from "@/src/shared/errors";
import { runtimeErrorToken } from "@/src/shared/runtime-errors";
import type {
  AiProviderId,
  AppSettings,
  FastProviderId,
} from "@/src/shared/settings";
import { BergamotLocalProvider } from "@/src/translation/providers/bergamot-local";
import { DeepLProvider } from "@/src/translation/providers/deepl";
import { GoogleTranslateProvider } from "@/src/translation/providers/google-translate";
import { MicrosoftTranslatorProvider } from "@/src/translation/providers/microsoft-translator";
import { OpenAICompatibleProvider } from "@/src/translation/providers/openai-compatible";
import { NorixorTranslationProvider } from "@/src/translation/providers/norixor";
import type {
  TranslationMode,
  TranslationProvider,
} from "@/src/translation/types";

export function createBackgroundTranslationProvider(
  providerId: FastProviderId | AiProviderId | "norixor",
  mode: TranslationMode,
  settings: AppSettings,
  model: string,
): TranslationProvider {
  if (providerId === "norixor") {
    return new NorixorTranslationProvider(settings.norixor.model);
  }
  if (
    providerId === "openai-compatible" ||
    providerId === "anthropic-messages"
  ) {
    return new OpenAICompatibleProvider(mode, {
      protocol: providerId,
      baseUrl: settings.provider.baseUrl,
      apiKey: settings.provider.apiKey,
      model,
      systemPrompt: settings.provider.systemPrompt,
      timeoutMs: settings.provider.timeoutMs,
    });
  }
  if (providerId === "bergamot-local") {
    return new BergamotLocalProvider();
  }
  if (providerId === "google-translate") {
    return new GoogleTranslateProvider({
      apiKey: settings.provider.googleApiKey,
      timeoutMs: settings.provider.timeoutMs,
    });
  }
  if (providerId === "microsoft-translator") {
    return new MicrosoftTranslatorProvider({
      apiKey: settings.provider.microsoftApiKey,
      microsoftRegion: settings.provider.microsoftRegion,
      timeoutMs: settings.provider.timeoutMs,
    });
  }
  if (providerId === "deepl") {
    return new DeepLProvider({
      apiKey: settings.provider.deeplApiKey,
      deeplPlan: settings.provider.deeplPlan,
      timeoutMs: settings.provider.timeoutMs,
    });
  }
  throw new NoriTransError(
    runtimeErrorToken("provider_unavailable"),
    "provider_unavailable",
  );
}
