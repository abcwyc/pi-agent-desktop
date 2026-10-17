import type { LoginOptions } from "@earendil-works/pi-ai";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Stable per-installation UUID that pi-ai's subscription logins identify this
 * installation with: "Sign in with ChatGPT" sends it as the authorization URL's
 * `ext_agent_host_id` and refuses to log in before opening a browser when it is
 * missing.
 *
 * pi stores it in the global `settings.json` and creates it on first use, and the
 * CLI hands it to `ModelRuntime.login()` through `LoginOptions.getDeviceId`
 * (`interactive-mode.ts`). Pi Web talks to the same agent dir, so both surfaces
 * keep one identity. The agent dir doubles as the cwd on purpose: `deviceId` is
 * global-only, and a committed project settings file must never hand every clone
 * the same ID.
 */
export function getOrCreateDeviceId(): string {
  const agentDir = getAgentDir();
  const cached = deviceIds.get(agentDir);
  if (cached) return cached;
  const deviceId = SettingsManager.create(agentDir, agentDir).getOrCreateDeviceId();
  deviceIds.set(agentDir, deviceId);
  return deviceId;
}

// SettingsManager queues its write, so a second login in this process that read the
// file again first would find no `deviceId` and mint another UUID. pi-ai documents
// the getter as "must return the same ID on every later call", so keep it here;
// a restart re-reads whatever the write eventually stored.
const deviceIds = new Map<string, string>();

/**
 * The `LoginOptions` argument of
 * `ModelRuntime.login(provider, "oauth", interaction, options)`.
 *
 * It lives here rather than at the call site because the call site once passed no
 * options at all, which made every "Sign in with ChatGPT" attempt fail with
 * "Sign in with ChatGPT requires a device ID (UUID) for this installation"
 * before the browser opened.
 */
export function oauthLoginOptions(): LoginOptions {
  return { getDeviceId: () => getOrCreateDeviceId() };
}
