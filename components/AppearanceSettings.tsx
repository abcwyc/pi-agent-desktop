"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useBackground } from "@/hooks/useBackground";
import { THEME_OPTIONS } from "@/lib/theme";
import { BACKGROUND_OPTIONS } from "@/lib/backgrounds";
import { isTauriDesktop, openPathNative } from "@/lib/desktop-native";
import { ConfigButton } from "./SettingsUi";
import { ThemeIcon } from "./ThemeIcon";
import { FontSettings } from "./FontSettings";

export function AppearanceSettings() {
  const { t } = useI18n();
  const { preference, setThemePreference } = useTheme();
  const { background, setBackground, error, saving } = useBackground();
  const [customCssBusy, setCustomCssBusy] = useState(false);
  const [customCssError, setCustomCssError] = useState(false);

  const openCustomCss = async () => {
    setCustomCssBusy(true);
    setCustomCssError(false);
    try {
      const response = await fetch("/api/custom-css", { method: "POST" });
      if (!response.ok) throw new Error("Could not open stylesheet");
      const data = await response.json() as { path?: string };
      if (!data.path) throw new Error("Missing stylesheet path");
      await openPathNative(data.path);
    } catch {
      setCustomCssError(true);
    } finally {
      setCustomCssBusy(false);
    }
  };

  return (
    <div className="settings-appearance settings-general">
      <h2 className="settings-general-title">{t("settings.appearance")}</h2>
      <section className="settings-general-section settings-appearance-controls">
        <div className="settings-appearance-mode-row">
          <h3 className="settings-general-heading">{t("settings.colorMode")}</h3>
          <div role="radiogroup" aria-label={t("settings.appearance")} className="settings-theme-options">
            {THEME_OPTIONS.map((option) => (
              <label key={option.id} className="settings-theme-option">
                <input type="radio" name="theme" value={option.id} checked={preference === option.id}
                  onChange={() => setThemePreference(option.id)} className="sr-only" />
                <ThemeIcon preference={option.id} />
                <span className="settings-theme-option-label">{t(option.label)}</span>
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-general-section settings-background-section">
        <h3 className="settings-general-heading" id="settings-background-heading">{t("settings.background")}</h3>
        <div className="settings-background-grid" role="radiogroup" aria-labelledby="settings-background-heading">
          {BACKGROUND_OPTIONS.map((option) => (
            <label key={option.id} className="settings-background-option">
              <input type="radio" name="background" value={option.id} checked={background === option.id}
                onChange={() => setBackground(option.id)} className="sr-only" />
              <span className="settings-background-swatch" data-background-preview={option.id} aria-hidden="true">
                <span className="settings-background-mini-sidebar" />
                <span className="settings-background-mini-card" />
                <span className="settings-background-indicator" />
              </span>
              <span className="settings-background-name">{t(option.label)}</span>
            </label>
          ))}
        </div>
        {saving && <p className="sr-only" role="status">{t("settings.backgroundSaving")}</p>}
        {error && <p className="settings-general-error" role="alert">{t("settings.backgroundSaveError")}
          <ConfigButton variant="secondary" size="small" onClick={() => setBackground(background)}>{t("settings.backgroundRetry")}</ConfigButton>
        </p>}
      </section>

      <FontSettings />

      <section className="settings-general-section">
        <div className="settings-option-list"><div className="settings-option">
          <span className="settings-option-text"><span className="settings-option-title">{t("appSettings.customCss")}</span>
            <span className="settings-option-hint">{t("appSettings.customCssHint")}</span></span>
          {isTauriDesktop() && <ConfigButton variant="secondary" size="small" className="settings-option-action"
            disabled={customCssBusy} onClick={() => void openCustomCss()}>
            {customCssBusy ? t("appSettings.customCssOpening") : t("appSettings.customCssOpen")}
          </ConfigButton>}
        </div></div>
        {customCssError && <p role="alert" className="settings-general-error">{t("appSettings.customCssOpenError")}</p>}
      </section>
    </div>
  );
}
