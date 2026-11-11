import type { AppReleaseHighlights } from "@/lib/app-update-types";

/** Chinese summaries stay within 20 characters; English gets a comparable width. */
export const RELEASE_SUMMARY_MAX_ZH = 20;
export const RELEASE_SUMMARY_MAX_EN = 48;

/**
 * One short line naming a release's headline items, for the Version card:
 * as many titles as fit, then "等" / ", …" when some were left out. Chinese
 * locales read the Chinese notes (English when a release has none), English
 * reads the English ones (Chinese as the fallback).
 */
export function summarizeReleaseHighlights(
  highlights: AppReleaseHighlights | undefined,
  locale: string,
): string | null {
  if (!highlights) return null;
  const chinese = locale.toLowerCase().startsWith("zh");
  const preferred = chinese ? highlights.zh : highlights.en;
  const titles = preferred.length > 0 ? preferred : (chinese ? highlights.en : highlights.zh);
  if (titles.length === 0) return null;

  const usesChinese = titles === highlights.zh;
  const max = usesChinese ? RELEASE_SUMMARY_MAX_ZH : RELEASE_SUMMARY_MAX_EN;
  const separator = usesChinese ? "、" : ", ";
  const more = usesChinese ? "等" : ", …";

  const first = titles[0];
  if (first.length > max) return `${first.slice(0, max - 1)}…`;

  let line = first;
  for (let index = 1; index < titles.length; index++) {
    const next = `${line}${separator}${titles[index]}`;
    const remaining = index < titles.length - 1;
    if (next.length + (remaining ? more.length : 0) > max) return `${line}${more}`;
    line = next;
  }
  return line;
}
