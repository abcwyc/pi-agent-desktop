"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatStepSeconds, type ToolStepSummary } from "@/lib/tool-step-groups";
import { getToolPreview } from "./MessageView";

const MAX_TOOL_NAMES = 3;

/**
 * A run of tool steps folded into one row (lib/tool-step-groups.ts):
 * "bash ×4 · read ×2 · 6 calls · 1m 12s", the newest call's arguments, and a
 * failed or running mark. Opening it shows the steps as they always drew.
 * `reveal` opens it for a search hit inside.
 */
export function ToolStepGroup({ summary, running = false, reveal = false, registerRef, children }: {
  summary: ToolStepSummary;
  running?: boolean;
  reveal?: boolean;
  /** Called with the row while it is folded, so jumps to a step inside still land on it. */
  registerRef?: (element: HTMLElement | null) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    if (reveal) setExpanded(true);
  }, [reveal]);
  const open = expanded || reveal;
  const names = summary.byTool.slice(0, MAX_TOOL_NAMES).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const more = summary.byTool.length - MAX_TOOL_NAMES;
  const preview = summary.lastCall ? getToolPreview(summary.lastCall) : "";

  return (
    <div className={`tool-step-group${open ? " is-open" : ""}`} ref={open ? undefined : registerRef}>
      <button
        type="button"
        className="tool-step-group-trigger"
        aria-expanded={open}
        title={open ? t("chat.collapseToolSteps") : t("chat.expandToolSteps")}
        onClick={() => setExpanded((value) => !value)}
      >
        <svg className="tool-step-group-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span className="tool-step-group-tools">
          {names.join(" · ")}
          {more > 0 && ` · ${t("chat.toolStepsMoreTools", { count: more })}`}
        </span>
        <span className="tool-step-group-preview">{preview}</span>
        <span className="tool-step-group-meta">
          {summary.failed > 0 && <span className="tool-step-group-failed">{t("chat.toolStepsFailed", { count: summary.failed })}</span>}
          {running && summary.pending > 0 && <span className="tool-step-group-running">{t("chat.toolStepsRunning")}</span>}
          <span>{t("chat.toolStepCalls", { count: summary.calls })}</span>
          {summary.seconds !== null && <span>{formatStepSeconds(summary.seconds)}</span>}
        </span>
      </button>
      {open && <div className="tool-step-group-content">{children}</div>}
    </div>
  );
}
