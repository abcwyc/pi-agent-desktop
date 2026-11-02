/** The `{ endpoint }` body that the test and unsubscribe routes take. */
export async function readEndpoint(req: Request): Promise<string | null> {
  try {
    const body = await req.json() as { endpoint?: unknown };
    return typeof body.endpoint === "string" && /^https:\/\//.test(body.endpoint) ? body.endpoint : null;
  } catch {
    return null;
  }
}
