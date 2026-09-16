export function selectableThinkingLevels<T extends string>(
  levels: readonly T[],
  supported: string[] | null | undefined,
  mapping: Record<string, string | null> | null | undefined,
): T[] {
  return levels.filter((level) => {
    if (mapping) return mapping[level] != null && (!supported || supported.includes(level));
    return level === "auto" || !supported || supported.includes(level);
  });
}
