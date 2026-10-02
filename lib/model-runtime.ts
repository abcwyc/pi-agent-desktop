import {
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/**
 * ModelRuntime that also includes providers registered by extensions (an
 * extension that calls `registerProvider` / `createProvider` during resource
 * loading). A bare `ModelRuntime.create()` only knows built-in providers plus
 * models.json, so extension-registered providers were invisible to the
 * provider-listing and auth routes.
 *
 * The agent dir acts as cwd so project-local extensions stay out; global
 * package extensions always load. Not cached: these routes need fresh
 * credentials for auth status and login/logout to be truthful.
 */
export async function createModelRuntimeWithExtensions(
  modelRuntime?: ModelRuntime,
): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  const runtime = modelRuntime ?? await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const services = await createAgentSessionServices({
    cwd: agentDir,
    agentDir,
    modelRuntime: runtime,
    resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
  });
  return services.modelRuntime;
}
