import type { AgentTaskSnapshot, SessionInfo } from "@/lib/types";

export type TaskGroup = "waiting" | "running" | "recent";

export interface TaskRow {
  group: TaskGroup;
  session: SessionInfo;
  snapshot: AgentTaskSnapshot | null;
}

const RECENT_LIMIT = 20;

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function sessionTitle(session: SessionInfo): string {
  return (session.name || session.firstMessage || "").replace(/\s+/g, " ").trim();
}

/** The project folder's name, or the chats label for a chat. */
export function projectLabel(session: SessionInfo, chatLabel: string): string {
  if (session.workspaceKind === "chat") return chatLabel;
  const root = (session.projectRoot || session.cwd).replace(/[\\/]+$/, "");
  return root.split(/[\\/]/).pop() || root;
}

export function describeActivity(activity: AgentTaskSnapshot["activity"], t: Translate): string {
  if (!activity) return t("tasks.activity.thinking");
  if (activity.kind === "tool") return t("tasks.activity.tool", { name: activity.name });
  return t(`tasks.activity.${activity.kind}`);
}

/**
 * Sort sessions into the page's three lists. Waiting beats running (a dialog
 * blocks the run). Sub-agent runs stay with their parent, and a session the
 * running stream reports before its snapshot arrives still counts as running.
 */
export function groupTasks(
  sessions: SessionInfo[],
  snapshots: AgentTaskSnapshot[],
  runningSessionIds: ReadonlySet<string>,
): Record<TaskGroup, TaskRow[]> {
  const byId = new Map(snapshots.map((snapshot) => [snapshot.sessionId, snapshot]));
  const groups: Record<TaskGroup, TaskRow[]> = { waiting: [], running: [], recent: [] };
  const visible = sessions
    .filter((session) => session.relation?.kind !== "subagent" && !session.transient)
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  for (const session of visible) {
    const snapshot = byId.get(session.id) ?? null;
    if (snapshot && snapshot.waiting.length > 0) groups.waiting.push({ group: "waiting", session, snapshot });
    else if (snapshot?.running || runningSessionIds.has(session.id)) groups.running.push({ group: "running", session, snapshot });
    else if (groups.recent.length < RECENT_LIMIT) groups.recent.push({ group: "recent", session, snapshot });
  }
  return groups;
}
