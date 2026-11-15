// The theme kit: CSS variables and SVG classes that an artifact page can use
// to look like part of the app, in every built-in theme.
//
// A generated page that hard-codes colours is a white island in a dark app.
// The kit gives it a vocabulary instead (`--color-text-primary`,
// `--color-series-1`, `.box`, `.c-blue`, ...), filled from the app's own
// tokens, so one diagram reads right in light and dark. The names follow the
// ones models already know from other generative-UI hosts.
//
// Only pages that use the kit get it (`usesThemeKit`): injecting it into
// everything would change documents that were written without it. Its rules
// sit in `:where()`, so they have no specificity and a page's own CSS always
// wins over them.

export type PreviewScheme = "light" | "dark";

export interface PreviewThemeKit {
  scheme: PreviewScheme;
  /** The base variables. The derived ones (tints, mid borders) are computed from these in CSS. */
  vars: Record<string, string>;
}

/** The app tokens the kit is built from. */
export interface PreviewThemeTokens {
  background?: string | undefined;
  text?: string | undefined;
  textMuted?: string | undefined;
  border?: string | undefined;
  info?: string | undefined;
  success?: string | undefined;
  warning?: string | undefined;
  danger?: string | undefined;
}

export const THEME_KIT_STYLE_ID = "pi-theme-kit";

const VAR_NAME_RE = /^--color-(?:text|background|border|series)-[a-z0-9-]+$/;
// Computed colours: hex, rgb()/rgba(), hsl(), color(srgb ... / a). No quotes,
// braces, semicolons or angle brackets, so a value cannot leave its declaration.
const COLOR_RE = /^[#a-z0-9(),.%\s/-]+$/i;

export function isPreviewColor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && COLOR_RE.test(value) && !/url\s*\(/i.test(value);
}

/** What a page that uses the kit says: a kit variable, or one of its node colour classes. */
const KIT_USE_RE = /var\(\s*--color-(?:text|background|border|series)-|\bclass\s*=\s*["'][^"']*\bc-(?:blue|teal|amber|red|purple|gray)\b/i;

// The kit's plain SVG classes are too common as names on their own (`.box`), so
// they only count next to an <svg> and for the ones a page would not use by accident.
const SVG_CLASS_RE = /\bclass\s*=\s*["'][^"']*\b(?:arr|leader|ts|th)\b/i;

export function usesThemeKit(code: string): boolean {
  return KIT_USE_RE.test(code) || (/<svg\b/i.test(code) && SVG_CLASS_RE.test(code));
}

const DEFAULT_TOKENS: Record<PreviewScheme, Required<PreviewThemeTokens>> = {
  light: {
    background: "#ffffff",
    text: "#1d1d1f",
    textMuted: "#5f5f63",
    border: "rgba(0, 0, 0, 0.12)",
    info: "#315bd2",
    success: "#22863a",
    warning: "#a5680d",
    danger: "#d93a35",
  },
  dark: {
    background: "#1c1c1e",
    text: "#f5f5f7",
    textMuted: "#a1a1a6",
    border: "rgba(255, 255, 255, 0.14)",
    info: "#6ea2ff",
    success: "#4fd17a",
    warning: "#f0a33a",
    danger: "#ff6961",
  },
};

// Data needs telling apart, and the app's own accents are greys in most
// themes, so series colours are fixed per scheme and picked to read on its canvas.
const SERIES: Record<PreviewScheme, readonly string[]> = {
  light: ["#2f6fdf", "#159a7a", "#d98a10", "#d2453b", "#7a5bd6", "#6b7280"],
  dark: ["#6ea2ff", "#3cc9a4", "#f0b143", "#f0776d", "#a891f5", "#9ca3af"],
};

/** The kit for a scheme from the app's tokens; any token that is missing or unsafe falls back to the scheme's default. */
export function buildThemeKit(scheme: PreviewScheme, tokens: PreviewThemeTokens = {}): PreviewThemeKit {
  const fallback = DEFAULT_TOKENS[scheme];
  const pick = (name: keyof PreviewThemeTokens): string => {
    const value = tokens[name]?.trim();
    return isPreviewColor(value) ? value : fallback[name];
  };
  const vars: Record<string, string> = {
    "--color-text-primary": pick("text"),
    "--color-text-secondary": pick("textMuted"),
    "--color-background-primary": pick("background"),
    "--color-border-tertiary": pick("border"),
    "--color-text-info": pick("info"),
    "--color-text-success": pick("success"),
    "--color-text-warning": pick("warning"),
    "--color-text-danger": pick("danger"),
  };
  SERIES[scheme].forEach((color, index) => {
    vars[`--color-series-${index + 1}`] = color;
  });
  return { scheme, vars };
}

export function defaultThemeKit(scheme: PreviewScheme): PreviewThemeKit {
  return buildThemeKit(scheme);
}

/** Only the kit's own variables, with safe values: what may be written into a style or posted to a frame. */
export function safeThemeKitVars(vars: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (VAR_NAME_RE.test(name) && isPreviewColor(value)) safe[name] = value;
  }
  return safe;
}

const FONT_SANS = 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif';
const FONT_MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

// Derived from the base variables inside the page, so a theme switch that only
// rewrites the base ones re-derives these without another message.
const DERIVED = [
  "--color-text-tertiary:color-mix(in srgb,var(--color-text-secondary) 70%,var(--color-background-primary))",
  "--color-background-secondary:color-mix(in srgb,var(--color-text-primary) 5%,var(--color-background-primary))",
  "--color-border-secondary:color-mix(in srgb,var(--color-text-secondary) 35%,var(--color-border-tertiary))",
  "--color-border-primary:color-mix(in srgb,var(--color-text-secondary) 60%,var(--color-border-tertiary))",
  "--color-background-info:color-mix(in srgb,var(--color-text-info) 14%,transparent)",
  "--color-background-success:color-mix(in srgb,var(--color-text-success) 14%,transparent)",
  "--color-background-warning:color-mix(in srgb,var(--color-text-warning) 14%,transparent)",
  "--color-background-danger:color-mix(in srgb,var(--color-text-danger) 14%,transparent)",
  `--font-sans:${FONT_SANS}`,
  `--font-mono:${FONT_MONO}`,
  "--border-radius-md:6px",
  "--border-radius-lg:10px",
].join(";");

const NODE_COLORS: ReadonlyArray<readonly [string, number]> = [
  ["blue", 1],
  ["teal", 2],
  ["amber", 3],
  ["red", 4],
  ["purple", 5],
  ["gray", 6],
];

const SVG_CLASSES = [
  ":where(svg .t){font:14px var(--font-sans);fill:var(--color-text-primary)}",
  ":where(svg .ts){font:12px var(--font-sans);fill:var(--color-text-secondary)}",
  ":where(svg .th){font:500 14px var(--font-sans);fill:var(--color-text-primary)}",
  ":where(svg .box){fill:var(--color-background-secondary);stroke:var(--color-border-secondary)}",
  ":where(svg .arr){stroke:var(--color-text-tertiary);stroke-width:1.5;fill:none}",
  ":where(svg .leader){stroke:var(--color-text-tertiary);stroke-width:.5;stroke-dasharray:4 3;fill:none}",
  // `fill="context-stroke"` on an arrowhead is not supported everywhere (WebKit draws it black).
  ":where(svg marker path){fill:var(--color-text-tertiary)}",
  // Coloured nodes come after the neutral ones: equal specificity, so the later rule wins.
  ...NODE_COLORS.map(([name, n]) => {
    const color = `var(--color-series-${n})`;
    return `:where(svg .c-${name}>rect,svg .c-${name}>circle,svg .c-${name}>ellipse,svg .c-${name}>path,svg rect.c-${name},svg circle.c-${name}){fill:color-mix(in srgb,${color} 16%,var(--color-background-primary));stroke:${color};stroke-width:1}`
      + `:where(svg .c-${name}>.t,svg .c-${name}>.th,svg .c-${name}>.ts){fill:color-mix(in srgb,${color} 70%,var(--color-text-primary))}`;
  }),
].join("");

/**
 * The `<style>` that gives a page the kit. `colorScheme: false` leaves the
 * document's own colour scheme alone, for a frame that hosts pages which may
 * or may not follow the theme (the streaming shell).
 */
export function themeKitStyle(kit: PreviewThemeKit, { colorScheme = true }: { colorScheme?: boolean } = {}): string {
  const vars = Object.entries(safeThemeKitVars(kit.vars)).map(([name, value]) => `${name}:${value}`).join(";");
  const scheme = kit.scheme === "dark" ? "dark" : "light";
  return `<style id="${THEME_KIT_STYLE_ID}">:root{${colorScheme ? `color-scheme:${scheme};` : ""}${vars};${DERIVED}}${SVG_CLASSES}</style>`;
}

const SVG_OPEN_RE = /<svg\b[^>]*>/i;

/**
 * An SVG source with the kit inside it, for places that show it as an image
 * (thumbnails) or as a file (download), where the page's variables do not
 * exist. SVG without kit use, and a self-closing `<svg/>`, are returned as is.
 */
export function themeKitSvgSource(svg: string, kit: PreviewThemeKit): string {
  if (!usesThemeKit(svg)) return svg;
  const open = SVG_OPEN_RE.exec(svg);
  if (!open || open[0].endsWith("/>")) return svg;
  const end = open.index + open[0].length;
  return svg.slice(0, end) + themeKitStyle(kit) + svg.slice(end);
}
