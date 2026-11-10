/**
 * The notice for a refused sidebar Fork (POST /api/sessions/[id]/fork's
 * `code`), as a message key and its parameters: a known refusal says why in
 * the user's language, anything else shows the server's error (S4, upstream
 * `forkFailureMessage`).
 */
export function forkFailureMessage(code: string | undefined, error: string): { key: string; params?: { error: string } } {
  switch (code) {
    case "not_found": return { key: "sidebar.forkNotFound" };
    case "unsaved": return { key: "sidebar.forkUnsaved" };
    case "empty": return { key: "sidebar.forkEmpty" };
    case "subagent":
    case "request-denied":
      return { key: "sidebar.forkUnavailable" };
    default: return { key: "sidebar.forkFailed", params: { error } };
  }
}
