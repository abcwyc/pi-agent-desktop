/** Five background washes; appearance (light/dark) stays independent. */
export const BACKGROUND_OPTIONS = [
  { id: "rex", label: "settings.backgroundPetal" },
  { id: "mist", label: "settings.backgroundMist" },
  { id: "meadow", label: "settings.backgroundMeadow" },
  { id: "dusk", label: "settings.backgroundDusk" },
  { id: "plain", label: "settings.backgroundPlain" },
] as const;

export type BackgroundPreference = (typeof BACKGROUND_OPTIONS)[number]["id"];
export const DEFAULT_BACKGROUND: BackgroundPreference = "rex";

export function isBackgroundPreference(value: unknown): value is BackgroundPreference {
  return BACKGROUND_OPTIONS.some((option) => option.id === value);
}
