"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";
import { getLocalePlugin, getSupportedLocales, resolveBrowserLocale } from "@/lib/i18n/registry";
import { translateMessage } from "@/lib/i18n/format";
import type { Locale, LocalePlugin, TranslationParams } from "@/lib/i18n/types";

// النسخة العربية: اللغة الافتراضية هي العربية، مع إمكانية التبديل للإنجليزية.
const defaultLocale: Locale = "ar";

/** الاتجاه المطابق لكل لغة: العربية من اليمين إلى اليسار والباقي من اليسار إلى اليمين. */
function directionOf(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TranslationParams) => string;
  supportedLocales: LocalePlugin[];
}

const I18nContext = createContext<I18nContextValue | null>(null);

function getMessages(): Record<string, Record<string, string>> {
  return Object.fromEntries(getSupportedLocales().flatMap((id) => {
    const plugin = getLocalePlugin(id);
    return plugin ? [[id, plugin.messages]] : [];
  }));
}

function readInitialLocale(): Locale {
  const stored = getPref(APP_PREF_KEYS.locale);
  if (stored === "en" || stored === "zh-CN" || stored === "ar") return stored;
  // هذه النسخة معرّبة: اللغة الافتراضية هي العربية، وتُحترم لغة المتصفح
  // في حال عدم وجود تفضيل محفوظ.
  if (typeof navigator !== "undefined") {
    const matched = resolveBrowserLocale(navigator.languages ?? [navigator.language]);
    if (matched === "ar") return "ar";
  }
  return defaultLocale;
}

/**
 * 提供 Pi Web 的界面语言状态和翻译能力。
 * @param props React 子节点
 * @returns 包含语言上下文的 React 节点
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);
  const [hydrated, setHydrated] = useState(false);
  const supportedLocales = useMemo(
    () => getSupportedLocales().map((id) => getLocalePlugin(id)).filter((plugin): plugin is LocalePlugin => Boolean(plugin)),
    [],
  );
  const messages = useMemo(() => getMessages(), []);

  useEffect(() => {
    const next = readInitialLocale();
    setLocaleState(next);
    document.documentElement.lang = next;
    document.documentElement.dir = directionOf(next);
    setHydrated(true);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    if (!getLocalePlugin(next)) return;
    setLocaleState(next);
    document.documentElement.lang = next;
    document.documentElement.dir = directionOf(next);
    setPref(APP_PREF_KEYS.locale, next);
  }, []);

  const t = useCallback((key: string, params?: TranslationParams) => translateMessage(locale, key, messages, params), [locale, messages]);
  const value = useMemo(() => ({ locale: hydrated ? locale : defaultLocale, setLocale, t, supportedLocales }), [hydrated, locale, setLocale, t, supportedLocales]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * 获取当前组件树中的国际化能力。
 * @returns 当前 locale、翻译函数、语言切换函数和支持的语言列表
 * @throws 当组件不在 I18nProvider 内时抛出异常
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
