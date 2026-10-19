"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { CHAT_THINKING_LEVELS, type ChatSettings } from "@/lib/chat-settings-shared";

type Loaded = ChatSettings & { instructionsMaxChars: number };
type ModelOption = { id: string; name: string; provider: string };

const THINKING_LABEL_KEYS: Record<string, string> = {
  off: "chat.thinkingOff", minimal: "chat.thinkingMinimal", low: "chat.thinkingLow",
  medium: "chat.thinkingMedium", high: "chat.thinkingHigh", xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};

/**
 * Settings › General › Chats: what a brand-new chat starts with, and the user's own
 * instructions for every chat. Unset model or reasoning means "follow the global default".
 */
export function ChatsSettingsSection() {
  const { t } = useI18n();
  const hintId = useId();
  const [settings, setSettings] = useState<Loaded | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/chat-settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: Loaded) => {
        if (cancelled) return;
        setSettings(data);
        setDraft(data.instructions);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    // The model list is scoped by the same enabled-models setting a chat starts from.
    fetch("/api/chat-workspace", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { cwd?: string }) => fetch(`/api/models?cwd=${encodeURIComponent(data.cwd ?? "")}`, { cache: "no-store" }))
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { modelList?: ModelOption[] }) => { if (!cancelled) setModels(data.modelList ?? []); })
      .catch(() => { /* the picker then offers only the global default */ });
    return () => { cancelled = true; };
  }, []);

  const save = useCallback((patch: Partial<Pick<ChatSettings, "model" | "thinkingLevel" | "instructions">>) => {
    setSaving(true);
    setFailed(false);
    return fetch("/api/chat-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: Loaded) => {
        setSettings(data);
        if ("instructions" in patch) setDraft(data.instructions);
      })
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  }, []);

  const modelValue = settings?.model ? `${settings.model.provider}\u0000${settings.model.modelId}` : "";
  const selectedKnown = !settings?.model || models.some((model) => (
    model.provider === settings.model?.provider && model.id === settings.model?.modelId
  ));
  const maxChars = settings?.instructionsMaxChars ?? 8000;
  const dirty = settings !== null && draft !== settings.instructions;

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.chats")}</h3>
      <div className="settings-chat-options">
        <div className="settings-chat-option settings-chats-field">
          <label htmlFor="settings-chats-model">{t("settings.chatsModel")}</label>
          <select
            id="settings-chats-model"
            className="settings-chats-control"
            value={modelValue}
            disabled={settings === null || saving}
            onChange={(event) => {
              const [provider, modelId] = event.target.value.split("\u0000");
              void save({ model: provider && modelId ? { provider, modelId } : null });
            }}
          >
            <option value="">{t("settings.chatsFollowDefault")}</option>
            {!selectedKnown && settings?.model && (
              <option value={modelValue}>{`${settings.model.provider}/${settings.model.modelId}`}</option>
            )}
            {models.map((model) => (
              <option key={`${model.provider}\u0000${model.id}`} value={`${model.provider}\u0000${model.id}`}>
                {model.name || model.id} · {model.provider}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-chat-option settings-chats-field">
          <label htmlFor="settings-chats-thinking">{t("settings.chatsThinking")}</label>
          <select
            id="settings-chats-thinking"
            className="settings-chats-control"
            value={settings?.thinkingLevel ?? ""}
            disabled={settings === null || saving}
            onChange={(event) => {
              const value = event.target.value;
              void save({ thinkingLevel: value ? value as ChatSettings["thinkingLevel"] : null });
            }}
          >
            <option value="">{t("settings.chatsFollowDefault")}</option>
            {CHAT_THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>{t(THINKING_LABEL_KEYS[level])}</option>
            ))}
          </select>
        </div>
        <div className="settings-chat-option settings-chats-field settings-chats-instructions">
          <label htmlFor="settings-chats-instructions">{t("settings.chatsInstructions")}</label>
          <textarea
            id="settings-chats-instructions"
            className="settings-chats-control"
            rows={5}
            maxLength={maxChars}
            value={draft}
            disabled={settings === null}
            aria-describedby={hintId}
            placeholder={t("settings.chatsInstructionsPlaceholder")}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => { if (dirty) void save({ instructions: draftRef.current }); }}
          />
          <span id={hintId} className="settings-chats-hint" role={failed ? "alert" : undefined}>
            {failed
              ? t("settings.chatsFailed")
              : saving ? t("i18n.saving") : t("settings.chatsInstructionsHint", { count: draft.length, max: maxChars })}
          </span>
        </div>
      </div>
    </section>
  );
}
