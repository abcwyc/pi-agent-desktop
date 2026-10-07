import type { ScheduledRun, ScheduledTaskView } from "./types";

/** Browser-side wrappers for /api/scheduled-tasks. Import nothing server-only here. */

export class ScheduledApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** i18n key and parameters for a validation error, so the page can show it in the reader's language. */
    readonly key?: string,
    readonly params?: Record<string, string | number>,
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
  const body = await response.json().catch(() => ({})) as {
    error?: string;
    code?: string;
    key?: string;
    params?: Record<string, string | number>;
  } & Record<string, unknown>;
  if (!response.ok) {
    throw new ScheduledApiError(body.error ?? `HTTP ${response.status}`, response.status, body.code, body.key, body.params);
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
  key?: string;
  params?: Record<string, string | number>;
  timezone?: string;
  nextRuns?: string[];
}

export const scheduledApi = {
  list: () => request<{ tasks: ScheduledTaskView[]; scheduler: { owner: boolean } }>(""),
  create: (input: TaskInput) =>
    request<{ task: ScheduledTaskView }>("", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, patch: TaskInput) =>
    request<{ task: ScheduledTaskView }>(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => request<{ success: true }>(`/${encodeURIComponent(id)}`, { method: "DELETE" }),
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

/** An error from the API in the reader's language, falling back to the English message. */
export function apiErrorText(
  error: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (error instanceof ScheduledApiError && error.key) return t(error.key, error.params);
  return error instanceof Error ? error.message : String(error);
}
