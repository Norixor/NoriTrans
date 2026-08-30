export type RuntimeErrorCode =
  | "provider_unavailable"
  | "permission_required"
  | "invalid_configuration"
  | "invalid_response"
  | "request_failed"
  | "cancelled"
  | "content_settings_unavailable"
  | "settings_save_failed"
  | "profile_save_failed"
  | "page_content_changed";

type RuntimeErrorMessageKey =
  | "runtimeErrorProviderUnavailable"
  | "runtimeErrorPermissionRequired"
  | "runtimeErrorInvalidConfiguration"
  | "runtimeErrorInvalidResponse"
  | "runtimeErrorRequestFailed"
  | "runtimeErrorCancelled"
  | "runtimeErrorContentSettingsUnavailable"
  | "runtimeErrorSettingsSaveFailed"
  | "runtimeErrorProfileSaveFailed"
  | "runtimeErrorPageContentChanged";

const ERROR_PREFIX = "noritrans-error:";

const MESSAGE_KEYS: Record<RuntimeErrorCode, RuntimeErrorMessageKey> = {
  provider_unavailable: "runtimeErrorProviderUnavailable",
  permission_required: "runtimeErrorPermissionRequired",
  invalid_configuration: "runtimeErrorInvalidConfiguration",
  invalid_response: "runtimeErrorInvalidResponse",
  request_failed: "runtimeErrorRequestFailed",
  cancelled: "runtimeErrorCancelled",
  content_settings_unavailable: "runtimeErrorContentSettingsUnavailable",
  settings_save_failed: "runtimeErrorSettingsSaveFailed",
  profile_save_failed: "runtimeErrorProfileSaveFailed",
  page_content_changed: "runtimeErrorPageContentChanged",
};

const LEGACY_CODES: Readonly<Record<string, RuntimeErrorCode>> = {
  "Chrome 本地语言检测不可用，请手动选择源语言。": "provider_unavailable",
  "无法检测网页语言，请手动选择源语言。": "provider_unavailable",
  "当前 Chrome 不支持本地 Translator API。": "provider_unavailable",
  "Chrome 本地翻译不支持当前语言对。": "provider_unavailable",
  "尚未授权访问当前翻译服务，请在设置中重新保存 Provider。":
    "permission_required",
  "翻译请求包含空白或重复的段落 ID。": "invalid_response",
  "页面翻译批次包含空白或重复的段落 ID。": "invalid_response",
  "翻译服务返回了未知或重复的段落 ID。": "invalid_response",
  "翻译服务返回了无效译文。": "invalid_response",
  "翻译服务没有返回全部段落。": "invalid_response",
  "待翻译段落超过当前翻译服务的单批字符限制。": "request_failed",
  "页面内容在翻译期间发生变化，译文未能写入。": "page_content_changed",
  "翻译请求失败。": "request_failed",
  "无法读取翻译设置。": "content_settings_unavailable",
  "无法保存自动翻译设置。": "settings_save_failed",
  "无法保存图像字幕 OCR 设置。": "settings_save_failed",
  "字幕 Profile 保存失败。": "profile_save_failed",
};

function isRuntimeErrorCode(value: string): value is RuntimeErrorCode {
  return Object.hasOwn(MESSAGE_KEYS, value);
}

export function runtimeErrorToken(code: RuntimeErrorCode): string {
  return `${ERROR_PREFIX}${code}`;
}

export function runtimeErrorCode(value: unknown): RuntimeErrorCode | undefined {
  const message = value instanceof Error ? value.message : value;
  if (typeof message !== "string") return undefined;
  const candidate = message.startsWith(ERROR_PREFIX)
    ? message.slice(ERROR_PREFIX.length)
    : message;
  if (isRuntimeErrorCode(candidate)) return candidate;
  return LEGACY_CODES[message];
}

export function safeRuntimeErrorToken(value: unknown): string {
  return runtimeErrorToken(runtimeErrorCode(value) ?? "request_failed");
}

export function localizeRuntimeError(
  value: unknown,
  getMessage: (key: RuntimeErrorMessageKey) => string,
  fallback: RuntimeErrorCode = "request_failed",
): string {
  const code = runtimeErrorCode(value) ?? fallback;
  const key = MESSAGE_KEYS[code];
  return getMessage(key) || key;
}
