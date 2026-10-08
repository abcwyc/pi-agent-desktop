import type { RunnerDeps, RunnerSession } from "./runner";

/**
 * Wires the runner to the live session registry. rpc-manager is imported on
 * first use so that starting the scheduler at server boot stays cheap.
 */
export const liveRunnerDeps: RunnerDeps = {
  now: () => new Date(),
  async startSession(cwd, options) {
    const [{ startRpcSession }, { allowFileRoot }, { invalidateSessionListCache }] = await Promise.all([
      import("../rpc-manager"),
      import("../file-access"),
      import("../session-reader"),
    ]);
    // A one-time key: concurrent starts sharing a key would be merged into one session.
    const { session, realSessionId } = await startRpcSession(`__scheduled__${crypto.randomUUID()}`, "", cwd, {
      toolNames: options.toolNames,
      ...(options.initialModel ? { initialModel: options.initialModel } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel as never } : {}),
      allowInitialModelFallback: options.allowInitialModelFallback,
    });
    allowFileRoot(cwd);
    invalidateSessionListCache();
    return { session: session as unknown as RunnerSession, sessionId: realSessionId };
  },
};
