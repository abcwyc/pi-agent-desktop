import { realpathSync } from "fs";
import path from "path";
import { userHome } from "./user-home.ts";

/**
 * Credential stores under the home directory that /api/files never reads,
 * lists or writes into, even when a session's cwd is the home directory.
 * Reaching the API already grants a shell to whoever drives the agent, but a
 * network-exposed server behind a password would otherwise hand over private
 * keys and provider tokens with one GET, without a prompt or a transcript.
 * Project files such as `.env` stay viewable: they belong to the workspace.
 */
const CREDENTIAL_PATHS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker/config.json",
  ".config/gcloud",
  ".config/gh/hosts.yml",
  ".password-store",
  ".netrc",
  ".git-credentials",
  ".pgpass",
  ".npmrc",
  ".pi/agent/auth.json",
] as const;

// Default macOS and Windows volumes are case-insensitive: `~/.SSH/id_rsa` opens the key.
const caseInsensitive = process.platform === "darwin" || process.platform === "win32";

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

function isUnder(target: string, base: string): boolean {
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/** Whether `target`, or the file a link at `target` points to, is a credential store. */
export function isCredentialPath(target: string, home: string = userHome()): boolean {
  const candidates = [comparable(target)];
  try {
    candidates.push(comparable(realpathSync.native(target)));
  } catch {
    // A missing path is checked lexically only.
  }
  const homes = [comparable(home)];
  try {
    homes.push(comparable(realpathSync.native(home)));
  } catch {
    // Unreadable home: the lexical form still applies.
  }
  return candidates.some((candidate) => homes.some((base) =>
    CREDENTIAL_PATHS.some((entry) => isUnder(candidate, comparable(path.join(base, entry))))));
}
