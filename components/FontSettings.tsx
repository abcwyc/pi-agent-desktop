"use client";

import { useEffect, useId, useState } from "react";
import { useFonts } from "@/hooks/useFonts";
import { useI18n } from "@/hooks/useI18n";
import { DEFAULT_FONTS, isFontFamily, MONO_FONT_OPTIONS, UI_FONT_OPTIONS } from "@/lib/font-preferences";
import { isImeComposing } from "@/lib/ime";
import { isTauriDesktop, listInstalledFontsNative } from "@/lib/desktop-native";
import { installedFontLabel, type InstalledFont } from "@/lib/installed-fonts";
import { AppSelect } from "./AppSelect";
import { ConfigButton } from "./SettingsUi";

function FontChoice({ value, kind, installed, onChange }: { value: string; kind: "ui" | "mono"; installed: InstalledFont[] | null; onChange: (font: string) => void }) {
  const { t, locale } = useI18n();
  const id = useId();
  const families = (installed ?? (kind === "ui" ? UI_FONT_OPTIONS : MONO_FONT_OPTIONS).map((family) => ({ family })))
    .map((font) => ({ value: font.family, label: installedFontLabel(font, locale) }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  const [custom, setCustom] = useState(false);
  const customValue = `custom:${id}`;
  const [draft, setDraft] = useState(value);
  const [previousValue, setPreviousValue] = useState(value);
  if (value !== previousValue) {
    setPreviousValue(value);
    setDraft(value);
    setCustom(false);
  }
  const label = t(kind === "ui" ? "settings.fontUi" : "settings.fontMono");
  const valid = isFontFamily(draft.trim()) && draft.trim().length > 0;
  const apply = () => { if (valid) onChange(draft.trim()); };

  return (
    <div className="settings-option settings-font-option">
      <span className="settings-option-text" id={`${id}-description`}>
        <span className="settings-option-title">{label}</span>
        <span className="settings-option-hint">{t(kind === "ui" ? "settings.fontUiHint" : "settings.fontMonoHint")}</span>
      </span>
      <div className="settings-font-control">
        <AppSelect aria-label={label} aria-describedby={`${id}-description`} value={custom ? customValue : value}
          onValueChange={(font) => {
            if (font === customValue) { setCustom(true); setDraft(value); }
            else { setCustom(false); onChange(font); }
          }}
          options={[
            { value: "", label: t("settings.fontDefault") },
            // Keep a saved family visible while the system list is loading,
            // without temporarily expanding a manual input and moving the page.
            ...(value && !families.some((font) => font.value === value) ? [{ value, label: value }] : []),
            ...families,
            { value: customValue, label: t("settings.fontCustom") },
          ]} />
        {custom && <div className="settings-font-custom">
          <input aria-label={t("settings.fontName", { kind: label })} value={draft} maxLength={120}
            aria-invalid={draft.length > 0 && !valid} placeholder={t("settings.fontNamePlaceholder")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !isImeComposing(event)) { event.preventDefault(); event.stopPropagation(); apply(); }
            }} />
          <ConfigButton variant="secondary" size="small" disabled={!valid || draft.trim() === value} onClick={apply}>
            {t("settings.fontApply")}
          </ConfigButton>
        </div>}
      </div>
    </div>
  );
}

export function FontSettings() {
  const { t } = useI18n();
  const { fonts, setFonts, saving, error, retry } = useFonts();
  const [installed, setInstalled] = useState<InstalledFont[] | null>(null);
  const [fontListError, setFontListError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!isTauriDesktop()) return;
    let active = true;
    listInstalledFontsNative().then((fonts) => {
      if (active) { setInstalled(fonts); setFontListError(false); }
    }).catch(() => { if (active) setFontListError(true); });
    return () => { active = false; };
  }, [reload]);
  return (
    <section className="settings-general-section settings-font-section" aria-labelledby="settings-font-heading">
      <div className="settings-font-heading-row">
        <h3 className="settings-general-heading" id="settings-font-heading">{t("settings.fonts")}</h3>
        {(fonts.ui || fonts.mono) && <ConfigButton variant="ghost" size="small" onClick={() => setFonts(DEFAULT_FONTS)}>
          {t("settings.fontReset")}
        </ConfigButton>}
      </div>
      <p className="settings-general-description">{t("settings.fontsHint")}</p>
      <div className="settings-option-list">
        <FontChoice kind="ui" installed={installed} value={fonts.ui} onChange={(ui) => setFonts({ ...fonts, ui })} />
        <FontChoice kind="mono" installed={installed} value={fonts.mono} onChange={(mono) => setFonts({ ...fonts, mono })} />
        <div className="settings-font-preview" aria-label={t("settings.fontPreview")}>
          <p>{t("settings.fontPreviewText")}</p>
          <code>{'const message = "Hello, Pi"; // 0123456789'}</code>
        </div>
      </div>
      {saving && <p className="settings-font-status sr-only" role="status">{t("settings.fontSaving")}</p>}
      {fontListError && <div className="settings-font-status settings-general-error" role="alert">
        <span>{t("settings.fontListError")}</span>
        <ConfigButton variant="secondary" size="small" onClick={() => setReload((value) => value + 1)}>{t("settings.backgroundRetry")}</ConfigButton>
      </div>}
      {error && <div className="settings-font-status settings-general-error" role="alert">
        <span>{t(error === "load" ? "settings.fontLoadError" : "settings.fontSaveError")}</span>
        <ConfigButton variant="secondary" size="small" onClick={retry}>{t("settings.backgroundRetry")}</ConfigButton>
      </div>}
    </section>
  );
}
