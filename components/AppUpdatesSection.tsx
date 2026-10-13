"use client";

import { useEffect, useMemo, useState } from "react";
import type { AppComponentReleaseInfo, AppUpdatesResponse } from "@/lib/app-update-types";
import {
  APP_DISTRIBUTION_NAME,
  APP_RELEASES_URL,
  APP_VERSION,
  APP_VERSION_DISPLAY,
} from "@/lib/branding";
import { handleExternalLinkClick } from "@/lib/desktop-native";
import { isTauriDesktop, installLatestDesktopRelease, type DesktopUpgradeProgress } from "@/lib/desktop-updater";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";

interface Props {
  /** Lets the host settings dialog stay up while a signed update is installing. */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * "Version & Updates" for the packaged desktop distribution.
 *
 * Lives at the top of the General settings tab: the update check is the one
 * piece of the old standalone app-info panel a user actually comes back for,
 * and General is where the rest of the app-wide preferences already sit.
 */
export function AppUpdatesSection({ onBusyChange }: Props) {
  const { t } = useI18n();
  const [components, setComponents] = useState<AppComponentReleaseInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(isTauriDesktop()), []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [upgradeProgress, setUpgradeProgress] = useState<DesktopUpgradeProgress | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/updates?refresh=1", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<AppUpdatesResponse>;
      })
      .then((data) => {
        setComponents(Array.isArray(data.components) ? data.components : []);
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

  const busy = Boolean(upgradeProgress);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => {
      if (busy) onBusyChange?.(false);
    };
  }, [busy, onBusyChange]);

  const appRelease = useMemo(
    () => components.find((component) => component.project === "pi-agent-desktop"),
    [components],
  );
  const updateAvailable = useMemo(
    () => components.some((component) => component.updateAvailable),
    [components],
  );
  const canUpgrade = desktop && !loading && updateAvailable && !upgradeProgress;
  const downloadPercent = upgradeProgress?.phase === "downloading" && upgradeProgress.totalBytes
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
  const releaseUrl = appRelease?.releaseUrl ?? null;
  const releaseHref = releaseUrl ?? APP_RELEASES_URL;
  const hasLatest = !loading && !loadError && Boolean(appRelease?.latestVersion)
    && appRelease?.releaseStatus !== "unknown" && appRelease?.releaseStatus !== "unpublished";

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
    <section className="settings-general-section settings-updates">
      <h3 className="settings-general-heading">{t("appSettings.updatesSection")}</h3>
      <div className="settings-update-card">
        <dl className="settings-update-versions">
          <div className="settings-update-row">
            <dt>{t("appSettings.currentVersion")}</dt>
            <dd>{currentVersionText}</dd>
          </div>
          <div className="settings-update-row">
            <dt>{t("appSettings.latestRelease")}</dt>
            <dd className={updateAvailable ? "is-latest" : undefined}>
              {!hasLatest ? (
                latestReleaseText
              ) : (
                <a
                  href={releaseHref}
                  target="_blank"
                  rel="noreferrer"
                  title={t("appSettings.openRelease")}
                  onClick={(event) => handleExternalLinkClick(event, releaseHref)}
                >
                  {latestReleaseText} <span aria-hidden="true">↗</span>
                </a>
              )}
              {updateAvailable && <span className="settings-update-badge">{t("appSettings.upgradeAvailable")}</span>}
            </dd>
          </div>
        </dl>
        <div className="settings-update-side">
          <span className="settings-update-status" role="status">{desktop ? statusText : t("appSettings.serverManaged")}</span>
          {desktop && (updateAvailable || upgradeProgress) && (
            <ConfigButton variant="primary" disabled={!canUpgrade} onClick={() => void handleUpgrade()}>
              {upgradeLabel}
            </ConfigButton>
          )}
        </div>
      </div>
      {updateAvailable && (
        <p className="settings-general-description settings-updates-note">
          {t("appSettings.updateNote", { name: APP_DISTRIBUTION_NAME })}
        </p>
      )}
      {upgradeError && (
        <p role="alert" className="settings-general-error">
          {upgradeError}
          {releaseUrl && (
            <a
              className="settings-updates-release-link"
              href={releaseUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => handleExternalLinkClick(event, releaseUrl)}
            >
              {t("appSettings.openRelease")}
            </a>
          )}
        </p>
      )}
    </section>
  );
}
