"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { EffectiveNetworkProxy, NetworkProxySettings } from "@/lib/network-proxy";
import type { ProxyTestResult } from "@/lib/network-proxy-test";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

interface NetworkProxyResponse {
  settings: NetworkProxySettings;
  effective: EffectiveNetworkProxy;
  local: boolean;
}

const DEFAULT_PLACEHOLDER = "http://127.0.0.1:7890";

/**
 * Settings › General › Network proxy: send this app's outbound traffic through
 * an HTTP(S) proxy without a system-wide TUN mode. See lib/network-proxy.ts.
 */
export function NetworkProxySection() {
  const { t } = useI18n();
  const [data, setData] = useState<NetworkProxyResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [urlDraft, setUrlDraft] = useState("");
  const [noProxyDraft, setNoProxyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | { error: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    fetch("/api/network-proxy", { signal: controller.signal, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((next: NetworkProxyResponse) => {
        if (controller.signal.aborted) return;
        setData(next);
        setUrlDraft(next.settings.url);
        setNoProxyDraft(next.settings.noProxy);
      })
      .catch(() => { if (!controller.signal.aborted) setLoadFailed(true); });
    return () => controller.abort();
  }, [attempt]);

  const save = async (enabled: boolean) => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/network-proxy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, url: urlDraft, noProxy: noProxyDraft }),
      });
      const result = await response.json() as Partial<NetworkProxyResponse> & { error?: string };
      if (!response.ok || !result.settings || !result.effective) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      setData({ settings: result.settings, effective: result.effective, local: true });
      setUrlDraft(result.settings.url);
      setNoProxyDraft(result.settings.noProxy);
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch("/api/network-proxy/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlDraft }),
      });
      const result = await response.json() as ProxyTestResult & { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setTestResult(result);
    } catch (error) {
      setTestResult({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const local = data?.local ?? false;
  const settings = data?.settings;
  const enabled = settings?.enabled ?? false;
  const dirty = Boolean(settings) && (urlDraft.trim() !== settings?.url || noProxyDraft.trim() !== settings?.noProxy);
  const editable = Boolean(data) && local && !saving;

  const effective = data?.effective;
  const statusText = !data
    ? loadFailed ? t("networkProxy.loadFailed") : t("networkProxy.loading")
    : effective?.source === "settings" && effective.url
      ? t("networkProxy.statusSettings", { url: effective.url })
      : effective?.source === "environment" && effective.url
        ? t("networkProxy.statusEnvironment", { url: effective.url })
        : effective?.source === "pi-settings" && effective.url
          ? t("networkProxy.statusPiSettings", { url: effective.url })
          : t("networkProxy.statusNone");

  const testText = !testResult
    ? null
    : "error" in testResult
      ? t("networkProxy.testFailed", { error: testResult.error })
      : testResult.ok
        ? t("networkProxy.testOk", { status: String(testResult.status), ms: String(testResult.elapsedMs) })
        : t(`networkProxy.testFailure.${testResult.reason}`, { error: testResult.message });
  const testOk = Boolean(testResult && !("error" in testResult) && testResult.ok);

  return (
    <section className="settings-general-section network-proxy-section">
      <h3 className="settings-general-heading">{t("networkProxy.title")}</h3>
      <p className="settings-general-description">{t("networkProxy.description")}</p>
      <div className="settings-option-list">
        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("networkProxy.switch")}</span>
            <span className="settings-option-hint" role="status">
              {data && !local ? t("networkProxy.localOnly") : statusText}
            </span>
          </span>
          {loadFailed && (
            <ConfigButton
              className="settings-option-action"
              variant="ghost"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t("common.retry")}
            </ConfigButton>
          )}
          <ConfigSwitch
            checked={enabled}
            loading={(!data && !loadFailed) || saving}
            disabled={!editable || (!enabled && !urlDraft.trim())}
            label={t("networkProxy.switch")}
            onChange={(next) => void save(next)}
          />
        </div>
        <label className="remote-access-step">
          <span className="settings-option-hint">{t("networkProxy.urlLabel")}</span>
          <input
            className="mcp-add-input"
            value={urlDraft}
            placeholder={DEFAULT_PLACEHOLDER}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={!editable}
            onChange={(event) => { setUrlDraft(event.target.value); setSaved(false); setTestResult(null); }}
          />
        </label>
        <label className="remote-access-step">
          <span className="settings-option-hint">{t("networkProxy.noProxyLabel")}</span>
          <input
            className="mcp-add-input"
            value={noProxyDraft}
            placeholder="localhost,127.0.0.1,::1"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={!editable}
            onChange={(event) => { setNoProxyDraft(event.target.value); setSaved(false); }}
          />
        </label>
        <div className="network-proxy-actions">
          <ConfigButton
            variant="secondary"
            disabled={!editable || testing || !urlDraft.trim()}
            onClick={() => void runTest()}
          >
            {testing ? t("networkProxy.testing") : t("networkProxy.test")}
          </ConfigButton>
          <ConfigButton
            variant="primary"
            disabled={!editable || !dirty}
            onClick={() => void save(enabled)}
          >
            {saving ? t("networkProxy.saving") : t("networkProxy.save")}
          </ConfigButton>
        </div>
        {testText && (
          <p role="status" className={testOk ? "settings-option-hint network-proxy-test-ok" : "settings-general-error"}>
            {testText}
          </p>
        )}
        {saveError && <p role="alert" className="settings-general-error">{saveError}</p>}
        {saved && !saveError && <span className="settings-option-hint" role="status">{t("networkProxy.saved")}</span>}
        <span className="settings-option-hint">{t("networkProxy.note")}</span>
      </div>
    </section>
  );
}
