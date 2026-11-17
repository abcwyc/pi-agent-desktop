"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PluginPackageInfo } from "@/lib/api-types";
import type { DiscoveredPlugin, PluginSearchResponse } from "@/lib/plugin-discovery";
import { ConfigButton, ConfigDetailTitle, ConfigSaveTarget } from "./SettingsUi";

export function PluginDiscovery({ cwd, scope, onScopeChange, projectResourcesLoaded, packages, busy, onInstall, installing, installError, message, sessionId, onReload }: {
  cwd: string;
  scope: "global" | "project";
  onScopeChange: (scope: "global" | "project") => void;
  projectResourcesLoaded: boolean;
  packages: PluginPackageInfo[];
  busy: boolean;
  onInstall: (source: string, scope: "global" | "project") => Promise<void>;
  installing: string | null;
  installError: { name: string; message: string } | null;
  message: string;
  sessionId: string | null;
  onReload: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [results, setResults] = useState<DiscoveredPlugin[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const requestRef = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const failedOffset = useRef(0);
  const resultQuery = useRef("");

  // Abort is best-effort: a response may already be decoding when a newer
  // search starts. The generation also prevents it replacing that search's rows.
  async function load(q: string, offset: number) {
    const request = ++requestRef.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError(false);
    failedOffset.current = offset;
    try {
      const params = new URLSearchParams({ q, offset: String(offset) });
      const response = await fetch(`/api/plugins/search?${params}`, { signal: abort.signal });
      if (!response.ok) throw new Error("Search failed");
      const data = await response.json() as PluginSearchResponse;
      if (request !== requestRef.current || abort.signal.aborted) return;
      resultQuery.current = q;
      setResults((current) => offset === 0 ? data.packages : [...new Map([...current, ...data.packages].map((p) => [p.name, p])).values()]);
      setNextOffset(data.nextOffset);
    } catch {
      if (request === requestRef.current && !abort.signal.aborted) setError(true);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(submitted, 0);
  }, [submitted, retry]);

  // Read the current controller at unmount, including a later pagination or
  // retry request, rather than capturing only the first page's controller.
  useEffect(() => () => { controller.current?.abort(); }, []);

  // Keep an explicitly chosen project target when trust is revoked. Silently
  // switching to global would install executable code into a wider scope.
  const targetScope = scope;
  const targetBlocked = scope === "project" && !projectResourcesLoaded;
  const staleResults = resultQuery.current !== submitted;
  return <div className="plugin-discovery">
    <ConfigDetailTitle>{t("plugins.discover")}</ConfigDetailTitle>
    <p className="plugin-discovery-note">{t("plugins.discoverySource")}</p>
    <ConfigSaveTarget value={targetScope} label={t("config.saveTo")}
      options={[{ value: "global", label: t("plugins.discoveryGlobal") }, { value: "project", label: t("plugins.discoveryProject"), disabled: !projectResourcesLoaded }]}
      path={targetScope === "global" ? "~/.pi/agent/settings.json" : `${cwd}/.pi/settings.json`}
      disabledReason={t("trust.projectScopeUnavailable")} onChange={onScopeChange} />
    <form className="plugin-discovery-search" onSubmit={(event) => { event.preventDefault(); setSubmitted(query.trim()); setRetry((n) => n + 1); }}>
      <input aria-label={t("plugins.searchPlaceholder")} placeholder={t("plugins.searchPlaceholder")} value={query} maxLength={160} onChange={(event) => setQuery(event.target.value)} />
      <ConfigButton type="submit">{t("plugins.search")}</ConfigButton>
    </form>
    {error && <div role="alert" className="plugin-discovery-note">{t("plugins.searchFailed")} <ConfigButton onClick={() => void load(submitted, failedOffset.current)}>{t("plugins.retry")}</ConfigButton></div>}
    {message && <div className="plugin-discovery-feedback" role="status"><span>{message}</span>{sessionId && <ConfigButton disabled={busy} onClick={onReload}>{t("i18n.reloadSession")}</ConfigButton>}</div>}
    <div className="plugin-discovery-grid" aria-busy={loading}>
      {results.map((pkg) => {
        const installed = packages.some((p) => p.scope === targetScope && (p.source === `npm:${pkg.name}` || p.source.startsWith(`npm:${pkg.name}@`)) && p.status !== "missing");
        return <article key={pkg.name} className="plugin-discovery-card">
          <h3>{pkg.name}</h3><p className="plugin-discovery-meta">{pkg.version}{pkg.publisher ? ` · ${pkg.publisher}` : ""}</p>
          <p className="plugin-discovery-description">{pkg.description}</p>
          <div className="plugin-discovery-actions"><a href={pkg.url} target="_blank" rel="noopener noreferrer">npm ↗</a>
            <ConfigButton variant={installed ? "secondary" : "primary"} disabled={busy || installing !== null || installed || targetBlocked || staleResults} onClick={() => { void onInstall(`npm:${pkg.name}`, targetScope); }}>{installed ? t("plugins.status.installed") : installing === pkg.name ? t("i18n.installing") : t("i18n.install")}</ConfigButton>
          </div>
          {installError?.name === `${targetScope}:${pkg.name}` && <p role="alert" className="plugin-discovery-error">{installError.message}</p>}
        </article>;
      })}
    </div>
    {loading && <p role="status">{t("i18n.loading")}</p>}
    {!loading && !error && results.length === 0 && <p>{t("plugins.noResults")}</p>}
    {nextOffset !== null && !error && resultQuery.current === submitted && <ConfigButton disabled={loading} onClick={() => void load(submitted, nextOffset)}>{t("plugins.loadMore")}</ConfigButton>}
  </div>;
}
