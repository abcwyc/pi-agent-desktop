// Client-safe: a session's or fresh composer's folder that no longer exists
// (the project was moved or renamed, #1422). Routes add `reason: "cwd-missing"`
// and the folder to their error body, so the composer names the folder instead
// of showing the refusal as a model error.

export const CWD_MISSING_REASON = "cwd-missing" as const;

/** The English `error` text routes answer with; the page shows a translated one. */
export function cwdMissingMessage(cwd: string): string {
  return `Directory does not exist: ${cwd}`;
}

/**
 * Thrown on the server where a prompt is refused before it reaches the model.
 * A plain Error with fields, never a class to test with `instanceof`: the
 * wrapper that throws it may come from another route's bundle (the events
 * route starts most wrappers), so class identity differs between routes.
 */
export function cwdMissingError(cwd: string): Error & { reason: typeof CWD_MISSING_REASON; cwd: string } {
  return Object.assign(new Error(cwdMissingMessage(cwd)), { reason: CWD_MISSING_REASON, cwd });
}

/** The error body fields a route answers a missing folder with. */
export function cwdMissingBody(cwd: string): { error: string; reason: typeof CWD_MISSING_REASON; cwd: string } {
  return { error: cwdMissingMessage(cwd), reason: CWD_MISSING_REASON, cwd };
}

/** The missing folder an error body (or a thrown `cwdMissingError()`) names, else null. */
export function missingCwdFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { reason, cwd } = body as { reason?: unknown; cwd?: unknown };
  return reason === CWD_MISSING_REASON && typeof cwd === "string" && cwd ? cwd : null;
}
