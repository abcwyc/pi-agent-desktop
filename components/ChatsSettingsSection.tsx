"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AppSelect } from "./AppSelect";
import { ConfigSwitch } from "./SettingsUi";
import { CHAT_THINKING_LEVELS, parseToolNameList, type ChatSettings } from "@/lib/chat-settings-shared";

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
  const [toolsDraft, setToolsDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const toolsDraftRef = useRef(toolsDraft);
  toolsDraftRef.current = toolsDraft;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/chat-settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: Loaded) => {
        if (cancelled) return;
        setSettings(data);
        setDraft(data.instructions);
        setToolsDraft(data.allowedTools.join("\n"));
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

  const save = useCallback((patch: Partial<Pick<ChatSettings, "model" | "thinkingLevel" | "instructions" | "allowedTools" | "confirmSave">>) => {
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
        if ("allowedTools" in patch) setToolsDraft(data.allowedTools.join("\n"));
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
  const toolsDirty = settings !== null
    && parseToolNameList(toolsDraft).join("\n") !== settings.allowedTools.join("\n");

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.chats")}</h3>
      <div className="settings-chat-options">
        <div className="settings-chat-option settings-chats-field">
          <label htmlFor="settings-chats-model">{t("settings.chatsModel")}</label>
          <AppSelect
            id="settings-chats-model"
            className="settings-chats-control"
            aria-label={t("settings.chatsModel")}
            value={modelValue}
            disabled={settings === null || saving}
            onValueChange={(value) => {
              const [provider, modelId] = value.split("\u0000");
              void save({ model: provider && modelId ? { provider, modelId } : null });
            }}
            options={[
              { value: "", label: t("settings.chatsFollowDefault") },
              ...(!selectedKnown && settings?.model
                ? [{ value: modelValue, label: `${settings.model.provider}/${settings.model.modelId}` }]
                : []),
              ...models.map((model) => ({
                value: `${model.provider}\u0000${model.id}`,
                label: `${model.name || model.id} · ${model.provider}`,
              })),
            ]}
          />
        </div>
        <div className="settings-chat-option settings-chats-field">
          <label htmlFor="settings-chats-thinking">{t("settings.chatsThinking")}</label>
          <AppSelect
            id="settings-chats-thinking"
            className="settings-chats-control"
            aria-label={t("settings.chatsThinking")}
            value={settings?.thinkingLevel ?? ""}
            disabled={settings === null || saving}
            onValueChange={(value) => void save({ thinkingLevel: value ? value as ChatSettings["thinkingLevel"] : null })}
            options={[
              { value: "", label: t("settings.chatsFollowDefault") },
              ...CHAT_THINKING_LEVELS.map((level) => ({ value: level, label: t(THINKING_LABEL_KEYS[level]) })),
            ]}
          />
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
        <div className="settings-chat-option settings-chats-field settings-chats-tools">
          <label htmlFor="settings-chats-tools">{t("settings.chatsTools")}</label>
          <textarea
            id="settings-chats-tools"
            className="settings-chats-control"
            rows={3}
            value={toolsDraft}
            disabled={settings === null}
            aria-describedby={`${hintId}-tools`}
            placeholder={t("settings.chatsToolsPlaceholder")}
            spellCheck={false}
            onChange={(event) => setToolsDraft(event.target.value)}
            onBlur={() => { if (toolsDirty) void save({ allowedTools: parseToolNameList(toolsDraftRef.current) }); }}
          />
          <span id={`${hintId}-tools`} className="settings-chats-hint">{t("settings.chatsToolsHint")}</span>
        </div>
        <div className="settings-chat-option settings-chat-switch-option">
          <span>{t("settings.chatsConfirmSave")}</span>
          <ConfigSwitch
            checked={settings?.confirmSave ?? false}
            label={t("settings.chatsConfirmSave")}
            disabled={settings === null || saving}
            onChange={(enabled) => void save({ confirmSave: enabled })}
          />
        </div>
      </div>
    </section>
  );
}
