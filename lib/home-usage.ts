/** Small, content-free projections of persisted usage. Dates and ranges use UTC. */
export interface HomeUsageRecord {
  key: string;
  timestamp: string;
  message: boolean;
  model?: string;
  tokens?: number;
}

export interface HomeUsage {
  sessions: number;
  messages: number;
  tokens: number | null;
  activeDays: number;
  peakHour: number | null;
  favoriteModel: string | null;
  days: { date: string; messages: number; tokens: number; models?: Record<string, number> }[];
  models: { name: string; tokens: number }[];
  usageRecords: number;
  skippedFiles: number;
  generatedAt: string;
}

export type HomeUsageRange = "all" | "30" | "7";

export function homeUsageRange(value: string | null): HomeUsageRange | null {
  if (value === null || value === "all") return "all";
  if (value === "30" || value === "7") return value;
  return null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

/** Ignore tool payloads, prompts and provider-reported prices. Never return content. */
export function projectHomeUsage(value: unknown, fallbackKey: string): HomeUsageRecord | null {
  const entry = object(value);
  if (!entry) return null;
  const message = object(entry.message);
  const isMessage = entry.type === "message" && (message?.role === "user" || message?.role === "assistant");
  const usage = object(entry.type === "message" ? message?.usage : entry.usage);
  if (!isMessage && !usage) return null;
  let timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
  if (!timestamp && typeof message?.timestamp === "number") {
    const date = new Date(message.timestamp);
    if (Number.isFinite(date.getTime())) timestamp = date.toISOString();
  }
  if (!Number.isFinite(Date.parse(timestamp))) return null;
  const model = typeof message?.model === "string" ? message.model : typeof entry.model === "string" ? entry.model : undefined;
  const provider = typeof message?.provider === "string" ? message.provider : typeof entry.provider === "string" ? entry.provider : "";
  const fields = ["input", "output", "cacheRead", "cacheWrite"];
  const validUsage = usage && fields.every((key) => usage[key] === undefined || (typeof usage[key] === "number" && Number.isFinite(usage[key]) && (usage[key] as number) >= 0))
    && fields.some((key) => typeof usage[key] === "number");
  const sum = validUsage ? fields.reduce((total, key) => total + ((usage[key] as number | undefined) ?? 0), 0) : undefined;
  return {
    key: typeof entry.id === "string" ? JSON.stringify([entry.id, timestamp, entry.type, message?.role, provider, model]) : fallbackKey,
    timestamp,
    message: isMessage,
    model: model ? (provider ? provider + "/" + model : model) : undefined,
    tokens: sum !== undefined && Number.isFinite(sum) ? sum : undefined,
  };
}

export function summarizeHomeUsage(
  records: Iterable<HomeUsageRecord>, sessionDates: string[], range: HomeUsageRange, now = new Date(),
): HomeUsage {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const cutoff = range === "all" ? -Infinity : today.getTime() - (Number(range) - 1) * 86400000;
  const end = now.getTime();
  const inRange = (timestamp: string) => { const n = Date.parse(timestamp); return Number.isFinite(n) && n >= cutoff && n <= end; };
  const days = new Map<string, { date: string; messages: number; tokens: number; models: Record<string, number> }>();
  const models = new Map<string, number>();
  const hours = Array<number>(24).fill(0);
  const seen = new Set<string>();
  let messages = 0, tokens = 0, usageRecords = 0;
  for (const record of records) {
    if (seen.has(record.key) || !inRange(record.timestamp)) continue;
    seen.add(record.key);
    const date = new Date(record.timestamp);
    const key = date.toISOString().slice(0, 10);
    const day = days.get(key) ?? { date: key, messages: 0, tokens: 0, models: Object.create(null) as Record<string, number> };
    if (record.message) { messages++; day.messages++; hours[date.getUTCHours()]++; }
    if (record.tokens !== undefined) {
      usageRecords++;
      tokens += record.tokens;
      day.tokens += record.tokens;
      if (record.model) {
        models.set(record.model, (models.get(record.model) ?? 0) + record.tokens);
        day.models[record.model] = (day.models[record.model] ?? 0) + record.tokens;
      }
    }
    days.set(key, day);
  }
  const rankedModels = [...models].map(([name, tokens]) => ({ name, tokens })).sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  return {
    sessions: sessionDates.filter(inRange).length, messages,
    tokens: usageRecords > 0 || messages === 0 ? tokens : null,
    activeDays: [...days.values()].filter((day) => day.messages > 0 || day.tokens > 0).length,
    peakHour: messages > 0 ? hours.indexOf(Math.max(...hours)) : null,
    favoriteModel: rankedModels[0]?.name ?? null,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    models: rankedModels, usageRecords, skippedFiles: 0, generatedAt: now.toISOString(),
  };
}
