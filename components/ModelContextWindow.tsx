"use client";

import { useI18n } from "@/hooks/useI18n";
import { parseContextWindow } from "@/lib/model-context";

export interface ModelContextSettings {
  overrides?: Record<string, unknown>;
  disabled: boolean;
  onChange: (modelId: string, value: string | undefined) => void;
}

/**
 * Like custom-model fields, this edits the Models panel's draft, not the file.
 * Blank means no override; the placeholder is the window pi resolves now.
 */
export function ModelContextWindow({ modelName, effective, value, onChange, disabled = false, describedBy }: {
  modelName: string;
  effective?: number;
  value: unknown;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const { t } = useI18n();
  const invalid = value !== undefined && parseContextWindow(value) === undefined;
  return (
    <input
      type="text"
      inputMode="numeric"
      className="model-context-input"
      value={value === undefined ? "" : String(value)}
      placeholder={effective === undefined ? undefined : String(effective)}
      title={t("models.contextWindow")}
      aria-label={t("models.contextForModel", { model: modelName })}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value.trim() === "" ? undefined : event.target.value)}
    />
  );
}
