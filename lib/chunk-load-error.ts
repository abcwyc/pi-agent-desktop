/**
 * Whether an error means code could not be loaded (a lazy chunk or module
 * import failed: the dev server restarted, the network dropped, an app update
 * replaced the files) rather than that the input was wrong. Mermaid loads one
 * chunk per diagram type inside `parse`, so such a failure arrives where a
 * syntax error would. It must not offer "Ask to fix": the model would be asked
 * to change a diagram or chart that may be correct.
 */
export function isLoadFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  return typeof message === "string"
    && /Failed to load chunk|Loading (?:CSS )?chunk [\w./-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(message);
}
