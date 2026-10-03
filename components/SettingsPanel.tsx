"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useDiffViewMode } from "@/hooks/useDiffViewMode";
import { PRODUCT_NAME } from "@/lib/branding";
import { openPathNative, isTauriDesktop } from "@/lib/desktop-native";
import { THEME_OPTIONS } from "@/lib/theme";
import { ThemeIcon } from "./ThemeIcon";
import {
  CHAT_CONTENT_WIDTH_DEFAULT,
  CHAT_CONTENT_WIDTH_MAX,
  CHAT_CONTENT_WIDTH_MIN,
  CHAT_CONTENT_FONT_SIZE_DEFAULT,
  CHAT_CONTENT_FONT_SIZE_MAX,
  CHAT_CONTENT_FONT_SIZE_MIN,
  useChatAppearance,
} from "@/hooks/useChatAppearance";
import { useEnterSendMode, setEnterSendMode } from "@/hooks/useEnterSendMode";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ProjectTrustStatus, ToolSettingsResponse } from "@/lib/api-types";
import {
  setLastSettingsSection,
  settingsSectionRequiresProject,
  type SettingsSection,
} from "@/lib/settings-navigation";
import { focusModalPanel, listenForPanelEscape } from "@/lib/stacked-dialog";
import {
  isThinkingExpandedByDefault,
  setThinkingExpandedByDefault,
} from "@/lib/thinking-expansion-preference";
import { ModelsConfig } from "./ModelsConfig";
import { setupPushSubscription } from "@/lib/push-client";
import { SkillsConfig } from "./SkillsConfig";
import { AgentsConfig } from "./AgentsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { AppUpdatesSection } from "./AppUpdatesSection";
import { DesktopAppSection } from "./desktop";
import { McpConfig } from "./McpConfig";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

interface Props {
  cwd: string | null;
  sessionId: string | null;
  initialSection: SettingsSection;
  onClose: () => void;
  onSessionReloaded: () => void;
  quoteSelectionEnabled: boolean;
  onQuoteSelectionChange: (enabled: boolean) => void;
  /** The page's trust status for `cwd`; Settings › MCP reloads when it changes, as after trusting. */
  projectTrust?: ProjectTrustStatus | null;
  /** Opens the page's trust dialog for `cwd`, above Settings; Settings › MCP's trust notice offers it. */
  onOpenTrustDialog?: () => void;
  /** Settings › MCP added a project server, which changed `cwd`'s trust (and may have trusted a fresh folder). */
  onProjectTrustChanged?: (cwd: string, status: ProjectTrustStatus) => void;
}

export function SettingsSectionIcon({ section, size = 16, strokeWidth = 1.8 }: { section: SettingsSection; size?: number; strokeWidth?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "settings-section-icon",
  };

  if (section === "general") return <svg {...common}><path d="M20 7h-9M14 17H5" /><circle cx="7" cy="7" r="3" /><circle cx="17" cy="17" r="3" /></svg>;
  if (section === "models") return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" /></svg>;
  if (section === "skills") return <svg {...common}><path d="m12 2-10 5 10 5 10-5-10-5Z" /><path d="m2 12 10 5 10-5M2 17l10 5 10-5" /></svg>;
  if (section === "agents") return <svg {...common} className="settings-section-icon is-agent"><rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" /></svg>;
  if (section === "mcp") return <svg {...common}><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" /></svg>;
  if (section === "plugins") return <svg {...common}><path d="M9 7V2M15 7V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0ZM12 19v3" /></svg>;
  return <svg {...common}><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>;
}

function GeneralSettings({
  sessionId,
  onSessionReloaded,
  quoteSelectionEnabled,
  onQuoteSelectionChange,
  onBusyChange,
}: Pick<Props, "sessionId" | "onSessionReloaded" | "quoteSelectionEnabled" | "onQuoteSelectionChange"> & {
  onBusyChange: (busy: boolean) => void;
}) {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const { preference, setThemePreference } = useTheme();
  const { mode: diffViewMode, setMode: setDiffViewMode } = useDiffViewMode();
  const { width: chatContentWidth, setWidth: setChatContentWidth, fontSize, setFontSize } = useChatAppearance();
  const desktop = isTauriDesktop();
  const enterSendMode = useEnterSendMode();
  const [shellSettings, setShellSettings] = useState<ToolSettingsResponse | null>(null);
  const [shellSaving, setShellSaving] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [pushRegistering, setPushRegistering] = useState(false);
  const [pushStatus, setPushStatus] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [webAuthEnabled, setWebAuthEnabled] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [customCssBusy, setCustomCssBusy] = useState(false);
  const [customCssError, setCustomCssError] = useState<string | null>(null);

  useEffect(() => {
    setThinkingExpanded(isThinkingExpandedByDefault());
    void fetch("/api/web-auth")
      .then((response) => response.ok ? response.json() : null)
      .then((data: { enabled?: boolean } | null) => setWebAuthEnabled(data?.enabled === true))
      .catch(() => {});
  }, []);

  const logOut = async () => {
    setLoggingOut(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/web-auth", { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      window.location.replace("/login");
    } catch {
      setLogoutError(t("auth.logoutFailed"));
    } finally {
      setLoggingOut(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/tools/settings")
      .then(async (response) => {
        const data = await response.json() as ToolSettingsResponse & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!cancelled) setShellSettings(data);
      })
      .catch((cause) => {
        if (!cancelled) setShellError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, []);

  const togglePowerShell = async (enabled: boolean) => {
    setShellSaving(true);
    setShellError(null);
    try {
      const response = await fetch("/api/tools/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as ToolSettingsResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setShellSettings(data);
      if (sessionId) {
        await sendAgentCommand(sessionId, { type: "reload" });
        onSessionReloaded();
      }
    } catch (cause) {
      setShellError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setShellSaving(false);
    }
  };

  const registerPush = async () => {
    if (pushRegistering) return;
    setPushRegistering(true);
    setPushStatus(null);
    try {
      if (typeof window === "undefined" || !("Notification" in window)) {
        throw new Error("unsupported or not permitted");
      }
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== "granted") throw new Error("unsupported or not permitted");
      const ok = await setupPushSubscription(locale);
      if (!ok) throw new Error("unsupported or not permitted");
      setPushStatus({ kind: "ok", message: t("settings.pushRegistered") });
    } catch (cause) {
      setPushStatus({ kind: "error", message: `${t("settings.pushRegisterFailed")} ${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      setPushRegistering(false);
    }
  };

  const openCustomCss = async () => {
    setCustomCssBusy(true);
    setCustomCssError(null);
    try {
      const response = await fetch("/api/custom-css", { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { path?: string };
      if (!data.path) throw new Error("Missing path in response");
      await openPathNative(data.path);
    } catch (error) {
      console.error("Failed to open custom.css:", error);
      setCustomCssError(t("appSettings.customCssOpenError"));
    } finally {
      setCustomCssBusy(false);
    }
  };

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t("settings.general")}</h2>

      <div className="settings-general-intro">
        <p className="settings-general-tagline">{t("appSettings.tagline", { product: PRODUCT_NAME })}</p>
        <p className="settings-general-tagline">{t("appSettings.taglineDetails")}</p>
      </div>

      <AppUpdatesSection onBusyChange={onBusyChange} />

      <div className="settings-general-columns">
        <div className="settings-general-col">
          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("settings.appearance")}</h3>
            <div role="radiogroup" aria-label={t("settings.appearance")} className="settings-theme-options">
              {THEME_OPTIONS.map((option) => {
                const selected = preference === option.id;
                return (
                  <label
                    key={option.id}
                    className="settings-theme-option"
                  >
                    <input
                      type="radio"
                      name="theme"
                      value={option.id}
                      checked={selected}
                      onChange={() => setThemePreference(option.id)}
                      className="sr-only"
                    />
                    <ThemeIcon preference={option.id} />
                    <span className="settings-theme-option-label">{t(option.label)}</span>
                  </label>
                );
              })}
            </div>
            <div className="settings-option-list">
              <div className="settings-option">
                <span className="settings-option-text">
                  <span className="settings-option-title">{t("appSettings.customCss")}</span>
                  <span className="settings-option-hint">{t("appSettings.customCssHint")}</span>
                </span>
                {desktop && (
                  <ConfigButton
                    variant="secondary"
                    size="small"
                    className="settings-option-action"
                    disabled={customCssBusy}
                    onClick={() => void openCustomCss()}
                  >
                    {customCssBusy ? t("appSettings.customCssOpening") : t("appSettings.customCssOpen")}
                  </ConfigButton>
                )}
              </div>
            </div>
            {customCssError && <p role="alert" className="settings-general-error">{customCssError}</p>}
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("settings.chat")}</h3>
            <div className="settings-chat-options">
              <div className="settings-chat-option settings-chat-switch-option">
                <span>{t("settings.thinkingExpandedDefault")}</span>
                <ConfigSwitch
                  checked={thinkingExpanded}
                  label={t("settings.thinkingExpandedDefault")}
                  onChange={(enabled) => {
                    setThinkingExpandedByDefault(enabled);
                    setThinkingExpanded(enabled);
                  }}
                />
              </div>
              <div className="settings-chat-option settings-chat-range-option">
                <div className="settings-chat-range-header">
                  <label htmlFor="settings-chat-content-width">{t("settings.chatContentWidth")}</label>
                  <output htmlFor="settings-chat-content-width">{chatContentWidth}px</output>
                  <ConfigButton
                    variant="ghost"
                    size="small"
                    className="settings-chat-reset"
                    title={t("settings.resetChatContentWidth")}
                    aria-label={t("settings.resetChatContentWidth")}
                    disabled={chatContentWidth === CHAT_CONTENT_WIDTH_DEFAULT}
                    onClick={() => setChatContentWidth(CHAT_CONTENT_WIDTH_DEFAULT)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
                    </svg>
                  </ConfigButton>
                </div>
                <input
                  id="settings-chat-content-width"
                  type="range"
                  min={CHAT_CONTENT_WIDTH_MIN}
                  max={CHAT_CONTENT_WIDTH_MAX}
                  step={10}
                  value={chatContentWidth}
                  onChange={(event) => setChatContentWidth(Number(event.target.value))}
                />
              </div>
              <div className="settings-chat-option settings-chat-range-option">
                <div className="settings-chat-range-header">
                  <label htmlFor="settings-chat-content-font-size">{t("settings.chatContentFontSize")}</label>
                  <output htmlFor="settings-chat-content-font-size">{fontSize}px</output>
                  <ConfigButton
                    variant="ghost"
                    size="small"
                    className="settings-chat-reset"
                    title={t("settings.resetChatContentFontSize")}
                    aria-label={t("settings.resetChatContentFontSize")}
                    disabled={fontSize === CHAT_CONTENT_FONT_SIZE_DEFAULT}
                    onClick={() => setFontSize(CHAT_CONTENT_FONT_SIZE_DEFAULT)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
                    </svg>
                  </ConfigButton>
                </div>
                <input
                  id="settings-chat-content-font-size"
                  type="range"
                  min={CHAT_CONTENT_FONT_SIZE_MIN}
                  max={CHAT_CONTENT_FONT_SIZE_MAX}
                  step={1}
                  value={fontSize}
                  onChange={(event) => setFontSize(Number(event.target.value))}
                />
              </div>
              <div className="settings-chat-option settings-chat-switch-option">
                <span>{t("settings.quoteSelection")}</span>
                <ConfigSwitch
                  checked={quoteSelectionEnabled}
                  label={t("settings.quoteSelection")}
                  onChange={onQuoteSelectionChange}
                />
              </div>
              <div className="settings-chat-option settings-chat-switch-option" role="radiogroup" aria-label={t("settings.enterSendMode")}>
                <span>{t("settings.enterSendMode")}</span>
                <div className="settings-send-mode-options">
                  <label className="settings-send-mode-option">
                    <input
                      type="radio"
                      name="enter-send-mode"
                      value="enter"
                      checked={enterSendMode === "enter"}
                      onChange={() => setEnterSendMode("enter")}
                      className="sr-only"
                    />
                    <span className="settings-send-mode-label">{t("settings.enterSendModeEnter")}</span>
                  </label>
                  <label className="settings-send-mode-option">
                    <input
                      type="radio"
                      name="enter-send-mode"
                      value="ctrlEnter"
                      checked={enterSendMode === "ctrlEnter"}
                      onChange={() => setEnterSendMode("ctrlEnter")}
                      className="sr-only"
                    />
                    <span className="settings-send-mode-label">{t("settings.enterSendModeCtrlEnter")}</span>
                  </label>
                </div>
              </div>
              <div className="settings-chat-option settings-chat-choice-option">
                <span title={t("appSettings.diffViewModeHint")}>{t("appSettings.diffViewMode")}</span>
                <div className="settings-choice-group" role="radiogroup" aria-label={t("appSettings.diffViewMode")}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={diffViewMode === "split"}
                    className={`config-button config-button-small ${diffViewMode === "split" ? "config-button-primary" : "config-button-secondary"}`}
                    onClick={() => setDiffViewMode("split")}
                  >
                    {t("appSettings.diffViewModeSplit")}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={diffViewMode === "unified"}
                    className={`config-button config-button-small ${diffViewMode === "unified" ? "config-button-primary" : "config-button-secondary"}`}
                    onClick={() => setDiffViewMode("unified")}
                  >
                    {t("appSettings.diffViewModeUnified")}
                  </button>
                </div>
              </div>
            </div>
          </section>

          {shellSettings?.isWindows && (
            <section className="settings-general-section">
              <h3 className="settings-general-heading">{t("settings.shellTool")}</h3>
              <p className="settings-general-description">{t("settings.shellToolDescription")}</p>
              <div className="settings-shell-option">
                <span>{t("settings.usePowerShell")}</span>
                <ConfigSwitch
                  checked={shellSettings.powerShellEnabled}
                  loading={shellSaving}
                  label={t("settings.usePowerShell")}
                  onChange={(enabled) => void togglePowerShell(enabled)}
                />
              </div>
              {shellError && <p role="alert" className="settings-general-error">{shellError}</p>}
            </section>
          )}
        </div>

        <div className="settings-general-col">
          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("settings.pushPermission")}</h3>
            <p className="settings-general-description">{t("settings.pushPermissionDescription")}</p>
            <div className="settings-shell-option">
              <span>{t("settings.pushPermission")}</span>
              <button
                type="button"
                className="config-button config-button-small config-button-secondary"
                disabled={pushRegistering}
                onClick={() => void registerPush()}
              >
                {pushRegistering ? t("settings.pushRegisterLoading") : t("settings.pushRegister")}
              </button>
            </div>
            {pushStatus && (
              <p
                role="status"
                className="settings-general-error"
                style={pushStatus.kind === "ok" ? { color: "var(--accent)" } : undefined}
              >
                {pushStatus.message}
              </p>
            )}
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("common.language")}</h3>
            <div role="radiogroup" aria-label={t("common.language")} className="settings-language-options">
              {supportedLocales.map((plugin) => {
                const selected = locale === plugin.id;
                return (
                  <button
                    key={plugin.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setLocale(plugin.id as typeof locale)}
                    className="settings-language-option"
                  >
                    <span className="settings-language-radio">
                      {selected && <span className="settings-language-radio-dot" />}
                    </span>
                    <span className="settings-language-label">{plugin.label}</span>
                    <span className="settings-language-code">{plugin.id}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <DesktopAppSection />

          {webAuthEnabled && (
            <section className="settings-general-section">
              <ConfigButton variant="secondary" disabled={loggingOut} onClick={() => void logOut()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 17l5-5-5-5M15 12H3M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                </svg>
                {loggingOut ? t("auth.loggingOut") : t("auth.logOut")}
              </ConfigButton>
              {logoutError && <p role="alert" className="settings-general-error">{logoutError}</p>}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

export const SETTINGS_SECTION_ITEMS: { id: SettingsSection; labelKey: string; requiresProject: boolean }[] = [
  { id: "general", labelKey: "settings.general", requiresProject: false },
  { id: "models", labelKey: "common.models", requiresProject: false },
  { id: "skills", labelKey: "common.skills", requiresProject: true },
  { id: "agents", labelKey: "common.agents", requiresProject: true },
  { id: "plugins", labelKey: "common.plugins", requiresProject: true },
  { id: "mcp", labelKey: "settings.mcp", requiresProject: false },
];

export function SettingsPanel({
  cwd,
  sessionId,
  initialSection,
  onClose,
  onSessionReloaded,
  quoteSelectionEnabled,
  onQuoteSelectionChange,
  projectTrust,
  onOpenTrustDialog,
  onProjectTrustChanged,
}: Props) {
  const { t } = useI18n();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [mountedSections, setMountedSections] = useState<ReadonlySet<SettingsSection>>(
    () => new Set([section]),
  );
  // Which sections need a project is decided once, in lib/settings-navigation.ts.
  const sections: { id: SettingsSection; label: string; requiresProject: boolean }[] = SETTINGS_SECTION_ITEMS.map((item) => ({
    id: item.id,
    label: t(item.labelKey),
    requiresProject: settingsSectionRequiresProject(item.id),
  }));
  const sectionRequiresProject = settingsSectionRequiresProject(section);
  // A signed desktop update installs and relaunches the app; the dialog must not
  // be dismissible from under it (the Version & Updates block reports the phase).
  const [busy, setBusy] = useState(false);

  useEffect(() => setLastSettingsSection(initialSection), [initialSection]);

  // Bubble phase, unless something nearer handled the key. The trust dialog,
  // which opens above Settings, takes Escape in the capture phase and stops it,
  // so one Escape closes that dialog and leaves Settings open. A busy update
  // keeps the dialog open with it (see onBusyChange above).
  useEffect(() => listenForPanelEscape(document, () => { if (!busy) onClose(); }), [onClose, busy]);

  // Focus moves into Settings as it opens and back to what had it once it closes. Left
  // on the chat composer (a bare /mcp opens Settings from there), Escape would reach the
  // composer first and stop a running agent, which also kept Settings open. A layout
  // effect, so the opener is read before a section focuses its own search box.
  const dialogRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => focusModalPanel(document, dialogRef.current, {
    restoreTextEntry: !window.matchMedia?.("(pointer: coarse)").matches,
  }), []);

  useEffect(() => {
    if (cwd || !sectionRequiresProject) return;
    setSection("general");
    setMountedSections((current) => new Set(current).add("general"));
    setLastSettingsSection("general");
  }, [cwd, sectionRequiresProject]);

  const activateSection = (nextSection: SettingsSection) => {
    setMountedSections((current) => new Set(current).add(nextSection));
    setSection(nextSection);
    setLastSettingsSection(nextSection);
  };

  const sectionHost = (id: SettingsSection, content: ReactNode) => mountedSections.has(id) ? (
    <div
      key={id}
      hidden={section !== id}
      className="settings-section-host"
    >
      {content}
    </div>
  ) : null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
      tabIndex={-1}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
      className="settings-dialog-backdrop"
    >
      <div className="settings-dialog-surface">
        <div className="settings-dialog-header">
          <strong className="settings-dialog-title">{t("settings.title")}</strong>
          <select
            aria-label={t("settings.title")}
            value={section}
            onChange={(event) => activateSection(event.target.value as SettingsSection)}
            className="settings-mobile-section-picker"
          >
            {sections.map((item) => (
              <option key={item.id} value={item.id} disabled={item.requiresProject && !cwd}>
                {item.label}
              </option>
            ))}
          </select>
          <nav aria-label={t("settings.title")} className="settings-section-tabs">
            {sections.map((item) => {
              const selected = section === item.id;
              const disabled = item.requiresProject && !cwd;
              return (
                <button
                  key={item.id}
                  type="button"
                  className="settings-section-tab"
                  disabled={disabled}
                  title={disabled ? t("settings.projectRequired") : item.label}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => activateSection(item.id)}
                >
                  <SettingsSectionIcon section={item.id} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <button type="button" onClick={onClose} title={t("i18n.close")} aria-label={t("i18n.close")} className="config-close-button settings-dialog-close">×</button>
        </div>

        <main className="settings-dialog-main">
          {sectionHost("general", <GeneralSettings sessionId={sessionId} onSessionReloaded={onSessionReloaded} quoteSelectionEnabled={quoteSelectionEnabled} onQuoteSelectionChange={onQuoteSelectionChange} onBusyChange={setBusy} />)}
          {sectionHost("models", <ModelsConfig embedded cwd={cwd} onClose={onClose} />)}
          {/* Visited sections stay mounted, so the ones whose answer depends on trust take the page's
              status and load again in place when trusting from Settings › MCP changes it. */}
          {cwd && sectionHost("skills", <SkillsConfig embedded key={cwd} cwd={cwd} trust={projectTrust} onClose={onClose} />)}
          {cwd && sectionHost("agents", <AgentsConfig embedded key={cwd} cwd={cwd} sessionId={sessionId} trust={projectTrust} onClose={onClose} onReloaded={onSessionReloaded} />)}
          {cwd && sectionHost("plugins", <PluginsConfig embedded key={cwd} cwd={cwd} sessionId={sessionId} trust={projectTrust} onClose={onClose} onReloaded={onSessionReloaded} />)}
          {/* No project needed: the global mcp.json is listed alone, and a project adds its group. */}
          {sectionHost("mcp", <McpConfig embedded key={cwd ?? ""} cwd={cwd} trust={projectTrust} onTrustProject={onOpenTrustDialog} onProjectTrustChanged={onProjectTrustChanged} onClose={onClose} />)}
        </main>
      </div>
    </div>
  );
}
