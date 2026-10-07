// Shared stubs for the runner and scheduler tests.
export function makeSession(behavior = "ok") {
  const listeners = new Set();
  const session = {
    sent: [],
    entries: [],
    held: false,
    emit(event) { for (const listener of listeners) listener(event); },
    finish(kind = behavior) {
      if (kind === "ok") session.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      if (kind === "error") session.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "boom" } });
      if (kind === "aborted") session.emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
      if (kind === "promptError") session.emit({ type: "prompt_error", errorMessage: "preflight exploded" });
      session.emit({ type: "prompt_done" });
    },
    async send(command) {
      session.sent.push(command);
      if (command.type === "prompt") {
        if (behavior === "rejectSend") throw new Error("prompt rejected");
        if (behavior === "userAborted") queueMicrotask(() => session.finish("aborted"));
        else if (behavior !== "hang" && behavior !== "hold") queueMicrotask(() => session.finish());
      }
      if (command.type === "abort" && behavior === "hang") queueMicrotask(() => session.finish("aborted"));
      return null;
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    inner: { sessionManager: { appendCustomEntry: (customType, data) => session.entries.push({ customType, data }) } },
  };
  return session;
}

export function makeDeps({ behavior = () => "ok", clock = () => new Date(), extra = {} } = {}) {
  const started = [];
  const deps = {
    started,
    now: clock,
    async startSession(cwd, options) {
      const kind = behavior(started.length);
      if (kind === "startFails") throw new Error("could not start");
      const session = makeSession(kind);
      const sessionId = `session-${started.length + 1}`;
      started.push({ cwd, options, session, sessionId });
      return { session, sessionId };
    },
    ...extra,
  };
  return deps;
}
