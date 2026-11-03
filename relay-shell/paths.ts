/**
 * Which app paths the shell will frame when asked from outside (a link's
 * ?path=, a notification). Only app pages: the address is attacker-chosen, and
 * framing /api/… would run that GET with the owner's authority (the desktop's
 * own Sec-Fetch-Site check never sees a tunneled request).
 */
export function safeAppPath(path: unknown): string {
  if (typeof path !== "string" || path.includes("\\")) return "/";
  return path === "/" || path.startsWith("/?") ? path : "/";
}
