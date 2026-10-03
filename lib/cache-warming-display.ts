import type { CacheWarmingInfo } from "./types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const MODE_KEYS: Record<CacheWarmingInfo["mode"], string> = {
  off: "session.cacheWarmingModeOff",
  streaming: "session.cacheWarmingModeStreaming",
  idle: "session.cacheWarmingModeIdle",
};

/** Same shape as pi's `formatCacheWarmingDecisionTime`: 1h2m3s, dropping empty units. */
export function formatWarmingDelay(ms: number): string {
  let remaining = Math.ceil(ms / 1000);
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join("");
}

const dollars = (value: number) => `$${value.toFixed(3)}`;

/**
 * The Cache Warming block of pi's `/session` (interactive-mode `handleSessionCommand` +
 * `formatCacheWarmingStatus`), as label/value rows in the UI language. pi's own `reason`
 * text is shown as it comes, since it names pi's internal condition.
 */
export function cacheWarmingRows(info: CacheWarmingInfo, t: Translate, now = Date.now()): Array<[string, string]> {
  const rows: Array<[string, string]> = [[t("session.cacheWarmingMode"), t(MODE_KEYS[info.mode] ?? info.mode)]];
  const status = info.status;
  const decision = status?.decision;

  let statusText: string;
  if (!status) {
    statusText = t("session.cacheWarmingUnavailable");
  } else if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.extensionOverride)) {
    statusText = t("session.cacheWarmingInactive", { reason: status.reason ?? "—" });
  } else if (status.state === "inactive") {
    statusText = t("session.cacheWarmingStopped");
  } else if (status.state === "refreshing") {
    statusText = t("session.cacheWarmingRefreshing");
  } else {
    statusText = status.nextWarmAt !== undefined && status.nextWarmAt > now
      ? t("session.cacheWarmingNext", { time: formatWarmingDelay(status.nextWarmAt - now) })
      : t("session.cacheWarmingNow");
  }
  rows.push([t("session.cacheWarmingStatus"), statusText]);

  if (decision?.economicsAvailable) {
    const action = t(decision.action === "warm" ? "session.cacheWarmingWarm" : "session.cacheWarmingStop");
    rows.push([
      t("session.cacheWarmingSavings"),
      `${dollars(decision.expectedSavings)} → ${action}${status?.extensionOverride ? ` (${t("session.cacheWarmingOverride")})` : ""}`,
    ]);
    rows.push([t("session.cacheMissPenalty"), dollars(decision.missCost)]);
    rows.push([t("session.cacheRefreshCost"), dollars(decision.warmCost)]);
  }
  return rows;
}
