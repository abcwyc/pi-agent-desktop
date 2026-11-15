// Progressive preview: an HTML or SVG page drawn while the model is still
// writing it.
//
// The page cannot simply be shown in a normal preview frame as it grows:
// every chunk would reload the document and re-run its scripts, and a looping
// page would freeze the app. So streaming uses a different frame from the
// final one:
//
// - Streaming: one long-lived frame whose document is the shell below. The
//   text so far is sent to it by message; it parses it with DOMParser (an
//   inert document: nothing runs, nothing loads), strips everything that
//   could act, and patches the visible tree in place. Elements that are
//   already there are left alone, new ones fade in. No script of the page
//   runs, and a strict CSP (a script nonce, no network) backs that up.
// - Final: the normal preview frame, a fresh document with the page's scripts
//   running as written, exactly as before. Pages that wait for
//   DOMContentLoaded or use document.write keep working, which patching a
//   live document could not promise.
//
// The shell is generic: it knows nothing about the page until the first
// message, so it is built once per frame.

import {
  HTML_PREVIEW_THEME_MESSAGE,
  bootstrapScript,
  previewMessages,
  type HtmlPreviewKind,
  type HtmlPreviewOptions,
} from "./html-preview.ts";
import { defaultThemeKit, themeKitStyle } from "./preview-theme-kit.ts";

/** Parent → shell: the page text so far. */
export const HTML_PREVIEW_STREAM_MESSAGE = "pi-html-preview:stream";
/** Streamed updates are drawn at most this often. */
export const HTML_PREVIEW_STREAM_INTERVAL_MS = 150;
/** Below this there is no tag worth drawing yet. */
export const HTML_PREVIEW_STREAM_MIN_CHARS = 20;

/**
 * What a streaming frame cannot show faithfully: a page that styles itself
 * with a stylesheet link or the Tailwind CDN has no styles until the real
 * document loads, and would pop from bare to styled. Those keep streaming as
 * source.
 */
const NEEDS_EXTERNAL_STYLE_RE = /cdn\.tailwindcss\.com|<link\b[^>]*rel\s*=\s*["']?stylesheet|@import\b/i;

export function canStreamPreview(kind: HtmlPreviewKind, code: string): boolean {
  if (kind !== "html" && kind !== "svg") return false;
  if (code.length < HTML_PREVIEW_STREAM_MIN_CHARS) return false;
  return !NEEDS_EXTERNAL_STYLE_RE.test(code);
}

/** A random token for the shell's script policy. `getRandomValues` also exists where `randomUUID` does not (plain http). */
function newNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapeAttribute(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const STREAM_STYLE = `
html,body{margin:0}
html.pi-themed{color:var(--color-text-primary)}
html.pi-svg #root{display:flex;justify-content:center;padding:12px}
html.pi-svg #root svg{max-width:100%;height:auto}
#root:empty{display:flex;align-items:center;justify-content:center;height:100vh;color:var(--color-text-secondary,#8a8a8e);font:13px system-ui,sans-serif}
#root:empty::before{content:attr(data-label)}
`;

// Runs in the shell. `render` is the whole job: parse, strip, patch.
const STREAM_RUNTIME = `(function(){
var TYPE=%TYPE%;
var THEME=%THEME%;
var root=document.getElementById("root");
var html=document.documentElement;
// A page that follows the theme must say so to the browser: an embedded document whose colour scheme
// differs from its parent's is painted on an opaque white canvas. A page that does not follow it stays light.
var scheme=html.getAttribute("data-scheme")==="dark"?"dark":"light";
function paint(){html.style.colorScheme=html.classList.contains("pi-themed")?scheme:""}
var REMOVE={script:1,noscript:1,iframe:1,frame:1,frameset:1,object:1,embed:1,applet:1,link:1,base:1,meta:1,template:1,portal:1,title:1};
var URL_ATTRS={href:1,src:1,action:1,formaction:1,"xlink:href":1,data:1,poster:1,background:1,srcset:1};
var reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
function cleanAttrs(el){
  var attrs=Array.prototype.slice.call(el.attributes);
  for(var i=0;i<attrs.length;i++){
    var name=attrs[i].name.toLowerCase(),value=attrs[i].value;
    if(name.indexOf("on")===0||name==="srcdoc"||name==="autofocus"){el.removeAttribute(attrs[i].name);continue}
    if(URL_ATTRS[name]){
      var flat=value.replace(/[\\u0000-\\u0020]+/g,"");
      if(/^(javascript|vbscript):/i.test(flat)||/^data:text\\/html/i.test(flat))el.removeAttribute(attrs[i].name)
    }
  }
}
function clean(scope){
  var all=Array.prototype.slice.call(scope.querySelectorAll("*"));
  for(var i=0;i<all.length;i++){
    var el=all[i];
    if(REMOVE[el.localName]){el.remove();continue}
    cleanAttrs(el)
  }
}
function sameKind(a,b){return a.nodeType===b.nodeType&&(a.nodeType!==1||(a.localName===b.localName&&a.namespaceURI===b.namespaceURI))}
function syncAttrs(from,to){
  var old=Array.prototype.slice.call(from.attributes);
  for(var i=0;i<old.length;i++)if(!to.hasAttributeNS(old[i].namespaceURI,old[i].localName))from.removeAttributeNS(old[i].namespaceURI,old[i].localName);
  for(var j=0;j<to.attributes.length;j++){
    var a=to.attributes[j],cur=from.getAttributeNodeNS(a.namespaceURI,a.localName);
    if(!cur||cur.value!==a.value){if(a.namespaceURI)from.setAttributeNS(a.namespaceURI,a.name,a.value);else from.setAttribute(a.name,a.value)}
  }
}
function fade(node){
  if(reduce||node.nodeType!==1||node.localName==="style"||!node.animate)return;
  try{node.animate([{opacity:0,transform:"translateY(4px)"},{opacity:1,transform:"none"}],{duration:300,easing:"ease"})}catch(_){}
}
// Positional patch: a streamed page only grows at its end, so the tree of the
// text so far is the previous tree plus a tail, and what is already drawn is
// left alone (no flicker, no restarted animation).
function patch(live,next){
  var l=live.firstChild,n=next.firstChild;
  while(n){
    var after=n.nextSibling;
    if(l&&sameKind(l,n)){
      if(n.nodeType===1){syncAttrs(l,n);patch(l,n)}
      else if(l.nodeValue!==n.nodeValue)l.nodeValue=n.nodeValue;
      l=l.nextSibling
    }else{
      if(l)live.insertBefore(n,l);else live.appendChild(n);
      fade(n)
    }
    n=after
  }
  while(l){var gone=l.nextSibling;live.removeChild(l);l=gone}
}
function render(html){
  var doc=new DOMParser().parseFromString(html,"text/html");
  clean(doc);
  cleanAttrs(doc.body);
  syncAttrs(document.body,doc.body);
  var box=doc.createElement("div");
  var styles=doc.head?doc.head.querySelectorAll("style"):[];
  for(var i=0;i<styles.length;i++)box.appendChild(styles[i]);
  while(doc.body.firstChild)box.appendChild(doc.body.firstChild);
  patch(root,box)
}
// Nothing in a streamed page navigates the frame or submits.
document.addEventListener("click",function(e){if(e.target&&e.target.closest&&e.target.closest("a"))e.preventDefault()},true);
document.addEventListener("submit",function(e){e.preventDefault()},true);
addEventListener("message",function(e){
  var d=e.data;
  if(e.source!==parent||!d||d.type!==TYPE||typeof d.html!=="string")return;
  html.classList.toggle("pi-themed",!!d.themed);
  paint();
  render(d.html)
});
addEventListener("message",function(e){
  var d=e.data;
  if(e.source!==parent||!d||d.type!==THEME)return;
  scheme=d.scheme==="dark"?"dark":"light";
  paint()
});
})();`;

/**
 * The document of a streaming frame. Its script policy lets only its own
 * scripts run (the nonce), allows no network and no frames, so a page's
 * event handlers, scripts and remote loads are blocked even if the stripping
 * in `render` missed something.
 */
export function buildStreamShell(kind: HtmlPreviewKind, options: HtmlPreviewOptions = {}, label = ""): string {
  const nonce = newNonce();
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  const kit = themeKitStyle(options.themeKit ?? defaultThemeKit(options.theme?.scheme ?? "light"), { colorScheme: false });
  const runtime = STREAM_RUNTIME
    .replace("%TYPE%", JSON.stringify(HTML_PREVIEW_STREAM_MESSAGE))
    .replace("%THEME%", JSON.stringify(HTML_PREVIEW_THEME_MESSAGE));
  const scheme = (options.themeKit?.scheme ?? options.theme?.scheme) === "dark" ? "dark" : "light";
  const bootstrap = bootstrapScript(Boolean(options.routeLinksToParent), previewMessages(options), nonce);
  return `<!DOCTYPE html><html data-scheme="${scheme}"${kind === "svg" ? ' class="pi-svg"' : ""}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><style>${STREAM_STYLE}</style>${kit}${bootstrap}</head><body><div id="root" data-label="${escapeAttribute(label)}"></div><script nonce="${nonce}">${runtime}</script></body></html>`;
}
