import { createModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { readCodemodePreference } from "@/lib/codemode-settings";
import { listNonChatModels, type NonChatModelRuntime } from "@/lib/nonchat-models";

export const runtime = "nodejs";

/**
 * GET: classifier and image models (Settings › Models › Non-chat models), with the global
 * Code mode choice, since codemode scripts are the only way a session reaches them.
 * Read-only and offline: the runtime restores catalogs without fetching them.
 */
export async function GET() {
  try {
    const modelRuntime = await createModelRuntimeWithExtensions();
    const [models, codemode] = await Promise.all([
      listNonChatModels(modelRuntime as unknown as NonChatModelRuntime),
      readCodemodePreference(),
    ]);
    return Response.json({ ...models, codemode });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
