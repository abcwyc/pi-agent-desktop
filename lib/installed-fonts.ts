import { isFontFamily } from "./font-preferences.ts";

export type InstalledFont = { family: string; names?: { lang: string; name: string }[] };

/** Keep native results bounded and safe for a single CSS font-family. */
export function normalizeInstalledFonts(input: unknown): InstalledFont[] {
  if (!Array.isArray(input)) throw new Error("Invalid installed font list");
  const fonts = new Map<string, InstalledFont>();
  for (const entry of input.slice(0, 10000)) {
    if (!entry || !isFontFamily(entry.family) || !entry.family || entry.family.startsWith("@")) continue;
    const names = Array.isArray(entry.names) ? entry.names.filter((n: { lang?: unknown; name?: unknown }) =>
      typeof n?.lang === "string" && n.lang.length <= 35 && isFontFamily(n.name) && n.name).slice(0, 32) : [];
    const key = entry.family.toLowerCase();
    if (!fonts.has(key)) fonts.set(key, { family: entry.family, names });
  }
  return [...fonts.values()].sort((a, b) => a.family.localeCompare(b.family));
}

export function installedFontLabel(font: InstalledFont, locale: string): string {
  const language = locale.toLowerCase();
  const name = font.names?.find((n) => n.lang.toLowerCase() === language)?.name
    ?? (language.startsWith("zh") ? font.names?.find((n) => n.lang.toLowerCase().startsWith("zh"))?.name : undefined);
  return name && name !== font.family ? `${name} (${font.family})` : font.family;
}
