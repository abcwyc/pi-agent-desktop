import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";

/**
 * Whether a session is named automatically after its first completed turn.
 * Off by default: the title is one extra request to the session's own model,
 * which costs money on paid providers, so the user opts in.
 */
export function isAutoTitleEnabled(settingsPath = getPiWebSettingsPath()): boolean {
  try {
    return readStored(settingsPath).autoTitle === true;
  } catch {
    return false;
  }
}

export function writeAutoTitleEnabled(enabled: boolean, settingsPath = getPiWebSettingsPath()): boolean {
  updatePiWebSettings({ autoTitle: enabled }, settingsPath);
  return isAutoTitleEnabled(settingsPath);
}
