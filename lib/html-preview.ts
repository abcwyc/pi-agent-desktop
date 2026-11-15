// Inline previews for ```html / ```svg fences in chat messages and artifacts.
//
// The document runs in an `srcDoc` iframe sandboxed with `allow-scripts` and
// never `allow-same-origin`: an opaque origin, so its scripts cannot read the
// app's cookies or storage, or call `/api/*`. Same rule as FileViewer's
// "Run scripts" mode — never give one iframe both tokens.
//
// `allow-popups-to-escape-sandbox` lets a link the user clicks open as an
// ordinary browser tab (with `noopener`) instead of an unusable sandboxed one.
// The desktop WebView has no tabs, so there the bootstrap hands links to the
// app, which opens them in the system browser (see HTML_PREVIEW_OPEN_MESSAGE).

import {
  defaultThemeKit,
  themeKitStyle,
  themeKitSvgSource,
  usesThemeKit,
  type PreviewThemeKit,
} from "./preview-theme-kit.ts";

export type HtmlPreviewKind = "html" | "svg" | "react";

export const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";
export const HTML_PREVIEW_SIZE_MESSAGE = "pi-html-preview:size";
export const HTML_PREVIEW_ERROR_MESSAGE = "pi-html-preview:error";
export const HTML_PREVIEW_OPEN_MESSAGE = "pi-html-preview:open";
/** Sent by `window.sendPrompt(text)` inside a frame: a request to put text in the user's composer. */
export const HTML_PREVIEW_PROMPT_MESSAGE = "pi-html-preview:prompt";
/** Longest text one `sendPrompt` call carries. */
export const HTML_PREVIEW_MAX_PROMPT_LENGTH = 2000;
/** Sent by the frame once its document is ready: the parent answers with the current theme. */
export const HTML_PREVIEW_READY_MESSAGE = "pi-html-preview:ready";
/** Sent to the frame when the app's theme changed, so it does not reload to follow it. */
export const HTML_PREVIEW_THEME_MESSAGE = "pi-html-preview:theme";
export const HTML_PREVIEW_MIN_HEIGHT = 60;
export const HTML_PREVIEW_MAX_HEIGHT = 560;
export const HTML_PREVIEW_DEFAULT_HEIGHT = 320;
/** Errors kept per frame; a page stuck in a loop must not flood the parent. */
export const HTML_PREVIEW_MAX_ERRORS = 5;

const HTML_LANGS = new Set(["html", "htm", "xhtml"]);
const REACT_LANGS = new Set(["jsx", "tsx", "react"]);
const SVG_HOST_LANGS = new Set(["svg", "xml", "html", "htm", "xhtml"]);
const FULL_HTML_RE = /^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html[^>]*>|<html[\s>])/i;
const SVG_ROOT_RE = /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+svg[^>]*>\s*)?<svg[\s>]/i;

export interface HtmlPreviewOptions {
  /**
   * The app's canvas and text colours. Applied only to documents that set no
   * colours of their own (see htmlPreviewFollowsTheme), so an unstyled page
   * reads like part of the app in both themes.
   */
  theme?: { scheme: "light" | "dark"; background: string; text: string };
  /**
   * The theme kit's values (see lib/preview-theme-kit.ts). Injected only into
   * documents that use the kit; without it the scheme's defaults apply.
   */
  themeKit?: PreviewThemeKit;
  /** Hand link clicks and window.open to the parent instead of the browser. */
  routeLinksToParent?: boolean;
  /** Shown in a React preview while its modules load. */
  loadingLabel?: string;
  /** The preview's own error wording, in the app's language (see HTML_PREVIEW_MESSAGES). */
  messages?: Partial<HtmlPreviewMessages>;
  /** Required for React previews; loaded by the page with loadPreviewRuntime(). */
  runtime?: PreviewRuntime;
}

/**
 * Which fences get a preview. Only complete documents do: an HTML fragment is
 * usually a snippet being explained, so it stays source-only (LobeHub's rule).
 */
export function htmlPreviewKind(lang: string, code: string): HtmlPreviewKind | null {
  const normalizedLang = lang.trim().toLowerCase();
  const source = code.replace(/^\uFEFF/, "").trimStart();
  if (SVG_HOST_LANGS.has(normalizedLang) && SVG_ROOT_RE.test(source)) return "svg";
  if (HTML_LANGS.has(normalizedLang) && FULL_HTML_RE.test(source)) return "html";
  if (REACT_LANGS.has(normalizedLang) && isRunnableReactComponent(source)) return "react";
  return null;
}

/**
 * A React fence is runnable when it is one self-contained module: it has a
 * default export and JSX, and imports nothing local (`./x`, `@/components/...`)
 * that only exists in the project it was written for.
 */
export function isRunnableReactComponent(code: string): boolean {
  return /\bexport\s+default\b/.test(code)
    && /<[A-Za-z>]/.test(code)
    && !/\bfrom\s*["'](?:\.|\/|@\/|~\/)/.test(code)
    && !/\brequire\s*\(/.test(code);
}

const COLOR_SIGNAL_RE = /(?:^|[\s;{"'])(?:background(?:-color|-image)?|color)\s*:|\bbgcolor\s*=|cdn\.tailwindcss\.com|<link\b[^>]*rel\s*=\s*["']?stylesheet/i;

/**
 * Whether a document leaves its colours to the browser. Recolouring is only
 * safe then: a page that sets `background: #fff` but no text colour, or a
 * dark text colour on the default canvas, would turn unreadable on a dark
 * canvas. SVG keeps a white canvas because its strokes default to black.
 */
export function htmlPreviewFollowsTheme(kind: HtmlPreviewKind, code: string): boolean {
  if (kind === "react") return false;
  // A page that takes its colours from the kit's variables follows the theme
  // by its own choice, whatever else it declares (SVG included).
  return usesThemeKit(code) || (kind === "html" && !COLOR_SIGNAL_RE.test(code));
}

/**
 * Whether a document runs code: scripts, inline event handlers, `javascript:`
 * URLs. Such a page can spin forever, and in the macOS app a sandboxed frame
 * shares the window's process, so a looping page from history would freeze
 * the app each time its conversation opened. Those previews only start on
 * their own right after the user watched them stream in.
 */
export function htmlPreviewHasActiveContent(code: string): boolean {
  return /<script\b|\son[a-z]+\s*=|javascript:/i.test(code);
}

/**
 * Wording the preview adds around an error. `{name}` placeholders are filled
 * inside the frame; the browser's own error text is passed through as is.
 */
export interface HtmlPreviewMessages {
  scriptErrorHidden: string;
  /** {resource}: tag name and URL of the script, stylesheet or image. */
  failedToLoad: string;
  /** {reason} */
  unhandledRejection: string;
  runtimeMissing: string;
  /** {error} */
  compileFailed: string;
  noDefaultExport: string;
  /** {packages}, {error} */
  packagesNeedNetwork: string;
}

export const HTML_PREVIEW_MESSAGES: HtmlPreviewMessages = {
  scriptErrorHidden: "Script error (the browser hid the details: it came from an inline event handler attribute or a script from another origin)",
  failedToLoad: "Failed to load {resource}",
  unhandledRejection: "Unhandled promise rejection: {reason}",
  runtimeMissing: "The React preview runtime is not loaded.",
  compileFailed: "Could not compile the component: {error}",
  noDefaultExport: "The component has no default export.",
  packagesNeedNetwork: "Could not load {packages} from esm.sh — these packages need the network ({error})",
};

export function previewMessages(options: HtmlPreviewOptions): HtmlPreviewMessages {
  return { ...HTML_PREVIEW_MESSAGES, ...options.messages };
}

/** The text of a `sendPrompt` request, or nothing for anything that is not a non-empty string. */
export function framePromptText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, HTML_PREVIEW_MAX_PROMPT_LENGTH).trim();
  return text || null;
}

export function clampHtmlPreviewHeight(height: number): number {
  if (!Number.isFinite(height)) return HTML_PREVIEW_DEFAULT_HEIGHT;
  return Math.min(HTML_PREVIEW_MAX_HEIGHT, Math.max(HTML_PREVIEW_MIN_HEIGHT, Math.ceil(height)));
}

// Runs first inside the frame:
// - Opaque-origin documents throw on any localStorage/sessionStorage access,
//   which breaks most generated apps, so an in-memory stand-in replaces them.
// - The size report lets an inline frame fit its content. It measures the
//   root element's box, not scrollHeight, which never drops below the frame's
//   own height and would only ever let the frame grow.
// - Uncaught errors, rejected promises and failed script/style/image loads
//   are reported so the panel can show them and offer a fix.
// - `sendPrompt(text)` asks the app to put text in the user's composer. It is
//   only honoured right after the user acted in the frame (a click or a key),
//   and the app applies its own limits on top: a page cannot be trusted to.
// - With ROUTE_LINKS, link clicks and window.open go to the parent.
/** `nonce` is for documents with a script-src policy of their own (the streaming shell). */
export function bootstrapScript(routeLinks: boolean, messages: HtmlPreviewMessages, nonce?: string): string {
  return `<script${nonce ? ` nonce="${nonce}"` : ""}>(function(){
var P=function(m){try{parent.postMessage(m,"*")}catch(_){}};
var M=${scriptJson(messages)};window.__piPreviewMessages=M;
var F=window.__piPreviewFormat=function(s,v){return String(s).replace(/\\{(\\w+)\\}/g,function(w,k){return k in v?String(v[k]):w})};
function mem(){var s=Object.create(null);return{getItem:function(k){k=String(k);return k in s?s[k]:null},setItem:function(k,v){s[String(k)]=String(v)},removeItem:function(k){delete s[String(k)]},clear:function(){s=Object.create(null)},key:function(i){var ks=Object.keys(s);return i<ks.length?ks[i]:null},get length(){return Object.keys(s).length}}}
["localStorage","sessionStorage"].forEach(function(n){try{window[n].getItem("")}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
var last=-1;function size(){var d=document.documentElement;if(!d)return;var h=Math.ceil(d.getBoundingClientRect().height);if(h!==last){last=h;P({type:${JSON.stringify(HTML_PREVIEW_SIZE_MESSAGE)},height:h})}}
document.addEventListener("DOMContentLoaded",function(){size();if(window.ResizeObserver){new ResizeObserver(size).observe(document.documentElement);if(document.body)new ResizeObserver(size).observe(document.body)}});
addEventListener("load",size);
document.addEventListener("DOMContentLoaded",function(){P({type:${JSON.stringify(HTML_PREVIEW_READY_MESSAGE)}})});
addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.type!==${JSON.stringify(HTML_PREVIEW_THEME_MESSAGE)})return;var ok=function(v){v=String(v);return /^[#a-z0-9(),.%\\s\\/-]+$/i.test(v)&&!/url\\s*\\(/i.test(v)},s=document.documentElement.style;
if(document.getElementById("pi-theme-canvas")&&ok(d.background)&&ok(d.text)){s.colorScheme=d.scheme==="dark"?"dark":"light";s.background=d.background;s.color=d.text}
if(document.getElementById(${JSON.stringify("pi-theme-kit")})&&d.vars&&typeof d.vars==="object")for(var k in d.vars)if(/^--color-(text|background|border|series)-[a-z0-9-]+$/.test(k)&&ok(d.vars[k]))s.setProperty(k,String(d.vars[k]))});
var sent=0,seen={};function err(m){m=String(m||"Error");if(/^Script error\\.?$/.test(m))m=M.scriptErrorHidden;m=m.slice(0,500);if(sent>=${HTML_PREVIEW_MAX_ERRORS}||seen[m])return;seen[m]=1;sent++;P({type:${JSON.stringify(HTML_PREVIEW_ERROR_MESSAGE)},message:m})}
window.__piPreviewError=err;
window.sendPrompt=function(t){if(navigator.userActivation&&!navigator.userActivation.isActive)return;t=String(t==null?"":t).trim().slice(0,${HTML_PREVIEW_MAX_PROMPT_LENGTH});if(t)P({type:${JSON.stringify(HTML_PREVIEW_PROMPT_MESSAGE)},text:t})};
addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&t.tagName){var u=t.src||t.href||"";err(F(M.failedToLoad,{resource:t.tagName.toLowerCase()+(u?" "+u:"")}));return}var m=e.message||(e.error&&e.error.message)||"Script error";err(m+(e.lineno?" (line "+e.lineno+(e.colno?":"+e.colno:"")+")":""))},true);
addEventListener("unhandledrejection",function(e){var r=e.reason;err(F(M.unhandledRejection,{reason:r&&r.message?r.message:String(r)}))});
${routeLinks ? `function ext(u){try{var x=new URL(u,location.href);return /^https?:$/.test(x.protocol)?x.href:null}catch(_){return null}}
document.addEventListener("click",function(e){if(e.defaultPrevented)return;var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#")return;var u=ext(h);if(!u)return;e.preventDefault();P({type:${JSON.stringify(HTML_PREVIEW_OPEN_MESSAGE)},url:u})});
window.open=function(u){var x=ext(u==null?"":String(u));if(x)P({type:${JSON.stringify(HTML_PREVIEW_OPEN_MESSAGE)},url:x});return null};` : `document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#"||/^javascript:/i.test(h))return;if(!a.target||a.target==="_self"){a.target="_blank";a.rel="noopener"}},true);`}
})();</script>`;
}

const SVG_DOCUMENT_STYLE =
  "<style>html,body{margin:0;background:#fff}body{display:flex;justify-content:center;padding:12px;box-sizing:border-box}svg{max-width:100%;height:auto}</style>";
// An SVG that takes its colours from the kit sits on the app's canvas instead of white.
const SVG_THEMED_DOCUMENT_STYLE =
  "<style>html,body{margin:0}body{display:flex;justify-content:center;padding:12px;box-sizing:border-box}svg{max-width:100%;height:auto}</style>";

const CSS_COLOR_RE = /^[#a-z0-9(),.%\s-]+$/i;

function themeStyle(theme: HtmlPreviewOptions["theme"]): string {
  if (!theme || !CSS_COLOR_RE.test(theme.background) || !CSS_COLOR_RE.test(theme.text)) return "";
  return `<style id="pi-theme-canvas">:root{color-scheme:${theme.scheme};background:${theme.background};color:${theme.text}}</style>`;
}

const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const CLASSIC_SCRIPT_TYPES = new Set(["", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "application/x-javascript"]);

/**
 * WebKit (the macOS app) hides the message of any uncaught error raised by
 * inline script text in a sandboxed, opaque-origin document — the page sees
 * only "Script error." — while errors from scripts loaded by URL keep their
 * details. So the page's own inline classic scripts are moved into `data:`
 * URL scripts: those still run in place, in order, blocking the parser, and
 * share the global scope exactly like inline ones. `async` / `defer` are
 * dropped because they would change that timing. Modules, `text/babel`,
 * JSON and other data blocks stay as they are.
 */
export function externalizeInlineScripts(html: string): string {
  return html.replace(INLINE_SCRIPT_RE, (whole, rawAttrs: string, body: string) => {
    if (/\bsrc\s*=/i.test(rawAttrs) || !body.trim()) return whole;
    const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(rawAttrs)?.[1]?.toLowerCase() ?? "";
    if (!CLASSIC_SCRIPT_TYPES.has(type)) return whole;
    const attrs = rawAttrs.replace(/\s(?:async|defer)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?(?=\s|$)/gi, "");
    return `<script${attrs} src="data:text/javascript;charset=utf-8,${encodeURIComponent(body)}"></script>`;
  });
}

/** Inserts the bootstrap as early as possible without pushing the page into quirks mode. */
function injectIntoHtml(source: string, snippet: string): string {
  for (const pattern of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype\s+html[^>]*>/i]) {
    const match = pattern.exec(source);
    if (match) {
      const end = match.index + match[0].length;
      return source.slice(0, end) + snippet + source.slice(end);
    }
  }
  return snippet + source;
}

export function buildHtmlPreviewDocument(kind: HtmlPreviewKind, code: string, options: HtmlPreviewOptions = {}): string {
  const bootstrap = bootstrapScript(Boolean(options.routeLinksToParent), previewMessages(options));
  if (kind === "react") return buildReactDocument(code, bootstrap, options);
  const kit = usesThemeKit(code) ? themeKitStyle(options.themeKit ?? defaultThemeKit(options.theme?.scheme ?? "light")) : "";
  if (kind === "svg") {
    if (kit) return `<!DOCTYPE html><html><head><meta charset="utf-8">${SVG_THEMED_DOCUMENT_STYLE}${themeStyle(options.theme)}${kit}${bootstrap}</head><body>${code}</body></html>`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${SVG_DOCUMENT_STYLE}${bootstrap}</head><body>${code}</body></html>`;
  }
  const head = (htmlPreviewFollowsTheme(kind, code) ? themeStyle(options.theme) : "") + kit + bootstrap;
  code = externalizeInlineScripts(code);
  // Artifacts may carry a fragment; give it a document so it renders in standards mode.
  if (!FULL_HTML_RE.test(code.replace(/^\uFEFF/, "").trimStart())) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body>${code}</body></html>`;
  }
  return injectIntoHtml(code, head);
}

/**
 * The text a download saves. A page that uses the theme kit gets the kit's
 * light values written into it: its variables exist only inside the app, and
 * a file opened elsewhere would otherwise lose its colours (an SVG would
 * turn black). Everything else is saved as written.
 */
export function htmlPreviewDownloadSource(kind: HtmlPreviewKind, code: string): string {
  if (kind === "react" || !usesThemeKit(code)) return code;
  const kit = defaultThemeKit("light");
  if (kind === "svg") return themeKitSvgSource(code, kit);
  const style = themeKitStyle(kit);
  return FULL_HTML_RE.test(code.replace(/^\uFEFF/, "").trimStart()) ? injectIntoHtml(code, style) : style + code;
}

export function htmlPreviewFileName(kind: HtmlPreviewKind): string {
  return kind === "svg" ? "image.svg" : kind === "react" ? "component.jsx" : "page.html";
}

// React previews: the component is compiled inside the frame with Sucrase and
// its imports resolve through an import map. React, ReactDOM, Sucrase and
// Tailwind ship with the app (public/preview-runtime/, built by
// scripts/build-preview-runtime.mjs), so a component that only uses React
// works offline. They are inlined into the document rather than loaded by URL:
// Chromium refuses any request from a sandboxed (opaque-origin) frame to
// localhost. The import map points `react` etc. at small data: modules that
// re-export the inlined globals, so the component and any package from esm.sh
// (requested with react and react-dom external) share one React. Packages
// from esm.sh need the network; a failed load reaches the error bar.
export const PREVIEW_RUNTIME_PATH = "/preview-runtime/";
const ESM_CDN = "https://esm.sh";
const BARE_SPECIFIER_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.-]+)*$/i;
const IMPORT_RE = /\b(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/** The bundled runtime as the app page loaded it (see lib/preview-runtime.ts). */
export interface PreviewRuntime {
  /** Classic script setting globalThis.__piPreviewRuntime. */
  react: string;
  /** Classic script setting globalThis.__piSucrase. */
  sucrase: string;
  /** Tailwind's browser build. */
  tailwind: string;
  /** Per specifier: the property of __piPreviewRuntime and its named exports. */
  modules: Record<string, { global: string; exports: string[] }>;
}

/** Bare package specifiers the component imports, other than React itself. */
export function reactImportSpecifiers(code: string): string[] {
  const specifiers = new Set<string>();
  for (const match of code.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2];
    if (!specifier || !BARE_SPECIFIER_RE.test(specifier)) continue;
    if (/^react(?:-dom)?(?:\/|$)/.test(specifier)) continue;
    specifiers.add(specifier);
  }
  return [...specifiers];
}

function facadeModule(global: string, names: readonly string[]): string {
  const safe = names.filter((name) => IDENTIFIER_RE.test(name) && name !== "default");
  const source = `const m=globalThis.__piPreviewRuntime[${JSON.stringify(global)}];const x=m.default??m;export default x;`
    + (safe.length ? `export const {${safe.join(",")}}=x;` : "");
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

export function reactImportMap(code: string, runtime: Pick<PreviewRuntime, "modules">): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const [specifier, { global, exports }] of Object.entries(runtime.modules)) {
    if (!IDENTIFIER_RE.test(global)) continue;
    imports[specifier] = facadeModule(global, exports);
  }
  if (imports["react/jsx-runtime"]) imports["react/jsx-dev-runtime"] = imports["react/jsx-runtime"];
  for (const specifier of reactImportSpecifiers(code)) {
    imports[specifier] = `${ESM_CDN}/${specifier}?external=react,react-dom`;
  }
  return imports;
}

/** Library source inlined into a <script>: `</script` can only occur in strings, regexes and comments, where `<\/` means the same. */
function inlineScript(source: string): string {
  return `<script>${source.replace(/<\/(script)/gi, "<\\/$1")}</script>`;
}

/** JSON that is safe inside a <script> element: no `</script>` or `<!--` can form. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function buildReactDocument(code: string, bootstrap: string, options: HtmlPreviewOptions): string {
  const loadingLabel = options.loadingLabel ?? "Loading component…";
  const { runtime } = options;
  if (!runtime) {
    // Callers wait for the runtime; this only shows if one does not.
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${bootstrap}</head><body><script>window.__piPreviewError(window.__piPreviewMessages.runtimeMissing)</script></body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${bootstrap}${inlineScript(runtime.tailwind)}${inlineScript(runtime.react)}${inlineScript(runtime.sucrase)}<script type="importmap">${scriptJson({ imports: reactImportMap(code, runtime) })}</script></head><body><div id="root"><div style="display:flex;align-items:center;justify-content:center;min-height:96px;font:13px system-ui,sans-serif;color:#8a8a8e">${escapeHtml(loadingLabel)}</div></div><script type="module">
const report=(m)=>window.__piPreviewError?window.__piPreviewError(m):console.error(m);
const M=window.__piPreviewMessages,F=window.__piPreviewFormat;
const source=${scriptJson(code)};
const packages=${scriptJson(reactImportSpecifiers(code))};
try{
let compiled;
try{compiled=globalThis.__piSucrase.transform(source,{transforms:["jsx","typescript"],jsxRuntime:"automatic",production:true}).code}catch(e){throw new Error(F(M.compileFailed,{error:e&&e.message||e}))}
let mod;
try{mod=await import(URL.createObjectURL(new Blob([compiled],{type:"text/javascript"})))}catch(e){if(!/blob|module|fetch|import/i.test(String(e&&e.message)))throw e;mod=await import("data:text/javascript;charset=utf-8,"+encodeURIComponent(compiled))}
const Component=mod.default??mod.App??Object.values(mod).find((v)=>typeof v==="function");
if(typeof Component!=="function")throw new Error(M.noDefaultExport);
const React=await import("react");
const {createRoot}=await import("react-dom/client");
createRoot(document.getElementById("root")).render(React.createElement(Component));
}catch(e){const m=e&&e.message?e.message:String(e);report(packages.length&&/module script failed|dynamically imported module|error loading|Failed to fetch|NetworkError/i.test(m)?F(M.packagesNeedNetwork,{packages:packages.join(", "),error:m}):m)}
</script></body></html>`;
}
