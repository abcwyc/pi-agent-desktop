import { BACKGROUND_OPTIONS, DEFAULT_BACKGROUND } from "./backgrounds.ts";

export const THEME_OPTIONS = [
  { id: "auto", label: "settings.themeSystem" },
  { id: "light", label: "settings.themeLight" },
  { id: "dark", label: "settings.themeDark" },
] as const;

export type ThemePreference = (typeof THEME_OPTIONS)[number]["id"];
export type ResolvedTheme = Exclude<ThemePreference, "auto">;

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_OPTIONS.some((option) => option.id === value);
}

export function isDarkTheme(theme: ResolvedTheme): boolean {
  return theme === "dark";
}

// Apply the saved palette before first paint, including when storage is blocked.
export const THEME_INIT_SCRIPT = `(function(){var t="auto",b=${JSON.stringify(DEFAULT_BACKGROUND)};try{var s=localStorage.getItem("pi-theme");if(${JSON.stringify(THEME_OPTIONS.map((option) => option.id))}.includes(s))t=s;var p=localStorage.getItem("pi-background");if(${JSON.stringify(BACKGROUND_OPTIONS.map((option) => option.id))}.includes(p))b=p}catch(e){}if(t==="auto")t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var r=document.documentElement;r.dataset.theme=t;r.dataset.background=b;r.classList.toggle("dark",t==="dark")})();`;
