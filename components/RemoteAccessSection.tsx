"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { isTauriDesktop } from "@/lib/desktop-updater";
import {
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  getPushDeviceState,
  sendTestPushToThisDevice,
  type PushDeviceState,
} from "@/lib/push-client";
import type { RemoteAccessConfig } from "@/lib/remote-access";
import type { TailscaleStatus } from "@/lib/tailscale-status";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

interface RemoteAccessResponse {
  config: RemoteAccessConfig | null;
  tailscale: TailscaleStatus;
  local: boolean;
}

/** The port this page was served on, which is the one `tailscale serve` must point at. */
function currentPort(): string {
  if (typeof window === "undefined") return "";
  return window.location.port || (window.location.protocol === "https:" ? "443" : "80");
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="remote-access-step">
      <span className="settings-option-hint">{label}</span>
      <div className="remote-access-step-value">
        <code>{value}</code>
        <ConfigButton
          variant="ghost"
          onClick={() => {
            void copyText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? t("remoteAccess.copied") : t("remoteAccess.copy")}
        </ConfigButton>
      </div>
    </div>
  );
}

/**
 * Pushes to this browser: done, failed, or waiting for an answer. Shown on the phone
 * too, which is where it matters; iOS only grants the permission from a tap, and only
 * to a page added to the Home Screen.
 */
function PushDeviceRow() {
  const { t, locale } = useI18n();
  const [state, setState] = useState<PushDeviceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getPushDeviceState().then((next) => { if (!cancelled) setState(next); });
    return () => { cancelled = true; };
  }, []);

  const run = async (action: () => Promise<PushDeviceState | void>, success?: string) => {
    setBusy(true);
    setNote(null);
    try {
      const next = await action();
      if (next) setState(next);
      if (success) setNote(success);
    } catch (error) {
      setNote(t("remoteAccess.pushFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  };

  const hint = note ?? (
    state === "unsupported" ? t("remoteAccess.pushUnsupported")
      : state === "denied" ? t("remoteAccess.pushDenied")
        : state === "on" ? t("remoteAccess.pushOn")
          : t("remoteAccess.pushHint")
  );

  return (
    <div className="settings-option">
      <span className="settings-option-text">
        <span className="settings-option-title">{t("remoteAccess.push")}</span>
        <span className="settings-option-hint" role="status">{hint}</span>
      </span>
      {state === "on" && (
        <ConfigButton
          className="settings-option-action"
          variant="ghost"
          disabled={busy}
          onClick={() => void run(sendTestPushToThisDevice, t("remoteAccess.pushTestSent"))}
        >
          {t("remoteAccess.pushTest")}
        </ConfigButton>
      )}
      <ConfigSwitch
        checked={state === "on"}
        loading={state === null || busy}
        disabled={state === "unsupported" || state === "denied"}
        label={t("remoteAccess.push")}
        onChange={(next) => void run(() => next ? enablePushOnThisDevice(locale) : disablePushOnThisDevice())}
      />
    </div>
  );
}

/**
 * Settings › General › Remote access: open this server to the user's own
 * tailnet through `tailscale serve`, so a phone can follow and drive sessions.
 * The server still listens on 127.0.0.1; see lib/remote-access.ts.
 */
export function RemoteAccessSection() {
  const { t } = useI18n();
  const [data, setData] = useState<RemoteAccessResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hostnameDraft, setHostnameDraft] = useState("");
  const [loginDraft, setLoginDraft] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    fetch("/api/remote-access", { signal: controller.signal, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((next: RemoteAccessResponse) => {
        if (controller.signal.aborted) return;
        setData(next);
        setHostnameDraft(next.config?.hostname
          ?? (next.tailscale.state === "running" ? next.tailscale.hostname : ""));
        setLoginDraft(next.tailscale.state === "running" ? next.tailscale.login ?? "" : "");
      })
      .catch(() => { if (!controller.signal.aborted) setLoadFailed(true); });
    return () => controller.abort();
  }, [attempt]);

  const save = async (body: { hostname: string | null; logins?: string[] }) => {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/remote-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { config?: RemoteAccessConfig | null; error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setData((previous) => previous && { ...previous, config: result.config ?? null });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const tailscale = data?.tailscale;
  const config = data?.config ?? null;
  const enabled = config !== null;
  const toggle = (next: boolean) => {
    if (!next) {
      void save({ hostname: null });
      return;
    }
    // Only the named account gets in (prefilled with the one this computer is signed in
    // with), so a shared tailnet does not hand every member a shell here. The route
    // refuses an empty list; letting every tailnet user in is an API-only choice.
    void save({ hostname: hostnameDraft.trim(), logins: [loginDraft.trim()] });
  };

  const statusText = !data
    ? loadFailed ? t("remoteAccess.loadFailed") : t("remoteAccess.loading")
    : tailscale?.state === "missing"
      ? t("remoteAccess.tailscaleMissing")
      : tailscale?.state === "stopped"
        ? t("remoteAccess.tailscaleStopped", { state: tailscale.backendState })
        : t("remoteAccess.tailscaleRunning", { host: tailscale?.state === "running" ? tailscale.hostname : "" });

  const whoText = !enabled
    ? t("remoteAccess.switchHint")
    : config.logins.length > 0
      ? t("remoteAccess.onlyLogins", { logins: config.logins.join(", ") })
      : t("remoteAccess.anyLogin");

  return (
    <section className="settings-general-section remote-access-section">
      <h3 className="settings-general-heading">{t("remoteAccess.title")}</h3>
      <p className="settings-general-description">{t("remoteAccess.description")}</p>
      <div className="settings-option-list">
        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("remoteAccess.tailscale")}</span>
            <span className="settings-option-hint" role="status">{statusText}</span>
          </span>
          <ConfigButton
            className="settings-option-action"
            variant="ghost"
            onClick={() => { setData(null); setAttempt((value) => value + 1); }}
          >
            {t("remoteAccess.refresh")}
          </ConfigButton>
        </div>
        {data && !enabled && data.local && (
          <label className="remote-access-step">
            <span className="settings-option-hint">{t("remoteAccess.hostnameLabel")}</span>
            <input
              className="mcp-add-input"
              value={hostnameDraft}
              placeholder="mac.tail1234.ts.net"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setHostnameDraft(event.target.value)}
            />
          </label>
        )}
        {data && !enabled && data.local && (
          <label className="remote-access-step">
            <span className="settings-option-hint">{t("remoteAccess.loginLabel")}</span>
            <input
              className="mcp-add-input"
              value={loginDraft}
              placeholder="you@example.com"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setLoginDraft(event.target.value)}
            />
          </label>
        )}
        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("remoteAccess.switch")}</span>
            <span className="settings-option-hint" role="status">
              {saveError ?? (data && !data.local ? t("remoteAccess.localOnly") : whoText)}
            </span>
          </span>
          <ConfigSwitch
            checked={enabled}
            loading={!data || saving}
            disabled={!data?.local || (!enabled && (!hostnameDraft.trim() || !loginDraft.trim()))}
            label={t("remoteAccess.switch")}
            onChange={toggle}
          />
        </div>
        {/* The desktop window has its own completion notifications and no service worker. */}
        {!isTauriDesktop() && <PushDeviceRow />}
        {enabled && data?.local && (
          <>
            <CopyRow label={t("remoteAccess.stepServe")} value={`tailscale serve --bg ${currentPort()}`} />
            <CopyRow label={t("remoteAccess.stepOpen")} value={`https://${config.hostname}`} />
            <span className="settings-option-hint">{t("remoteAccess.portNote")}</span>
          </>
        )}
      </div>
    </section>
  );
}
