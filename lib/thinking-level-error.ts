/**
 * Recognizing a provider error that refused the thinking level a request carried.
 *
 * A custom reasoning model without a thinking level map sends each level's name as
 * the provider's effort value, and an endpoint that accepts only some answers 400:
 *
 *   400 data: {"error":{..."message":"'reasoning_effort' must be one of: 'low', 'high', 'max'"...}}
 *
 * The chat shows such an error with what it means and a way to Settings › Models,
 * where the built-in settings or the level probe fix the map. Nothing is retried or
 * changed automatically: the request was sent at the level the user picked.
 */

/** Names a provider uses for the effort/thinking field. */
const THINKING_FIELD = /\b(reasoning[_ .-]?effort|reasoning\.effort|thinking[_ .-]?(level|budget|config|type)|enable_thinking|budget_tokens)\b/i;

/** The leading HTTP status, as pi's OpenAI-compatible errors start ("400 data: …", "400 Bad Request"). */
function leadingStatus(message: string): number | undefined {
  const match = /^\s*(\d{3})\b/.exec(message);
  return match ? Number(match[1]) : undefined;
}

export function isThinkingLevelRefusal(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  const status = leadingStatus(errorMessage);
  if (status !== 400 && status !== 422) return false;
  return THINKING_FIELD.test(errorMessage);
}

/**
 * The values the provider says it accepts, when the error lists them
 * ("must be one of: 'low', 'high', 'max'", "expected one of [low, high]").
 * Shown to the user only; the map is never written from it.
 */
export function refusalAllowedValues(errorMessage: string | null | undefined): string[] {
  if (!errorMessage) return [];
  const match = /\bone of\b\s*:?\s*[\[(]?([^\]\)\n}]*)/i.exec(errorMessage);
  if (!match) return [];
  const values = match[1]
    .split(/,|\bor\b/)
    .map((part) => part.trim().replace(/^[\\'"`]+|[\\'"`.]+$/g, "").trim())
    .filter((part) => /^[a-z][a-z0-9_-]{0,23}$/i.test(part));
  return [...new Set(values)].slice(0, 8);
}
