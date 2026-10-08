import {
  isSubtitleContentSettingCommand,
  type SubtitleContentSettingCommand,
  type SubtitleContentSettingResponse,
} from "@/src/messaging/protocol";
import {
  isTopFrameContentScriptSender,
  type ContentMessageSender,
} from "@/src/shared/content-sender";
import type { AppSettings, ContentSettings } from "@/src/shared/settings";

export interface SubtitleContentSettingDeps {
  extension: { id: string; baseUrl: string };
  /** Serialized load → update → save → broadcast (`SETTINGS_UPDATED`). */
  mutateSettings(
    update: (current: AppSettings) => AppSettings,
  ): Promise<AppSettings>;
  /** Effective content settings for the sending tab (site profiles applied). */
  contentSettings(updated: AppSettings): Promise<ContentSettings>;
}

/** Applies one command; touches only `subtitles.enabled` or `subtitles.position`. */
export function applySubtitleContentSetting(
  settings: AppSettings,
  command: SubtitleContentSettingCommand,
): AppSettings {
  switch (command.type) {
    case "SUBTITLE_ENABLED_SET":
      return {
        ...settings,
        subtitles: { ...settings.subtitles, enabled: command.enabled },
      };
    case "SUBTITLE_POSITION_PRESET_SET":
      return {
        ...settings,
        subtitles: { ...settings.subtitles, position: command.preset },
      };
  }
}

/**
 * Handles `SUBTITLE_ENABLED_SET` / `SUBTITLE_POSITION_PRESET_SET`. The sender
 * is checked before the payload so foreign senders learn nothing about the
 * accepted shape. Storage errors are reported as a code only; no error text
 * leaves the background.
 */
export async function handleSubtitleContentSetting(
  message: unknown,
  sender: ContentMessageSender,
  deps: SubtitleContentSettingDeps,
): Promise<SubtitleContentSettingResponse> {
  if (!isTopFrameContentScriptSender(sender, deps.extension)) {
    return { ok: false, code: "subtitle_setting_sender_rejected" };
  }
  if (!isSubtitleContentSettingCommand(message)) {
    return { ok: false, code: "subtitle_setting_invalid_payload" };
  }
  try {
    const updated = await deps.mutateSettings((current) =>
      applySubtitleContentSetting(current, message),
    );
    return {
      ok: true,
      code: "subtitle_setting_saved",
      settings: await deps.contentSettings(updated),
    };
  } catch {
    return { ok: false, code: "subtitle_setting_save_failed" };
  }
}
