/**
 * The editor's friendly schedule choices, converted to and from the cron
 * expression the server stores. Pure and free of server imports, so the
 * browser can use it.
 */

export type SchedulePreset = "hourly" | "daily" | "weekdays" | "weekly";

export interface PresetSpec {
  preset: SchedulePreset;
  /** 0-23; ignored by "hourly". */
  hour: number;
  minute: number;
  /** 0 (Sunday) to 6; only used by "weekly". */
  weekday: number;
}

export const DEFAULT_PRESET: PresetSpec = { preset: "daily", hour: 9, minute: 0, weekday: 1 };

export function cronFromPreset(spec: PresetSpec): string {
  const { minute, hour, weekday } = spec;
  switch (spec.preset) {
    case "hourly": return `${minute} * * * *`;
    case "daily": return `${minute} ${hour} * * *`;
    case "weekdays": return `${minute} ${hour} * * 1-5`;
    case "weekly": return `${minute} ${hour} * * ${weekday}`;
  }
}

const PATTERN = /^(\d{1,2}) (\*|\d{1,2}) \* \* (\*|1-5|[0-6])$/;

/** The preset an expression is exactly equal to, or null when it needs the custom field. */
export function presetFromCron(expr: string): PresetSpec | null {
  const match = PATTERN.exec(expr.trim().split(/\s+/).join(" "));
  if (!match) return null;
  const minute = Number(match[1]);
  if (minute > 59) return null;
  const [, , hourPart, dayPart] = match;

  if (hourPart === "*") {
    return dayPart === "*" ? { ...DEFAULT_PRESET, preset: "hourly", minute } : null;
  }
  const hour = Number(hourPart);
  if (hour > 23) return null;
  if (dayPart === "*") return { preset: "daily", hour, minute, weekday: DEFAULT_PRESET.weekday };
  if (dayPart === "1-5") return { preset: "weekdays", hour, minute, weekday: DEFAULT_PRESET.weekday };
  return { preset: "weekly", hour, minute, weekday: Number(dayPart) };
}

export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "09:30" to { hour, minute }, or null when it is not a valid 24-hour time. */
export function parseClock(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}
