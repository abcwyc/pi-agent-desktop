"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";
import type {
  LevelProbeResult,
  ProbeOutcome,
  ThinkingLevelMap,
  ThinkingProbeSummary,
} from "@/lib/thinking-level-probe";

type ProbeState =
  | { phase: "idle" }
  | { phase: "probing" }
  | { phase: "error"; message: string }
  | { phase: "done"; summary: ThinkingProbeSummary; changes: MapChange[]; applied: boolean };

interface MapChange {
  level: string;
  from: string | null | undefined;
  to: string | null | undefined;
}

const OUTCOME_KEYS: Record<ProbeOutcome, string> = {
  accepted: "models.probeAccepted",
  rejected: "models.probeRejected",
  "not-sent": "models.probeNotSent",
  inconclusive: "models.probeInconclusive",
  skipped: "models.probeSkipped",
};

function describeMapValue(value: string | null | undefined, t: (key: string) => string): string {
  if (value === undefined) return t("models.probeMapDefault");
  if (value === null) return t("models.probeMapDisabled");
  return value;
}

/**
 * "Test thinking levels" under the thinking level map: one small request per level
 * through /api/models-config/test, then an Apply that writes the suggested map into
 * the draft (saved with the rest of the model on Save).
 */
export function ThinkingLevelProbe({
  providerName,
  provider,
  model,
  onApply,
}: {
  providerName: string;
  provider: unknown;
  model: { id: string; thinkingLevelMap?: ThinkingLevelMap };
  onApply: (map: ThinkingLevelMap | undefined) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<ProbeState>({ phase: "idle" });
  const requestIdRef = useRef(0);
  // The map Apply wrote: the edit it causes must not clear the results it came from.
  const appliedMapKeyRef = useRef<string | null>(null);

  const draftKey = JSON.stringify({ providerName, provider, model });
  useEffect(() => {
    const mapKey = JSON.stringify(model.thinkingLevelMap ?? null);
    if (appliedMapKeyRef.current !== null && appliedMapKeyRef.current === mapKey) {
      appliedMapKeyRef.current = null;
      return;
    }
    appliedMapKeyRef.current = null;
    requestIdRef.current += 1;
    setState({ phase: "idle" });
    // Any edit of the draft makes earlier results stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const runProbe = useCallback(async () => {
    if (!model.id.trim()) return;
    const requestId = ++requestIdRef.current;
    setState({ phase: "probing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model, probeThinking: true }),
      });
      const data = await res.json() as { ok?: boolean; error?: string; thinking?: ThinkingProbeSummary };
      if (requestId !== requestIdRef.current) return;
      if (!res.ok || !data.ok || !data.thinking) {
        setState({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setState({
        phase: "done",
        summary: data.thinking,
        changes: diffMaps(model.thinkingLevelMap, data.thinking.suggestedMap),
        applied: false,
      });
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [model, provider, providerName]);

  const apply = () => {
    if (state.phase !== "done") return;
    appliedMapKeyRef.current = JSON.stringify(state.summary.suggestedMap ?? null);
    onApply(state.summary.suggestedMap);
    setState({ ...state, applied: true });
  };

  const summary = state.phase === "done" ? state.summary : null;
  const changes = state.phase === "done" ? state.changes : [];
  const applied = state.phase === "done" && state.applied;

  return (
    <div className="thinking-probe">
      <div className="thinking-probe-row">
        <ConfigButton
          size="small"
          onClick={() => void runProbe()}
          disabled={!model.id.trim() || state.phase === "probing"}
        >
          {state.phase === "probing" ? t("models.probeRunning") : t("models.probeButton")}
        </ConfigButton>
        <span className="thinking-probe-hint">{t("models.probeHelp")}</span>
      </div>

      {state.phase === "error" && (
        <div className="thinking-probe-note" data-tone="danger">{t("i18n.failed")} · {state.message}</div>
      )}

      {summary && (
        <>
          <ul className="thinking-probe-results">
            {summary.results.map((result) => (
              <ProbeResultRow key={result.level} result={result} label={t(OUTCOME_KEYS[result.outcome])} />
            ))}
          </ul>

          {!summary.applicable ? (
            <div className="thinking-probe-note">{t("models.probeNotApplicable")}</div>
          ) : summary.allRejected ? (
            <div className="thinking-probe-note" data-tone="warning">{t("models.probeAllRejected")}</div>
          ) : !summary.changed ? (
            <div className="thinking-probe-note" data-tone="success">{t("models.probeNoChange")}</div>
          ) : (
            <div className="thinking-probe-suggestion">
              <div className="thinking-probe-note">
                {applied ? t("models.probeApplied") : t("models.probeSuggestion")}
              </div>
              <ul className="thinking-probe-changes">
                {changes.map((change) => (
                  <li key={change.level}>
                    <code>{change.level}</code>
                    {" "}{describeMapValue(change.from, t)} → {describeMapValue(change.to, t)}
                  </li>
                ))}
              </ul>
              {!applied && (
                <ConfigButton size="small" variant="primary" onClick={apply}>
                  {t("models.probeApply")}
                </ConfigButton>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProbeResultRow({ result, label }: { result: LevelProbeResult; label: string }) {
  const detail = [
    result.value && result.value !== result.level ? `→ ${result.value}` : null,
    result.status !== undefined && result.outcome !== "accepted" ? `HTTP ${result.status}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="thinking-probe-result" data-outcome={result.outcome} title={result.error}>
      <code>{result.level}</code>
      <span className="thinking-probe-badge">{label}</span>
      {detail && <span className="thinking-probe-detail">{detail}</span>}
    </li>
  );
}

const MAP_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function diffMaps(current: ThinkingLevelMap | undefined, suggested: ThinkingLevelMap | undefined): MapChange[] {
  const before = current ?? {};
  const after = suggested ?? {};
  return MAP_LEVELS
    .filter((level) => (level in before) !== (level in after) || before[level] !== after[level])
    .map((level) => ({
      level,
      from: level in before ? before[level] : undefined,
      to: level in after ? after[level] : undefined,
    }));
}
