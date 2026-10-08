import type { MessageParams, RunErrorCode } from "./types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const KEYS: Record<RunErrorCode, string> = {
  "time-limit": "scheduled.runError.timeLimit",
  interrupted: "scheduled.runError.interrupted",
  stopped: "scheduled.runError.stopped",
  "cwd-missing": "scheduled.runError.cwdMissing",
};

/**
 * A run's error in the reader's language. Errors this module produces carry a
 * code; anything else (a model provider's message, say) is shown as it came.
 */
export function describeRunError(
  run: { error?: string; errorCode?: RunErrorCode; errorParams?: MessageParams },
  t: Translate,
): string {
  if (run.errorCode && KEYS[run.errorCode]) return t(KEYS[run.errorCode], run.errorParams);
  return run.error ?? "";
}
