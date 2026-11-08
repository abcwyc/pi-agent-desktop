/**
 * Display-only restoration for the exact envelope emitted by pi's
 * `_expandSkillCommand`. The expanded text remains the stored session input.
 */
const SKILL_EXPANSION_RE = /^<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to [^\n]+\.\n\n([\s\S]*)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * Restore a complete SDK skill expansion to its compact command form.
 *
 * The expression intentionally requires the opening envelope, matching
 * base-directory reference, final closing tag, and an optional two-newline args
 * suffix. This avoids collapsing ordinary text that merely starts with a
 * skill-looking tag. The greedy body capture makes the final closing tag win
 * when a skill body contains an example `</skill>` tag.
 */
export function skillExpansionToCommand(text: string): string | null {
  const match = text.match(SKILL_EXPANSION_RE);
  if (!match) return null;

  const [, name, , , args] = match;
  return args ? `/skill:${name} ${args}` : `/skill:${name}`;
}

/**
 * Longest first message the session list sends. Every reader of the list shows
 * one line of it (the sidebar title takes 50 characters), but the scanner keeps
 * the whole first prompt: on a real ~/.pi, pasted documents and skill bodies
 * were 84% of a 1 MB list that a cold start fetches three times.
 */
export const SESSION_LIST_FIRST_MESSAGE_CHARS = 200;

/**
 * A session list's first message: the compact `/skill:` command for a skill
 * expansion (its args sit after the whole SKILL.md body, so it must be restored
 * before cutting), then at most SESSION_LIST_FIRST_MESSAGE_CHARS code points.
 */
export function sessionListFirstMessage(text: string): string {
  const display = skillExpansionToCommand(text) ?? text;
  if (display.length <= SESSION_LIST_FIRST_MESSAGE_CHARS) return display;
  // Twice the limit in UTF-16 units always holds the limit in code points.
  const head = display.slice(0, SESSION_LIST_FIRST_MESSAGE_CHARS * 2);
  const points = Array.from(head);
  if (points.length <= SESSION_LIST_FIRST_MESSAGE_CHARS && head === display) return display;
  return `${points.slice(0, SESSION_LIST_FIRST_MESSAGE_CHARS).join("")}…`;
}

/**
 * The text inside a complete SDK skill expansion's envelope (the reference
 * line and the skill body), what pi's TUI shows for an expanded skill
 * invocation; the arguments after it are the command's.
 */
export function skillExpansionContent(text: string): string | null {
  const match = text.match(SKILL_EXPANSION_RE);
  if (!match) return null;
  const args = match[4];
  const tail = args === undefined ? "\n</skill>".length : "\n</skill>\n\n".length + args.length;
  return text.slice(text.indexOf("\n") + 1, text.length - tail);
}
