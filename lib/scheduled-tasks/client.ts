import type { ScheduledRun, ScheduledTaskView } from "./types";

/** Browser-side wrappers for /api/scheduled-tasks. Import nothing server-only here. */

export class ScheduledApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ScheduledApiError";
  }
}

const BASE = "/api/scheduled-tasks";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = await response.json().catch(() => ({})) as { error?: string; code?: string } & Record<string, unknown>;
  if (!response.ok) {
    throw new ScheduledApiError(body.error ?? `HTTP ${response.status}`, response.status, body.code);
  }
  return body as T;
}

export interface TaskInput {
  name?: string;
  description?: string | null;
  prompt?: string;
  cwd?: string;
  schedule?:
    | { kind: "manual" }
    | { kind: "cron"; expr: string; timezone?: string }
    | { kind: "once"; at: string };
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  toolPreset?: "none" | "read-only" | "default" | "full";
  maxDurationMin?: number;
  enabled?: boolean;
  acknowledgeUnattendedWrites?: boolean;
}

export interface CronPreview {
  valid: boolean;
  error?: string;
  timezone?: string;
  nextRuns?: string[];
}

export const scheduledApi = {
  list: () => request<{ tasks: ScheduledTaskView[]; scheduler: { owner: boolean } }>(""),
  create: (input: TaskInput) =>
    request<{ task: ScheduledTaskView }>("", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, patch: TaskInput) =>
    request<{ task: ScheduledTaskView }>(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string, options: { deleteHistory?: boolean } = {}) =>
    request<{ success: true }>(`/${encodeURIComponent(id)}${options.deleteHistory ? "?deleteHistory=1" : ""}`, { method: "DELETE" }),
  run: (id: string) => request<{ run: ScheduledRun }>(`/${encodeURIComponent(id)}/run`, { method: "POST" }),
  runs: (id: string, options: { before?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.before) query.set("before", options.before);
    if (options.limit) query.set("limit", String(options.limit));
    const text = query.toString();
    const suffix = text ? `?${text}` : "";
    return request<{ runs: ScheduledRun[]; hasMore: boolean }>(`/${encodeURIComponent(id)}/runs${suffix}`);
  },
  markSeen: (id: string, runId: string) =>
    request<{ run: ScheduledRun }>(`/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/seen`, { method: "POST" }),
  preview: (expr: string, timezone?: string) =>
    request<CronPreview>("/preview", { method: "POST", body: JSON.stringify({ expr, ...(timezone ? { timezone } : {}) }) }),
};
