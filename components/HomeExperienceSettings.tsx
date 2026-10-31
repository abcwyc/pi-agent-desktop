"use client";
import { useI18n } from "@/hooks/useI18n";
import { useHomeExperience } from "@/hooks/useHomeExperience";
import { ConfigSwitch } from "./SettingsUi";

export function HomeExperienceSettings() {
  const { t } = useI18n();
  const { mascot, dashboard, setOption } = useHomeExperience();
  return <section className="settings-general-section">
    <h3 className="settings-general-heading">{t("home.appearance")}</h3>
    <div className="settings-option-list">
      {(["homeMascot", "homeDashboard"] as const).map((key) => <div className="settings-option" key={key}>
        <span className="settings-option-text">
          <span className="settings-option-title">{t("home." + key)}</span>
          <span className="settings-option-hint">{t("home." + key + "Hint")}</span>
        </span>
        <ConfigSwitch label={t("home." + key)} checked={key === "homeMascot" ? mascot : dashboard}
          onChange={(value) => setOption(key, value)} />
      </div>)}
    </div>
  </section>;
}
