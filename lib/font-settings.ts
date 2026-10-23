import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";
import { isFontPreferences, type FontPreferences } from "./font-preferences";

export function readFontPreferences(path = getPiWebSettingsPath()): FontPreferences | null {
  const fonts = readStored(path).fonts;
  return isFontPreferences(fonts) ? { ui: fonts.ui, mono: fonts.mono } : null;
}

export function writeFontPreferences(fonts: FontPreferences, path = getPiWebSettingsPath()): void {
  updatePiWebSettings({ fonts: { ui: fonts.ui, mono: fonts.mono } }, path);
}
