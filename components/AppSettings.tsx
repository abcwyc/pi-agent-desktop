"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { AppComponentReleaseInfo, AppUpdatesResponse } from "@/lib/app-update-types";
import {
  APP_DISTRIBUTION_NAME,
  APP_RELEASES_URL,
  APP_REPOSITORY,
  APP_REPOSITORY_URL,
  APP_VERSION,
  APP_VERSION_DISPLAY,
  PRODUCT_NAME,
} from "@/lib/branding";
import { compareAppVersions } from "@/lib/app-updates";
import { APP_PREF_KEYS, getPrefBool, setPrefBool } from "@/lib/app-prefs";
import {
  installLatestDesktopRelease,
  isTauriDesktop,
  type DesktopUpgradeProgress,
} from "@/lib/desktop-updater";
import { handleExternalLinkClick, openPathNative, quitAppNative, setCloseQuitsNative } from "@/lib/desktop-native";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";

const sectionCardStyle: CSSProperties = {
  padding: "13px 14px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg)",
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
};

const sectionHintStyle: CSSProperties = {
  marginTop: 3,
  color: "var(--text-muted)",
  fontSize: 11,
  lineHeight: 1.5,
};

function ChoiceButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="native-button"
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        minWidth: 88,
        borderColor: active ? "var(--accent)" : "var(--border)",
        color: active ? "var(--accent)" : "var(--text-muted)",
        fontWeight: active ? 700 : 500,
      }}
    >
      {children}
    </button>
  );
}

const metaChipStyle = (emphasized: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  maxWidth: "100%",
  padding: "6px 9px",
  border: `1px solid ${emphasized ? "var(--accent)" : "var(--border)"}`,
  borderRadius: 7,
  background: emphasized
    ? "color-mix(in srgb, var(--accent) 10%, transparent)"
    : "var(--bg)",
  color: emphasized ? "var(--accent)" : "var(--text-muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: emphasized ? 700 : 500,
  lineHeight: 1.35,
  textDecoration: "none",
});

function MetaChip({
  label,
  value,
  emphasized = false,
  href,
  title,
  ariaLabel,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
  href?: string;
  title?: string;
  ariaLabel?: string;
}) {
  const content = (
    <>
      <span style={{ opacity: 0.72, fontWeight: 500 }}>{label}</span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {value}
      </span>
      {href ? <span aria-hidden="true">↗</span> : null}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={title}
        aria-label={ariaLabel ?? title}
        style={metaChipStyle(emphasized)}
        onClick={(event) => handleExternalLinkClick(event, href)}
      >
        {content}
      </a>
    );
  }

  return (
    <span title={title} aria-label={ariaLabel ?? title} style={metaChipStyle(emphasized)}>
      {content}
    </span>
  );
}

function VersionChip({
  currentValue,
  latestValue,
  versionsMatch,
  updateAvailable,
  href,
  title,
  ariaLabel,
  versionLabel,
  currentLabel,
  latestLabel,
  upgradeAvailableLabel,
}: {
  currentValue: string;
  latestValue: string;
  versionsMatch: boolean;
  updateAvailable: boolean;
  href: string;
  title: string;
  ariaLabel: string;
  versionLabel: string;
  currentLabel: string;
  latestLabel: string;
  upgradeAvailableLabel: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={ariaLabel}
      style={metaChipStyle(updateAvailable)}
      onClick={(event) => handleExternalLinkClick(event, href)}
    >
      {versionsMatch ? (
        <>
          <span style={{ opacity: 0.72, fontWeight: 500 }}>{versionLabel}</span>
          <span>{currentValue}</span>
        </>
      ) : (
        <>
          <span style={{ opacity: 0.72, fontWeight: 500 }}>{currentLabel}</span>
          <span>{currentValue}</span>
          <span aria-hidden="true" style={{ width: 1, height: 13, background: "currentColor", opacity: 0.2 }} />
          <span style={{ opacity: updateAvailable ? 0.9 : 0.72, fontWeight: 500 }}>{latestLabel}</span>
          <span style={{ color: updateAvailable ? "var(--accent)" : undefined, fontWeight: updateAvailable ? 800 : undefined }}>
            {latestValue}
          </span>
          {updateAvailable ? (
            <span
              style={{
                padding: "1px 5px",
                borderRadius: 999,
                background: "var(--accent)",
                color: "var(--bg-panel)",
                fontSize: 9,
                fontWeight: 800,
                whiteSpace: "nowrap",
              }}
            >
              {upgradeAvailableLabel}
            </span>
          ) : null}
        </>
      )}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

export function AppSettings({ onClose }: { onClose: () => void }) {
  const { t, locale, setLocale, supportedLocales } = useI18n();
  const { theme, setTheme } = useTheme();
  const desktop = isTauriDesktop();
  const [components, setComponents] = useState<AppComponentReleaseInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [upgradeProgress, setUpgradeProgress] = useState<DesktopUpgradeProgress | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [closeQuits, setCloseQuits] = useState(() => getPrefBool(APP_PREF_KEYS.closeQuits, false));
  const [notifyOnComplete, setNotifyOnComplete] = useState(() => getPrefBool(APP_PREF_KEYS.notifyOnComplete, true));
  const [customCssBusy, setCustomCssBusy] = useState(false);
  const [customCssError, setCustomCssError] = useState<string | null>(null);

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

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/updates?refresh=1", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<AppUpdatesResponse>;
      })
      .then((data) => {
        const list = Array.isArray(data.components) ? data.components : [];
        setComponents(list);
        setLoadError(null);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError("checkFailed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !upgradeProgress) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, upgradeProgress]);

  const appRelease = useMemo(
    () => components.find((component) => component.project === "pi-agent-desktop"),
    [components],
  );
  const pendingUpdates = useMemo(
    () => components.filter((component) => component.updateAvailable),
    [components],
  );
  const updateAvailable = pendingUpdates.length > 0;
  const canUpgrade = !loading && updateAvailable && !upgradeProgress;
  const downloadPercent = upgradeProgress?.phase === "downloading"
    && upgradeProgress.totalBytes
    ? Math.min(100, Math.round((upgradeProgress.downloadedBytes ?? 0) / upgradeProgress.totalBytes * 100))
    : null;
  const upgradeLabel = upgradeProgress?.phase === "checking"
    ? t("appSettings.preparing")
    : upgradeProgress?.phase === "downloading"
      ? (downloadPercent === null
        ? t("appSettings.downloading")
        : t("appSettings.downloadingPercent", { percent: downloadPercent }))
      : upgradeProgress?.phase === "installing"
        ? t("appSettings.installing")
        : t("appSettings.update");

  const latestReleaseText = loading
    ? "…"
    : loadError
      ? t("appSettings.checkFailed")
      : !appRelease || appRelease.releaseStatus === "unknown"
        ? t("appSettings.releaseUnavailable")
        : appRelease.releaseStatus === "unpublished" || !appRelease.latestVersion
          ? t("appSettings.noReleases")
          : `v${appRelease.latestVersion}`;

  const statusText = loading
    ? t("appSettings.checkingReleases")
    : loadError
      ? t("appSettings.checkFailed")
      : updateAvailable
        ? t("appSettings.updateAvailable")
        : t("appSettings.upToDate");

  const currentVersion = appRelease?.currentVersion ?? APP_VERSION;
  const currentVersionText = `v${currentVersion === APP_VERSION ? APP_VERSION_DISPLAY : currentVersion}`;
  const versionsMatch = Boolean(
    appRelease?.latestVersion
      && compareAppVersions(currentVersion, appRelease.latestVersion) === 0,
  );
  const versionAriaLabel = versionsMatch
    ? `${t("appSettings.version")}: ${currentVersionText}. ${statusText}`
    : `${t("appSettings.currentVersion")}: ${currentVersionText}. ${t("appSettings.latestRelease")}: ${latestReleaseText}. ${statusText}`;

  const handleUpgrade = async () => {
    if (!canUpgrade) return;
    setUpgradeError(null);
    try {
      const result = await installLatestDesktopRelease(setUpgradeProgress);
      if (!result.installed) {
        setUpgradeProgress(null);
        setUpgradeError(t("appSettings.noSignedBundle", { name: APP_DISTRIBUTION_NAME }));
      }
    } catch (error) {
      setUpgradeProgress(null);
      setUpgradeError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div
      className="native-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !upgradeProgress) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
        background: "rgba(0,0,0,0.4)",
      }}
    >
      <section
        className="native-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        style={{
          width: "min(620px, 100%)",
          maxHeight: "min(720px, calc(100vh - 36px))",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: "1px solid var(--border)",
          borderRadius: 12,
          background: "var(--bg-panel)",
          color: "var(--text)",
          boxShadow: "0 22px 70px rgba(0,0,0,0.32)",
        }}
      >
        <header className="native-modal-header" style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "20px 22px 17px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="native-modal-title" id="app-settings-title" style={{ margin: 0, fontSize: 18, lineHeight: 1.25 }}>
              {PRODUCT_NAME}
            </h2>
            <div style={{ marginTop: 5, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
              {t("appSettings.tagline", { product: PRODUCT_NAME })}
              <br />
              {t("appSettings.taglineDetails")}
            </div>
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
              <MetaChip
                label={t("appSettings.repository")}
                value={APP_REPOSITORY}
                href={APP_REPOSITORY_URL}
                title={t("appSettings.openRepository")}
                ariaLabel={`${t("appSettings.repository")}: ${APP_REPOSITORY}`}
              />
              <VersionChip
                currentValue={currentVersionText}
                latestValue={latestReleaseText}
                versionsMatch={versionsMatch}
                updateAvailable={updateAvailable}
                href={appRelease?.releaseUrl ?? APP_RELEASES_URL}
                title={statusText}
                ariaLabel={versionAriaLabel}
                versionLabel={t("appSettings.version")}
                currentLabel={t("appSettings.currentVersion")}
                latestLabel={t("appSettings.latestRelease")}
                upgradeAvailableLabel={t("appSettings.upgradeAvailable")}
              />
              {(updateAvailable || upgradeProgress) && (
                <button
                  className="native-button native-button-primary"
                  type="button"
                  disabled={!canUpgrade}
                  onClick={() => void handleUpgrade()}
                  style={{ minWidth: 112 }}
                >
                  {upgradeLabel}
                </button>
              )}
            </div>
            {upgradeError && (
              <div className="native-inline-alert is-error" role="alert" style={{ marginTop: 9 }}>
                {upgradeError}
              </div>
            )}
          </div>
          <button
            className="native-modal-close"
            type="button"
            onClick={onClose}
            disabled={Boolean(upgradeProgress)}
            aria-label={t("appSettings.close")}
            title={t("appSettings.close")}
            style={{ padding: "1px 5px", border: 0, background: "transparent", color: "var(--text-muted)", cursor: upgradeProgress ? "default" : "pointer", fontSize: 21, lineHeight: 1, opacity: upgradeProgress ? 0.35 : 1 }}
          >
            ×
          </button>
        </header>

        <div style={{ overflowY: "auto", padding: "18px 22px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="native-settings-card" style={sectionCardStyle}>
            <div style={sectionTitleStyle}>{t("appSettings.languageSection")}</div>
            <div style={sectionHintStyle}>{t("appSettings.languageHint")}</div>
            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {supportedLocales.map((plugin) => (
                <ChoiceButton
                  key={plugin.id}
                  active={locale === plugin.id}
                  onClick={() => setLocale(plugin.id as typeof locale)}
                >
                  {plugin.label}
                </ChoiceButton>
              ))}
            </div>
          </div>

          <div className="native-settings-card" style={sectionCardStyle}>
            <div style={sectionTitleStyle}>{t("appSettings.appearanceSection")}</div>
            <div style={sectionHintStyle}>{t("appSettings.appearanceHint")}</div>
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <ChoiceButton active={theme === "light"} onClick={() => setTheme("light")}>
                {t("appSettings.themeLight")}
              </ChoiceButton>
              <ChoiceButton active={theme === "dark"} onClick={() => setTheme("dark")}>
                {t("appSettings.themeDark")}
              </ChoiceButton>
            </div>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{t("appSettings.customCss")}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45 }}>
                {t("appSettings.customCssHint")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {desktop ? (
                  <button
                    type="button"
                    className="native-button"
                    disabled={customCssBusy}
                    onClick={() => void openCustomCss()}
                    style={{ alignSelf: "flex-start", marginTop: 2 }}
                  >
                    {customCssBusy ? t("appSettings.customCssOpening") : t("appSettings.customCssOpen")}
                  </button>
                ) : null}
                {customCssError ? (
                  <span style={{ color: "var(--danger)", fontSize: 11 }}>{customCssError}</span>
                ) : null}
              </div>
            </div>
          </div>

          {desktop && (
            <div className="native-settings-card" style={sectionCardStyle}>
              <div style={sectionTitleStyle}>{t("appSettings.desktopSection")}</div>
              <div style={sectionHintStyle}>{t("appSettings.desktopHint")}</div>
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={closeQuits}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setCloseQuits(next);
                      setPrefBool(APP_PREF_KEYS.closeQuits, next);
                      void setCloseQuitsNative(next);
                    }}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{t("appSettings.closeQuits")}</div>
                    <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45 }}>
                      {t("appSettings.closeQuitsHint")}
                    </div>
                  </span>
                </label>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={notifyOnComplete}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setNotifyOnComplete(next);
                      setPrefBool(APP_PREF_KEYS.notifyOnComplete, next);
                    }}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{t("appSettings.notifyOnComplete")}</div>
                    <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45 }}>
                      {t("appSettings.notifyOnCompleteHint")}
                    </div>
                  </span>
                </label>
                <button
                  type="button"
                  className="native-button"
                  onClick={() => void quitAppNative()}
                  style={{ alignSelf: "flex-start", marginTop: 2 }}
                >
                  {t("appSettings.quitApp")}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
