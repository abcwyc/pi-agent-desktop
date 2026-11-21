"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";
import {
  applyBuiltinSettings,
  diffBuiltinSettings,
  hasBuiltinDiff,
  normalizeEndpoint,
  type BuiltinMatch,
  type ThinkingLevelMap,
} from "@/lib/builtin-model-match";

const LOOKUP_DELAY_MS = 300;

/** The built-in catalog's answer for this endpoint and model id (null until known). */
export function useBuiltinMatch(baseUrl: string | undefined, modelId?: string): BuiltinMatch | null {
  const [match, setMatch] = useState<BuiltinMatch | null>(null);
  const endpoint = normalizeEndpoint(baseUrl);
  const id = modelId?.trim() ?? "";
  useEffect(() => {
    setMatch(null);
    if (!endpoint || !baseUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ baseUrl: baseUrl.trim(), modelId: id });
      fetch(`/api/models-config/builtin-match?${params}`, { signal: controller.signal })
        .then((res) => res.ok ? res.json() as Promise<BuiltinMatch> : null)
        .then((data) => { if (data && Array.isArray(data.providers)) setMatch(data); })
        .catch(() => undefined);
    }, LOOKUP_DELAY_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // The normalized endpoint, not the raw text: a trailing slash is the same endpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, id]);
  return match;
}

/**
 * Under a custom provider's Base URL: the endpoint is one pi ships as a built-in
 * provider, which carries each model's thinking levels and compat and follows pi's
 * updates. Opening it needs only an API key there.
 */
export function BuiltinProviderNotice({
  baseUrl,
  openableIds,
  onOpen,
}: {
  baseUrl: string | undefined;
  /** Built-in providers the Models panel can open (API-key providers). */
  openableIds: ReadonlySet<string>;
  onOpen: (providerId: string) => void;
}) {
  const { t } = useI18n();
  const match = useBuiltinMatch(baseUrl);
  if (!match || match.providers.length === 0) return null;
  const names = match.providers.map((p) => p.name).join(t("models.builtinNameSeparator"));
  return (
    <div className="builtin-match-notice" role="note">
      <div>{t("models.builtinProviderNotice", { names })}</div>
      <div className="builtin-match-actions">
        {match.providers.filter((p) => openableIds.has(p.id)).map((p) => (
          <ConfigButton key={p.id} size="small" onClick={() => onOpen(p.id)}>
            {t("models.builtinProviderOpen", { name: p.name })}
          </ConfigButton>
        ))}
      </div>
    </div>
  );
}

interface DraftModel {
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: Record<string, unknown>;
}

/**
 * At the top of a custom model: pi lists this model at this endpoint with other
 * reasoning / thinking level / compat settings. Apply copies them into the draft.
 */
export function BuiltinModelNotice<T extends DraftModel>({
  baseUrl,
  model,
  effectiveCompat,
  onApply,
}: {
  baseUrl: string | undefined;
  model: T;
  effectiveCompat: Record<string, unknown>;
  onApply: (next: T) => void;
}) {
  const { t } = useI18n();
  const match = useBuiltinMatch(baseUrl, model.id);
  const builtin = match?.model;
  if (!builtin) return null;
  const diff = diffBuiltinSettings(builtin, model, effectiveCompat);
  if (!hasBuiltinDiff(diff)) return null;

  const changes = [
    diff.reasoning ? t("models.builtinChangeReasoning") : null,
    diff.thinkingLevelMap ? t("models.builtinChangeLevels") : null,
    diff.compatKeys.length ? t("models.builtinChangeCompat", { keys: diff.compatKeys.join(", ") }) : null,
  ].filter((part): part is string => Boolean(part));
  const provider = builtin.providers[0];

  return (
    <div className="builtin-match-notice" role="note">
      <div>{t("models.builtinModelNotice", { provider: provider?.name ?? "", model: builtin.modelName ?? model.id })}</div>
      <ul className="builtin-match-changes">
        {changes.map((change) => <li key={change}>{change}</li>)}
      </ul>
      <div className="builtin-match-actions">
        <ConfigButton size="small" variant="primary" onClick={() => onApply(applyBuiltinSettings(model, builtin))}>
          {t("models.builtinModelApply")}
        </ConfigButton>
      </div>
    </div>
  );
}
