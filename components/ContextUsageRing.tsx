import { useI18n } from "@/hooks/useI18n";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";

const RING_SIZE = 14;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** High-risk red threshold (fixed, Claude-convention). Single accent below it. */
const CTX_DANGER_PCT = 90;

function fmtWindow(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

interface ContextUsageRingProps {
  contextUsage?: ContextUsage | null;
  sessionStats?: SessionStatsInfo | null;
  /** Open the existing top-bar session-stats panel (AppShell openSessionStatsPanel). */
  onOpenStats?: () => void;
}

/**
 * Text-free usage ring next to the model selector (C1). The arc shows live
 * context-window fullness in a single accent color; it turns red when usage
 * reaches the high-risk threshold (≥90%). Hover shows the session token and
 * context summary; click opens the top-bar session-stats panel.
 *
 * When there is no context usage yet (no session, or nothing has run), the ring
 * renders dimmed and inert, and no title is set — no dead "Context usage"
 * tooltip. Data only appears once the agent reports a context window.
 */
export function ContextUsageRing({ contextUsage, sessionStats, onOpenStats }: ContextUsageRingProps) {
  const { t } = useI18n();

  const hasUsage = contextUsage != null;
  const percent = contextUsage?.percent ?? null;
  const windowSize = contextUsage?.contextWindow ?? 0;
  // A context window object always carries the denominator; percent may be
  // unknown (null) right after a compaction until the next LLM response.
  const showTooltip = hasUsage && (percent !== null || windowSize > 0);
  const pct = percent !== null ? Math.max(0, Math.min(100, percent)) : 0;
  const color = percent === null
    ? "var(--text-dim)"
    : pct >= CTX_DANGER_PCT
      ? "var(--danger)"
      : "var(--accent)";
  const filled = RING_CIRCUMFERENCE * (pct / 100);

  const tooltipParts: string[] = [];
  if (showTooltip) {
    tooltipParts.push(percent !== null ? `${percent.toFixed(1)}% ctx` : `— / ${fmtWindow(windowSize)}`);
    if (sessionStats && sessionStats.tokens.total > 0) {
      tooltipParts.push(`${fmtWindow(sessionStats.tokens.total)} tok`);
    } else if (percent !== null && windowSize > 0) {
      tooltipParts[0] += ` / ${fmtWindow(windowSize)}`;
    }
    if (sessionStats && sessionStats.cost > 0) {
      tooltipParts.push(`$${sessionStats.cost.toFixed(3)}`);
    }
  }
  const title = tooltipParts.length > 0 ? tooltipParts.join(" · ") : t("chat.ctxUsage");

  return (
    <button
      type="button"
      aria-label={title}
      title={showTooltip ? title : undefined}
      aria-haspopup="dialog"
      aria-disabled={!hasUsage}
      onClick={() => {
        if (hasUsage) onOpenStats?.();
      }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 28, height: 28, padding: 0, flexShrink: 0,
        background: "none", border: "none", borderRadius: 9,
        cursor: hasUsage ? "pointer" : "default",
        transition: "background 0.12s, opacity 0.12s",
        opacity: hasUsage ? 1 : 0.5,
      }}
      onMouseEnter={(e) => {
        if (!hasUsage) return;
        e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "none";
      }}
    >
      <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
        <circle cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS} fill="none" stroke="var(--border)" strokeWidth={RING_STROKE} />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={RING_STROKE}
          strokeDasharray={`${filled} ${RING_CIRCUMFERENCE - filled}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          opacity={percent === null ? 0.35 : 1}
        />
      </svg>
    </button>
  );
}
