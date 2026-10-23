import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";
import { isBackgroundPreference, type BackgroundPreference } from "./backgrounds";

/** Null means there is no saved desktop choice; retain a browser-local choice. */
export function readBackgroundPreference(path = getPiWebSettingsPath()): BackgroundPreference | null {
  const value = readStored(path).background;
  return isBackgroundPreference(value) ? value : null;
}

export function writeBackgroundPreference(background: BackgroundPreference, path = getPiWebSettingsPath()): void {
  updatePiWebSettings({ background }, path);
}
