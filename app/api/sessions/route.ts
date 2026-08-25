import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getLiveSessionSnapshots, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { sessionPathKey } from "@/lib/session-path";
import { resolveProject } from "@/lib/worktree";
import type { SessionInfo } from "@/lib/types";

// Pi delays the first flush of a new session until an assistant message
// exists, so a run that just started has no .jsonl for the disk scan. Without
// these rows the session the user is actively watching is missing from the
// sidebar until the whole turn finishes.
async function liveSessionRows(scanned: SessionInfo[]): Promise<SessionInfo[]> {
  const snapshots = getLiveSessionSnapshots(new Set(scanned.map((s) => s.id)));
  if (snapshots.length === 0) return [];

  const pathToId = new Map(scanned.map((s) => [sessionPathKey(s.path), s.id] as const));
  return Promise.all(snapshots.map(async ({ parentSessionPath, ...snapshot }) => {
    const project = snapshot.cwd ? await resolveProject(snapshot.cwd) : undefined;
    return {
      ...snapshot,
      ...(parentSessionPath ? { parentSessionId: pathToId.get(sessionPathKey(parentSessionPath)) } : {}),
      projectRoot: project?.projectRoot ?? snapshot.cwd,
      ...(project?.branch ? { worktreeBranch: project.branch } : {}),
    };
  }));
}

export async function GET() {
  try {
    const scanned = await listAllSessions();
    const live = await liveSessionRows(scanned);
    const sessions = live.length > 0
      ? [...live, ...scanned].sort((a, b) => b.modified.localeCompare(a.modified))
      : scanned;
    return NextResponse.json({ sessions, runningSessionIds: getRunningRpcSessionIds() });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
