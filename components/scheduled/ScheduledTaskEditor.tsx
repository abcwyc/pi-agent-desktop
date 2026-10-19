"use client";

import { AppSelect } from "../AppSelect";
import { AppCombobox } from "../AppCombobox";

import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { apiErrorText, scheduledApi, type CronPreview, type TaskInput } from "@/lib/scheduled-tasks/client";
import {
  DEFAULT_PRESET,
  cronFromPreset,
  formatClock,
  parseClock,
  presetFromCron,
  type SchedulePreset,
} from "@/lib/scheduled-tasks/schedule-presets";
import { DEFAULT_MAX_DURATION_MINUTES, MAX_DURATION_MINUTES, type ScheduledTaskView } from "@/lib/scheduled-tasks/types";
import { TOOL_PRESET_KEYS, canWrite, formatDateTime, fromLocalInputValue, toLocalInputValue } from "./scheduled-helpers";

type ScheduleKind = SchedulePreset | "manual" | "once" | "custom";
type ToolPreset = ScheduledTaskView["toolPreset"];

interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

export interface EditorProps {
  /** The task being edited, or null to create one. */
  task: ScheduledTaskView | null;
  projectRoots: string[];
  defaultCwd: string | null;
  /** Native folder picker, offered in the desktop app. */
  onBrowseFolder?: () => Promise<string | null>;
  onSaved: (task: ScheduledTaskView) => void;
  onCancel: () => void;
}

interface FormState {
  name: string;
  description: string;
  prompt: string;
  cwd: string;
  kind: ScheduleKind;
  time: string;
  minute: number;
  weekday: number;
  onceAt: string;
  cron: string;
  model: string;
  thinking: string;
  toolPreset: ToolPreset;
  maxDurationMin: number;
  acknowledged: boolean;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TOOL_PRESETS: ToolPreset[] = ["read-only", "none", "default", "full"];
const SCHEDULE_KINDS: ScheduleKind[] = ["daily", "weekdays", "weekly", "hourly", "once", "custom", "manual"];

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function modelKey(model: { provider: string; modelId: string } | undefined): string {
  return model ? JSON.stringify([model.provider, model.modelId]) : "";
}

function initialState(task: ScheduledTaskView | null, defaultCwd: string | null): FormState {
  const base: FormState = {
    name: "",
    description: "",
    prompt: "",
    cwd: defaultCwd ?? "",
    kind: "daily",
    time: formatClock(DEFAULT_PRESET.hour, DEFAULT_PRESET.minute),
    minute: DEFAULT_PRESET.minute,
    weekday: DEFAULT_PRESET.weekday,
    onceAt: "",
    cron: "",
    model: "",
    thinking: "",
    toolPreset: "read-only",
    maxDurationMin: DEFAULT_MAX_DURATION_MINUTES,
    acknowledged: false,
  };
  if (!task) return base;

  const state: FormState = {
    ...base,
    name: task.name,
    description: task.description ?? "",
    prompt: task.prompt,
    cwd: task.cwd,
    model: modelKey(task.model),
    thinking: task.thinkingLevel ?? "",
    toolPreset: task.toolPreset,
    maxDurationMin: task.maxDurationMin,
  };
  const schedule = task.schedule;
  if (schedule.kind === "manual") return { ...state, kind: "manual" };
  if (schedule.kind === "once") return { ...state, kind: "once", onceAt: toLocalInputValue(schedule.at) };
  const spec = presetFromCron(schedule.expr);
  if (!spec) return { ...state, kind: "custom", cron: schedule.expr };
  return {
    ...state,
    kind: spec.preset,
    time: formatClock(spec.hour, spec.minute),
    minute: spec.minute,
    weekday: spec.weekday,
    cron: schedule.expr,
  };
}

/** The cron expression the form currently stands for, or null for non-cron schedules. */
function cronOf(form: FormState): string | null {
  if (form.kind === "manual" || form.kind === "once") return null;
  if (form.kind === "custom") return form.cron.trim() || null;
  const clock = parseClock(form.time);
  if (form.kind !== "hourly" && !clock) return null;
  return cronFromPreset({
    preset: form.kind,
    hour: clock?.hour ?? 0,
    minute: form.kind === "hourly" ? form.minute : clock?.minute ?? 0,
    weekday: form.weekday,
  });
}

function buildInput(form: FormState, timezone: string, original: ScheduledTaskView | null): TaskInput {
  let schedule: TaskInput["schedule"];
  if (form.kind === "manual") schedule = { kind: "manual" };
  else if (form.kind === "once") schedule = { kind: "once", at: fromLocalInputValue(form.onceAt) ?? form.onceAt };
  else schedule = { kind: "cron", expr: cronOf(form) ?? "", timezone };

  let model: TaskInput["model"] = null;
  if (form.model) {
    const [provider, modelId] = JSON.parse(form.model) as [string, string];
    model = { provider, modelId };
  }
  const input: TaskInput = {
    name: form.name.trim(),
    description: form.description.trim() || null,
    prompt: form.prompt,
    cwd: form.cwd.trim(),
    schedule,
    model,
    thinkingLevel: form.thinking || null,
    toolPreset: form.toolPreset,
    maxDurationMin: form.maxDurationMin,
  };
  if (canWrite(form.toolPreset) && (!original || original.toolPreset !== form.toolPreset)) {
    input.acknowledgeUnattendedWrites = form.acknowledged;
  }
  return input;
}

/**
 * The models selectable for a folder. The list depends on the folder (project
 * extensions can add providers) and /api/models only answers for folders it
 * knows, so a path that is still being typed simply keeps the previous list.
 */
function useModelOptions(cwd: string): ModelOption[] {
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    if (!cwd.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/models?cwd=${encodeURIComponent(cwd.trim())}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { modelList?: ModelOption[] } | null) => {
          if (!cancelled && data?.modelList) setModels(data.modelList);
        })
        .catch(() => undefined);
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [cwd]);
  return models;
}

/**
 * Whether the folder has project extensions or MCP servers that are not trusted yet.
 * A run cannot ask, so it simply starts without them; the form says so up front.
 */
function useUntrustedProject(cwd: string): boolean {
  const [untrusted, setUntrusted] = useState(false);
  useEffect(() => {
    if (!cwd.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/project-trust?cwd=${encodeURIComponent(cwd.trim())}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((status: { requiresTrust?: boolean; trusted?: boolean } | null) => {
          if (!cancelled) setUntrusted(Boolean(status?.requiresTrust && !status.trusted));
        })
        .catch(() => { if (!cancelled) setUntrusted(false); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [cwd]);
  return untrusted && Boolean(cwd.trim());
}

export function ScheduledTaskEditor({ task, projectRoots, defaultCwd, onBrowseFolder, onSaved, onCancel }: EditorProps) {
  const { t, locale } = useI18n();
  const ids = useId();
  const [form, setForm] = useState(() => initialState(task, defaultCwd));
  const models = useModelOptions(form.cwd);
  const untrustedProject = useUntrustedProject(form.cwd);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CronPreview | null>(null);

  const timezone = task?.schedule.kind === "cron" ? task.schedule.timezone : browserTimezone();
  const expr = cronOf(form);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  // A live look at the upcoming runs, checked by the same code that will accept the task.
  useEffect(() => {
    if (!expr) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      scheduledApi.preview(expr, timezone)
        .then((result) => { if (!cancelled) setPreview(result); })
        .catch(() => { if (!cancelled) setPreview(null); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [expr, timezone]);
  const shownPreview = expr ? preview : null;

  const needsAck = canWrite(form.toolPreset) && (!task || task.toolPreset !== form.toolPreset);
  const missing = useMemo(() => {
    if (!form.name.trim() || !form.prompt.trim() || !form.cwd.trim()) return true;
    if (form.kind === "once" && !fromLocalInputValue(form.onceAt)) return true;
    if (form.kind === "custom" && !form.cron.trim()) return true;
    if (form.kind !== "manual" && form.kind !== "once" && form.kind !== "custom" && form.kind !== "hourly" && !parseClock(form.time)) return true;
    return needsAck && !form.acknowledged;
  }, [form, needsAck]);
  const scheduleInvalid = Boolean(expr && shownPreview && !shownPreview.valid);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || missing || scheduleInvalid) return;
    setSaving(true);
    setError(null);
    try {
      const input = buildInput(form, timezone, task);
      const { task: saved } = task ? await scheduledApi.update(task.id, input) : await scheduledApi.create(input);
      onSaved(saved);
    } catch (caught) {
      setError(apiErrorText(caught, t));
      setSaving(false);
    }
  }

  async function browse() {
    const picked = await onBrowseFolder?.();
    if (picked) set("cwd", picked);
  }

  const weekdays = Array.from({ length: 7 }, (_, index) => ({
    value: index,
    label: new Intl.DateTimeFormat(locale, { weekday: "long" }).format(new Date(2026, 9, 4 + index)),
  }));

  return (
    <form className="scheduled-form" onSubmit={submit} noValidate>
      <div className="scheduled-field">
        <label htmlFor={`${ids}-name`}>{t("scheduled.field.name")}</label>
        <input id={`${ids}-name`} className="scheduled-input" value={form.name} maxLength={120} autoFocus onChange={(e) => set("name", e.target.value)} />
      </div>

      <div className="scheduled-field">
        <label htmlFor={`${ids}-desc`}>{t("scheduled.field.description")}</label>
        <input id={`${ids}-desc`} className="scheduled-input" value={form.description} onChange={(e) => set("description", e.target.value)} />
      </div>

      <div className="scheduled-field">
        <label htmlFor={`${ids}-prompt`}>{t("scheduled.field.prompt")}</label>
        <textarea id={`${ids}-prompt`} className="scheduled-input scheduled-textarea" rows={8} value={form.prompt} onChange={(e) => set("prompt", e.target.value)} aria-describedby={`${ids}-prompt-hint`} />
        <p id={`${ids}-prompt-hint`} className="scheduled-hint">{t("scheduled.field.promptHint")}</p>
      </div>

      <div className="scheduled-field">
        <label htmlFor={`${ids}-cwd`}>{t("scheduled.field.folder")}</label>
        <div className="scheduled-row">
          <AppCombobox id={`${ids}-cwd`} className="scheduled-input scheduled-mono" aria-label={t("scheduled.field.folder")} value={form.cwd} options={projectRoots} spellCheck={false} onValueChange={(value) => set("cwd", value)} aria-describedby={`${ids}-cwd-hint`} />
          {onBrowseFolder && <button type="button" className="scheduled-button" onClick={() => void browse()}>{t("scheduled.browse")}</button>}
        </div>
        <p id={`${ids}-cwd-hint`} className="scheduled-hint">{t("scheduled.field.folderHint")}</p>
        {untrustedProject && <p className="scheduled-notice" role="note">{t("scheduled.trust.notice")}</p>}
      </div>

      <fieldset className="scheduled-field scheduled-fieldset">
        <legend>{t("scheduled.field.schedule")}</legend>
        <div className="scheduled-chips" role="radiogroup" aria-label={t("scheduled.field.schedule")}>
          {SCHEDULE_KINDS.map((kind) => (
            // Native radios, so the arrow keys move between the choices and a screen reader announces them as a group.
            <label key={kind} className={`scheduled-chip${form.kind === kind ? " is-selected" : ""}`}>
              <input type="radio" className="scheduled-visually-hidden" name={`${ids}-kind`} checked={form.kind === kind} onChange={() => set("kind", kind)} />
              {t(`scheduled.schedule.${kind}`)}
            </label>
          ))}
        </div>

        <div className="scheduled-row scheduled-schedule-inputs">
          {form.kind === "weekly" && (
            <label className="scheduled-inline">
              <span>{t("scheduled.schedule.day")}</span>
              <AppSelect className="scheduled-input" aria-label={t("scheduled.schedule.day")} value={String(form.weekday)} onValueChange={(value) => set("weekday", Number(value))}
                options={weekdays.map((day) => ({ value: String(day.value), label: day.label }))} />
            </label>
          )}
          {(form.kind === "daily" || form.kind === "weekdays" || form.kind === "weekly") && (
            <label className="scheduled-inline">
              <span>{t("scheduled.schedule.time")}</span>
              <input className="scheduled-input" type="time" value={form.time} onChange={(e) => set("time", e.target.value)} />
            </label>
          )}
          {form.kind === "hourly" && (
            <label className="scheduled-inline">
              <span>{t("scheduled.schedule.minute")}</span>
              <input className="scheduled-input" type="number" min={0} max={59} value={form.minute} onChange={(e) => set("minute", Math.min(59, Math.max(0, Number(e.target.value) || 0)))} />
            </label>
          )}
          {form.kind === "once" && (
            <label className="scheduled-inline">
              <span>{t("scheduled.schedule.at")}</span>
              <input className="scheduled-input" type="datetime-local" value={form.onceAt} onChange={(e) => set("onceAt", e.target.value)} />
            </label>
          )}
          {form.kind === "custom" && (
            <label className="scheduled-inline scheduled-inline--grow">
              <span>{t("scheduled.schedule.cron")}</span>
              <input className="scheduled-input scheduled-mono" value={form.cron} spellCheck={false} placeholder="0 9 * * 1-5" onChange={(e) => set("cron", e.target.value)} />
            </label>
          )}
        </div>
        {form.kind === "custom" && <p className="scheduled-hint">{t("scheduled.schedule.cronHint")}</p>}

        {expr && (
          <div className="scheduled-preview" aria-live="polite">
            <span className="scheduled-hint">{t("scheduled.schedule.timezone", { zone: timezone })}</span>
            {shownPreview?.valid === false && (
              <p className="scheduled-error" role="alert">{shownPreview.key ? t(shownPreview.key, shownPreview.params) : shownPreview.error}</p>
            )}
            {shownPreview?.valid && shownPreview.nextRuns && (
              <>
                <span className="scheduled-preview-title">{t("scheduled.preview.title")}</span>
                <ul className="scheduled-preview-list">
                  {shownPreview.nextRuns.slice(0, 3).map((run) => <li key={run}>{formatDateTime(run, locale)}</li>)}
                </ul>
              </>
            )}
          </div>
        )}
      </fieldset>

      <div className="scheduled-grid">
        <div className="scheduled-field">
          <label htmlFor={`${ids}-model`}>{t("scheduled.field.model")}</label>
          <AppSelect id={`${ids}-model`} className="scheduled-input" aria-label={t("scheduled.field.model")} value={form.model} onValueChange={(value) => set("model", value)}
            options={[
              { value: "", label: t("scheduled.model.default") },
              ...(task?.model && !models.some((m) => modelKey({ provider: m.provider, modelId: m.id }) === form.model) && form.model
                ? [{ value: form.model, label: `${task.model.provider}/${task.model.modelId}` }] : []),
              ...models.map((model) => ({ value: modelKey({ provider: model.provider, modelId: model.id }), label: `${model.name || model.id} · ${model.provider}` })),
            ]} />
        </div>
        <div className="scheduled-field">
          <label htmlFor={`${ids}-thinking`}>{t("scheduled.field.thinking")}</label>
          <AppSelect id={`${ids}-thinking`} className="scheduled-input" aria-label={t("scheduled.field.thinking")} value={form.thinking} onValueChange={(value) => set("thinking", value)}
            options={[{ value: "", label: t("scheduled.thinking.default") }, ...THINKING_LEVELS.map((level) => ({ value: level, label: level }))]} />
        </div>
        <div className="scheduled-field">
          <label htmlFor={`${ids}-limit`}>{t("scheduled.field.timeLimit")}</label>
          <input id={`${ids}-limit`} className="scheduled-input" type="number" min={1} max={MAX_DURATION_MINUTES} value={form.maxDurationMin} onChange={(e) => set("maxDurationMin", Math.max(1, Math.min(MAX_DURATION_MINUTES, Math.round(Number(e.target.value)) || 1)))} aria-describedby={`${ids}-limit-hint`} />
          <p id={`${ids}-limit-hint`} className="scheduled-hint">{t("scheduled.field.timeLimitHint")}</p>
        </div>
      </div>

      <fieldset className="scheduled-field scheduled-fieldset">
        <legend>{t("scheduled.field.tools")}</legend>
        <div className="scheduled-tools" role="radiogroup" aria-label={t("scheduled.field.tools")}>
          {TOOL_PRESETS.map((preset) => {
            const key = TOOL_PRESET_KEYS[preset];
            return (
              <label key={preset} className={`scheduled-tool${form.toolPreset === preset ? " is-selected" : ""}${canWrite(preset) ? " is-write" : ""}`}>
                <input type="radio" name={`${ids}-tools`} aria-label={t(key)} checked={form.toolPreset === preset} onChange={() => set("toolPreset", preset)} />
                <span className="scheduled-tool-name">{t(key)}</span>
                <span className="scheduled-hint">{t(`${key}Hint`)}</span>
              </label>
            );
          })}
        </div>
        {canWrite(form.toolPreset) && (
          <div className="scheduled-warning" role="note">
            <p>{t("scheduled.tools.writeWarning")}</p>
            {needsAck && (
              <label className="scheduled-check">
                <input type="checkbox" checked={form.acknowledged} onChange={(e) => set("acknowledged", e.target.checked)} />
                <span>{t("scheduled.tools.writeAck")}</span>
              </label>
            )}
          </div>
        )}
      </fieldset>

      {error && <p className="scheduled-error" role="alert">{error}</p>}

      <div className="scheduled-actions">
        <button type="button" className="scheduled-button" onClick={onCancel} disabled={saving}>{t("scheduled.cancel")}</button>
        <button type="submit" className="scheduled-button scheduled-button--primary" disabled={saving || missing || scheduleInvalid}>
          {saving ? t("scheduled.saving") : task ? t("scheduled.save") : t("scheduled.create")}
        </button>
      </div>
    </form>
  );
}
