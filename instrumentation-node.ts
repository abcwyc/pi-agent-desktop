import { configureHttpDispatcher, readHttpIdleTimeoutMs } from "@/lib/http-dispatcher";
import { initializeNetworkProxy } from "@/lib/network-proxy";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { startScheduler } from "@/lib/scheduled-tasks";
import { restartRelayFromConfig } from "@/lib/relay/runtime";
import { applyCodemodeWorkerDefault } from "@/lib/codemode-workers";

export function registerNodeInstrumentation(): void {
  // Before any session can run a codemode script (lib/codemode-workers.ts).
  applyCodemodeWorkerDefault();

  // The proxy from Settings › General goes into process.env before the
  // dispatcher reads it; see lib/network-proxy.ts.
  try {
    initializeNetworkProxy();
  } catch (error) {
    console.error("[network-proxy] could not apply the saved proxy:", error instanceof Error ? error.message : error);
  }

  // The pi CLI applies settings' `httpIdleTimeoutMs` to the same undici
  // body/header timeouts, so a Web UI session gets the timeout the user
  // configured. Without it the built-in five minutes aborts a provider stream
  // that stays quiet for longer, which a CLI session tolerates.
  configureHttpDispatcher(readHttpIdleTimeoutMs());

  // Scheduled tasks must fire without anyone having opened a page, and the
  // packaged app keeps this server alive while its window is hidden in the tray.
  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1") startScheduler();

  // The relay connection (Settings › Remote relay) must also come up without a page:
  // a phone reaches this computer through it.
  if (process.env.PI_WEB_DISABLE_RELAY !== "1") {
    void restartRelayFromConfig().catch((error) => {
      console.error("[relay] could not start:", error instanceof Error ? error.message : error);
    });
  }

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);

  // Next evaluates a route's code on its first request, so the first
  // /api/sessions used to pay for importing the whole pi SDK, seconds on
  // Windows (#964). Start that import now, unawaited so register() stays fast:
  // the launcher opens the browser only once the first page is served, after
  // it (bin/browser-opener.js), and the routes reuse Node's cached module.
  // A failure is left for the routes' own import to report.
  import("@earendil-works/pi-coding-agent").catch(() => {});
}
