import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  listSessionSummaries,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
  withSubagentDisplayStatus,
} from "@/lib/rpc-manager";
import { startServerPerf } from "@/lib/perf";
import { attachScheduledRelations } from "@/lib/scheduled-tasks/run-index";
import { ensureChatWorkspace, pruneEmptyChatFolders } from "@/lib/chat-workspace";
import { allowFileRoot } from "@/lib/file-access";
import { sessionListFirstMessage } from "@/lib/slash-display";

export const dynamic = "force-dynamic";

// Chat folders of composers that never sent anything are swept now and then, not on every poll.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastChatFolderPrune = 0;

export async function GET(req: Request) {
  const perf = startServerPerf("GET /api/sessions");
  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get("summary") === "1";
    perf?.span("start");
    const persistedSessionsPromise = summary
      ? listSessionSummaries()
      : listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions, chatWorkspaceCwd] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
      ensureChatWorkspace(),
    ]);
    allowFileRoot(chatWorkspaceCwd);
    if (Date.now() - lastChatFolderPrune > PRUNE_INTERVAL_MS) {
      lastChatFolderPrune = Date.now();
      // A folder some session points at is a real chat's, empty or not.
      const inUse = new Set<string>();
      for (const session of [...persistedSessions, ...runtimeSessions]) if (session.cwd) inUse.add(session.cwd);
      void pruneEmptyChatFolders(undefined, { keep: inUse }).catch(() => undefined);
    }
    perf?.span("scan+projects");
    const sessions = withSubagentDisplayStatus(attachScheduledRelations(mergeSessionLists(persistedSessions, runtimeSessions)))
      .map((session) => {
        const firstMessage = sessionListFirstMessage(session.firstMessage);
        return firstMessage === session.firstMessage ? session : { ...session, firstMessage };
      });
    const payload = {
      sessions,
      sessionListVersion,
      runningSessionIds: getRunningRpcSessionIds(),
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      chatWorkspaceCwd,
    };
    return perf?.attach(jsonResponse(
      req,
      payload,
      { headers: { "Cache-Control": "no-store" } },
    )) ?? jsonResponse(
      req,
      payload,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
