import type { Locale, TranslationParams } from "./types";

type MessagesByLocale = Record<string, Record<string, string>>;

/**
 * 替换翻译消息中的简单插值占位符。
 * @param message 原始翻译消息
 * @param params 插值参数
 * @returns 完成参数替换后的消息
 */
export function interpolateMessage(message: string, params: TranslationParams = {}): string {
  return message.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

/**
 * 从当前语言和英语语言包中解析消息。
 * @param locale 当前语言
 * @param key 翻译 key
 * @param messages 各语言的消息字典
 * @param params 可选的插值参数
 * @returns 翻译结果，缺失时返回 key
 */
export function translateMessage(
  locale: Locale,
  key: string,
  messages: MessagesByLocale,
  params: TranslationParams = {},
): string {
  const message = messages[locale]?.[key] ?? messages.en?.[key];
  if (message === undefined) {
    if (process.env.NODE_ENV !== "production") console.warn(`[i18n] Missing translation: ${key}`);
    return key;
  }
  return interpolateMessage(message, params);
}

/**
 * 按当前语言格式化相对时间。
 * @param date 要格式化的时间
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 * @returns locale-aware 的相对时间文本
 */
export function formatRelativeTime(date: Date | string, locale: Locale, now = new Date()): string {
  const target = date instanceof Date ? date : new Date(date);
  const diffMs = target.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);
  const [unit, divisor] = absMs < 60_000
    ? ["second", 1_000]
    : absMs < 3_600_000
      ? ["minute", 60_000]
      : absMs < 86_400_000
        ? ["hour", 3_600_000]
        : ["day", 86_400_000];
  const value = Math.round(diffMs / divisor);
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit as Intl.RelativeTimeFormatUnit);
}

/**
 * 今天只显示时刻；更早的时间和会话列表一样用相对时间。
 * @param timestamp 毫秒时间戳
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 * @returns 今天的时刻，或更早时间的相对时间文本
 */
export function formatUpdatedTime(timestamp: number, locale: Locale, now = new Date()): string {
  const target = new Date(timestamp);
  if (Number.isNaN(target.getTime())) return "";
  const isToday = target.getFullYear() === now.getFullYear()
    && target.getMonth() === now.getMonth()
    && target.getDate() === now.getDate();
  if (isToday) return target.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return formatRelativeTime(target, locale, now);
}

const COMPACT_UNITS: ReadonlyArray<readonly [Intl.NumberFormatOptions["unit"], number]> = [
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["week", 7 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["year", 365 * 86_400_000],
];

/**
 * 侧边栏窄列用的紧凑相对时间（"3m"、"2h"、"3天"），一分钟内显示"现在"。
 * @param date 要格式化的时间
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 * @returns 不带"前"的短文本；无效时间返回空串
 */
export function formatCompactRelativeTime(date: Date | string, locale: Locale, now = new Date()): string {
  const target = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(target.getTime())) return "";
  const ageMs = Math.max(0, now.getTime() - target.getTime());
  if (ageMs < 60_000) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" }).format(0, "second");
  }
  let index = 0;
  while (index + 1 < COMPACT_UNITS.length && ageMs >= COMPACT_UNITS[index + 1][1]) index++;
  const [unit, size] = COMPACT_UNITS[index];
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(Math.floor(ageMs / size));
}

const SHORT_TIME_UNITS: Record<Locale, { now: string; minute: string; hour: string; day: string; week: string; month: string; year: string }> = {
  en: { now: "now", minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" },
  "zh-CN": { now: "刚刚", minute: "分", hour: "小时", day: "天", week: "周", month: "个月", year: "年" },
  "zh-TW": { now: "剛剛", minute: "分", hour: "小時", day: "天", week: "週", month: "個月", year: "年" },
};

/**
 * 侧边栏右侧一列使用的紧凑相对时间（"5m"、"3小时"）。
 * @param date 要格式化的时间
 * @param locale 当前语言（未知语言按英语）
 * @param now 用于测试或特殊场景的当前时间
 * @returns 紧凑的相对时间文本；未来时间按“刚刚”，无效时间为空字符串
 */
export function formatShortRelativeTime(date: Date | string, locale: Locale, now = new Date()): string {
  const target = date instanceof Date ? date : new Date(date);
  const elapsedMs = now.getTime() - target.getTime();
  if (Number.isNaN(elapsedMs)) return "";
  const units = Object.hasOwn(SHORT_TIME_UNITS, locale) ? SHORT_TIME_UNITS[locale] : SHORT_TIME_UNITS.en;
  const elapsed = Math.max(0, elapsedMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return units.now;
  if (minutes < 60) return `${minutes}${units.minute}`;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 24) return `${hours}${units.hour}`;
  const days = Math.floor(elapsed / 86_400_000);
  if (days < 7) return `${days}${units.day}`;
  if (days < 30) return `${Math.floor(days / 7)}${units.week}`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30))}${units.month}`;
  return `${Math.floor(days / 365)}${units.year}`;
}
