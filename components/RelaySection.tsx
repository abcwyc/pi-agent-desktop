"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { PendingPairing, RelayStatus } from "@/lib/relay/connector";
import type { PairedDevice } from "@/lib/relay/store";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

interface RelayResponse {
  local: boolean;
  config: { enabled: boolean; url: string; entryUrl: string; needsRegistration: boolean } | null;
  status: RelayStatus;
  devices: PairedDevice[];
  pending: PendingPairing[];
}

function isRelayResponse(value: unknown): value is RelayResponse {
  const body = value as Partial<RelayResponse> | null;
  return Boolean(body?.status) && Array.isArray(body?.devices) && Array.isArray(body?.pending);
}

interface Pairing {
  url: string;
  expiresAt: number;
}

function QrCode({ text }: { text: string }) {
  // The link is a few hundred characters: medium error correction keeps it scannable.
  const svg = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(text);
    code.make();
    return code.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
  }, [text]);
  // Our own SVG markup from qrcode-generator, not user input.
  return <div className="relay-qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * Settings › General › Remote relay: reach this computer from a phone through a
 * relay server, end to end encrypted (docs/remote-relay.md). Configure the
 * relay, pair phones with a QR code, approve or deny pairing requests, and
 * remove phones. Only this computer may change any of it.
 */
export function RelaySection() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<RelayResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [url, setUrl] = useState("");
  const [entryUrl, setEntryUrl] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (initial = false) => {
    try {
      const response = await fetch("/api/relay", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next: unknown = await response.json();
      // An older server (or one without the relay routes) answers with something else.
      if (!isRelayResponse(next)) throw new Error("Unexpected response");
      setData(next);
      setLoadFailed(false);
      if (initial && next.config) {
        setUrl(next.config.url);
        setEntryUrl(next.config.entryUrl);
      }
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(true); }, [load]);

  // Poll faster while something is changing: connecting, a QR on screen, a request waiting.
  const live = Boolean(pairing) || (data?.pending.length ?? 0) > 0 || data?.status.state === "connecting";
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
      setNow(Date.now());
    }, live ? 1500 : 8000);
    return () => clearInterval(timer);
  }, [live, load]);

  useEffect(() => {
    if (pairing && pairing.expiresAt <= now) setPairing(null);
  }, [pairing, now]);

  const request = async (input: string, init: RequestInit): Promise<unknown> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(input, init);
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      return body;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const save = async (enabled: boolean) => {
    const result = await request("/api/relay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, entryUrl, enabled, ...(adminToken.trim() ? { adminToken: adminToken.trim() } : {}) }),
    }) as RelayResponse | null;
    if (result) {
      if (isRelayResponse(result)) setData(result);
      else await load();
      setAdminToken("");
      if (!enabled) setPairing(null);
    }
  };

  const startPairing = async () => {
    const result = await request("/api/relay/pairing", { method: "POST" }) as Pairing | null;
    if (result) {
      setPairing(result);
      setNow(Date.now());
    }
  };

  const answer = async (id: string, action: "approve" | "deny") => {
    const result = await request(`/api/relay/pairing/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (result) {
      setPairing(null);
      await load();
    }
  };

  const removeDevice = async (device: PairedDevice) => {
    if (!window.confirm(t("relay.removeConfirm", { name: device.name }))) return;
    if (await request(`/api/relay/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" })) await load();
  };

  const status = data?.status;
  const config = data?.config ?? null;
  const enabled = Boolean(config?.enabled);
  const local = data?.local ?? false;
  const statusText = !data
    ? loadFailed ? t("relay.loadFailed") : t("relay.loading")
    : !enabled ? t("relay.statusOff")
      : status?.state === "online" ? t("relay.statusOnline", { count: status.phones })
        : status?.state === "connecting" ? t("relay.statusConnecting")
          : t("relay.statusError", { error: status?.error ?? "" });
  const secondsLeft = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <section className="settings-general-section relay-section">
      <h3 className="settings-general-heading">{t("relay.title")}</h3>
      <p className="settings-general-description">{t("relay.description")}</p>
      <div className="settings-option-list">
        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("relay.connection")}</span>
            <span className="settings-option-hint" role="status" data-state={enabled ? status?.state : "off"}>{statusText}</span>
          </span>
          <ConfigSwitch
            checked={enabled}
            loading={!data || busy}
            disabled={!local || (!enabled && (!url.trim() || !entryUrl.trim()))}
            label={t("relay.connection")}
            onChange={(next) => void save(next)}
          />
        </div>
        {data && !local && <span className="settings-option-hint relay-note">{t("relay.localOnly")}</span>}
        {local && !enabled && (
          <>
            <label className="remote-access-step">
              <span className="settings-option-hint">{t("relay.urlLabel")}</span>
              <input className="mcp-add-input" value={url} placeholder="wss://relay.example.com" spellCheck={false} autoCapitalize="off" onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label className="remote-access-step">
              <span className="settings-option-hint">{t("relay.entryLabel")}</span>
              <input className="mcp-add-input" value={entryUrl} placeholder="https://pi.example.com" spellCheck={false} autoCapitalize="off" onChange={(e) => setEntryUrl(e.target.value)} />
            </label>
            <label className="remote-access-step">
              <span className="settings-option-hint">{t("relay.adminLabel")}</span>
              <input className="mcp-add-input" type="password" value={adminToken} autoComplete="off" onChange={(e) => setAdminToken(e.target.value)} />
            </label>
          </>
        )}
        {error && <span className="settings-option-hint relay-error" role="alert">{error}</span>}

        {local && enabled && status?.state === "online" && (
          <div className="settings-option">
            <span className="settings-option-text">
              <span className="settings-option-title">{t("relay.pairTitle")}</span>
              <span className="settings-option-hint">{t("relay.pairHint")}</span>
            </span>
            <ConfigButton className="settings-option-action" disabled={busy} onClick={() => void startPairing()}>
              {pairing ? t("relay.pairAgain") : t("relay.pairButton")}
            </ConfigButton>
          </div>
        )}
        {pairing && (
          <div className="relay-pairing">
            <QrCode text={pairing.url} />
            <span className="settings-option-hint">{t("relay.pairExpires", { seconds: secondsLeft })}</span>
            <ConfigButton variant="ghost" onClick={() => {
              void copyText(pairing.url).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); });
            }}>
              {copied ? t("relay.copied") : t("relay.copyLink")}
            </ConfigButton>
          </div>
        )}
        {local && data?.pending.map((request) => (
          <div key={request.id} className="settings-option relay-pending" role="alert">
            <span className="settings-option-text">
              <span className="settings-option-title">{t("relay.pendingTitle", { name: request.name })}</span>
              <span className="settings-option-hint">{t("relay.pendingHint", { code: `${request.code.slice(0, 3)} ${request.code.slice(3)}`, id: request.deviceId })}</span>
            </span>
            <span className="relay-actions">
              <ConfigButton variant="ghost" disabled={busy} onClick={() => void answer(request.id, "deny")}>{t("relay.deny")}</ConfigButton>
              <ConfigButton disabled={busy} onClick={() => void answer(request.id, "approve")}>{t("relay.allow")}</ConfigButton>
            </span>
          </div>
        ))}
        {(data?.devices.length ?? 0) > 0 && (
          <div className="relay-devices">
            <span className="settings-option-hint">{t("relay.devicesTitle")}</span>
            {data!.devices.map((device) => (
              <div key={device.id} className="settings-option">
                <span className="settings-option-text">
                  <span className="settings-option-title">{device.name}</span>
                  <span className="settings-option-hint">
                    {device.lastSeenAt
                      ? t("relay.lastSeen", { time: formatRelativeTime(new Date(device.lastSeenAt), locale) })
                      : t("relay.pairedAt", { time: formatRelativeTime(new Date(device.pairedAt), locale) })}
                  </span>
                </span>
                {local && (
                  <ConfigButton className="settings-option-action" variant="ghost" disabled={busy} onClick={() => void removeDevice(device)}>
                    {t("relay.remove")}
                  </ConfigButton>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
