"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { isTauriDesktop, openExternal } from "@/lib/desktop-native";
import {
  HTML_PREVIEW_ERROR_MESSAGE,
  HTML_PREVIEW_OPEN_MESSAGE,
  HTML_PREVIEW_PROMPT_MESSAGE,
  HTML_PREVIEW_READY_MESSAGE,
  HTML_PREVIEW_SIZE_MESSAGE,
  HTML_PREVIEW_THEME_MESSAGE,
  framePromptText,
  type HtmlPreviewMessages,
  type HtmlPreviewOptions,
} from "@/lib/html-preview";
import { buildThemeKit, isPreviewColor, safeThemeKitVars, type PreviewThemeKit } from "@/lib/preview-theme-kit";

type ThemeColors = NonNullable<HtmlPreviewOptions["theme"]>;

export function readThemeColors(dark: boolean): ThemeColors | undefined {
  if (typeof document === "undefined" || !document.body) return undefined;
  const style = getComputedStyle(document.body);
  return { scheme: dark ? "dark" : "light", background: style.backgroundColor, text: style.color };
}

/**
 * The theme kit's values from the app's current tokens (see
 * lib/preview-theme-kit.ts). Read from the root, where the theme sets them.
 */
export function readThemeKit(dark: boolean, theme: ThemeColors | undefined = readThemeColors(dark)): PreviewThemeKit | undefined {
  if (typeof document === "undefined" || !theme) return undefined;
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim() || undefined;
  return buildThemeKit(theme.scheme, {
    background: theme.background,
    text: theme.text,
    textMuted: token("--text-muted"),
    border: token("--border"),
    info: token("--info"),
    success: token("--success"),
    warning: token("--warning"),
    danger: token("--danger"),
  });
}

interface ThemeSnapshot {
  key: string;
  theme: ThemeColors | undefined;
  themeKit: PreviewThemeKit | undefined;
}

function readSnapshot(key: string, dark: boolean): ThemeSnapshot {
  const theme = readThemeColors(dark);
  return { key, theme, themeKit: readThemeKit(dark, theme) };
}

/**
 * Build options for preview documents: the app's colours and theme kit and,
 * in the desktop app, link routing to the system browser.
 *
 * The theme is read when `documentKey` changes (a new version, a switch from
 * source to preview), not when the app's theme does: a theme change reaches a
 * frame that is already showing through `useHtmlPreviewFrameMessages`, so it
 * does not reload and lose the state of a page the user is playing with.
 */
export function useHtmlPreviewOptions(documentKey = ""): HtmlPreviewOptions {
  const { isDark } = useTheme();
  const [snapshot, setSnapshot] = useState<ThemeSnapshot>(() => readSnapshot(documentKey, isDark));
  if (snapshot.key !== documentKey) setSnapshot(readSnapshot(documentKey, isDark));
  // Server-rendered: there was no document to read from yet.
  useEffect(() => {
    setSnapshot((current) => (current.theme ? current : readSnapshot(current.key, isDark)));
  }, [isDark]);
  const { theme, themeKit } = snapshot;
  const routeLinksToParent = typeof window !== "undefined" && isTauriDesktop();
  const { t } = useI18n();
  const loadingLabel = t("preview.loadingComponent");
  // The frame fills these placeholders itself, so each is passed through as
  // its own literal token.
  const token = (name: string) => `{${name}}`;
  const scriptErrorHidden = t("preview.msg.scriptErrorHidden");
  const failedToLoad = t("preview.msg.failedToLoad", { resource: token("resource") });
  const unhandledRejection = t("preview.msg.unhandledRejection", { reason: token("reason") });
  const runtimeMissing = t("preview.msg.runtimeMissing");
  const compileFailed = t("preview.msg.compileFailed", { error: token("error") });
  const noDefaultExport = t("preview.msg.noDefaultExport");
  const packagesNeedNetwork = t("preview.msg.packagesNeedNetwork", { packages: token("packages"), error: token("error") });
  const messages = useMemo<HtmlPreviewMessages>(
    () => ({ scriptErrorHidden, failedToLoad, unhandledRejection, runtimeMissing, compileFailed, noDefaultExport, packagesNeedNetwork }),
    [scriptErrorHidden, failedToLoad, unhandledRejection, runtimeMissing, compileFailed, noDefaultExport, packagesNeedNetwork],
  );
  return useMemo(
    () => ({ theme, themeKit, routeLinksToParent, loadingLabel, messages }),
    [theme, themeKit, routeLinksToParent, loadingLabel, messages],
  );
}

interface FrameMessageHandlers {
  onSize?: (height: number) => void;
  onError?: (message: string) => void;
  /** The frame's document is ready to be sent to. */
  onReady?: () => void;
  /** Text a page asked to have put in the composer (`sendPrompt`). Without a handler such requests are dropped. */
  onPrompt?: (text: string) => void;
}

/** Tells a frame the app's current theme; the frame applies it only where the page follows the theme. */
function postTheme(frame: HTMLIFrameElement | null, dark: boolean): void {
  const target = frame?.contentWindow;
  if (!target) return;
  const theme = readThemeColors(dark);
  const kit = readThemeKit(dark, theme);
  if (!theme || !kit || !isPreviewColor(theme.background) || !isPreviewColor(theme.text)) return;
  target.postMessage({
    type: HTML_PREVIEW_THEME_MESSAGE,
    scheme: theme.scheme,
    background: theme.background,
    text: theme.text,
    vars: safeThemeKitVars(kit.vars),
  }, "*");
}

/**
 * Listens to one preview frame. Messages are matched by `event.source`, so a
 * page cannot speak for another frame; a link is opened only when it is an
 * http(s) URL, whatever the page sent. It also keeps the frame on the app's
 * theme: the current one when the frame says it is ready, and again whenever
 * the app's theme changes.
 */
export function useHtmlPreviewFrameMessages(
  frameRef: RefObject<HTMLIFrameElement | null>,
  handlers: FrameMessageHandlers,
  active = true,
): void {
  const { isDark } = useTheme();
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const lastOpenRef = useRef(0);
  const lastPromptRef = useRef(0);

  // The theme changed under a frame that is showing: it follows without reloading.
  useEffect(() => {
    if (active) postTheme(frameRef.current, isDark);
  }, [frameRef, active, isDark]);

  useEffect(() => {
    if (!active) return;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown; message?: unknown; url?: unknown; text?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === HTML_PREVIEW_READY_MESSAGE) {
        postTheme(frame, isDarkRef.current);
        handlersRef.current.onReady?.();
      } else if (data.type === HTML_PREVIEW_SIZE_MESSAGE && typeof data.height === "number") {
        handlersRef.current.onSize?.(data.height);
      } else if (data.type === HTML_PREVIEW_ERROR_MESSAGE && typeof data.message === "string") {
        handlersRef.current.onError?.(data.message.slice(0, 500));
      } else if (data.type === HTML_PREVIEW_PROMPT_MESSAGE) {
        const text = framePromptText(data.text);
        const onPrompt = handlersRef.current.onPrompt;
        if (text === null || !onPrompt) return;
        // Same rule as links: only after a click the user made in this frame
        // (it then holds focus), at most once a second. The text only lands in
        // the composer; the user decides whether to send it.
        if (document.activeElement !== frame) return;
        const now = Date.now();
        if (now - lastPromptRef.current < 1000) return;
        lastPromptRef.current = now;
        onPrompt(text);
      } else if (data.type === HTML_PREVIEW_OPEN_MESSAGE && typeof data.url === "string") {
        let url: URL;
        try {
          url = new URL(data.url);
        } catch {
          return;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        // Only for a click the user made in this frame (it then holds focus),
        // at most once a second: a page must not open browser windows by itself.
        if (document.activeElement !== frame) return;
        const now = Date.now();
        if (now - lastOpenRef.current < 1000) return;
        lastOpenRef.current = now;
        void openExternal(url.href).catch((error) => console.error("Failed to open link:", error));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef, active]);
}

/** Errors a frame reported, cleared whenever the document it shows changes. */
export function useHtmlPreviewErrors(documentKey: string): {
  errors: string[];
  addError: (message: string) => void;
  dismiss: () => void;
} {
  const [state, setState] = useState<{ key: string; errors: string[]; dismissed: boolean }>({ key: documentKey, errors: [], dismissed: false });
  const current = state.key === documentKey ? state : { key: documentKey, errors: [], dismissed: false };
  return {
    errors: current.dismissed ? [] : current.errors,
    addError: (message) => setState((previous) => {
      const base = previous.key === documentKey ? previous : { key: documentKey, errors: [], dismissed: false };
      return base.errors.includes(message) ? base : { ...base, errors: [...base.errors, message] };
    }),
    dismiss: () => setState({ key: documentKey, errors: current.errors, dismissed: true }),
  };
}
