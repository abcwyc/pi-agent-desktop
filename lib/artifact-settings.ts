import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

// Pi Web's own preferences, kept out of pi's settings.json because the pi CLI
// and other hosts read that file and have no artifacts panel.

type StoredSettings = Record<string, unknown> & { artifactsPrompt?: unknown };

export function getPiWebSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "settings.json");
}

export function readStored(settingsPath: string): StoredSettings {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid Pi Web settings: expected an object");
  }
  return parsed as StoredSettings;
}

/**
 * Whether sessions tell the model about artifacts. On by default; an
 * unreadable file keeps it on, since the cost of a wrong "on" is one prompt
 * section, while a silent "off" would look like the feature broke.
 */
export function isArtifactsPromptEnabled(settingsPath = getPiWebSettingsPath()): boolean {
  try {
    return readStored(settingsPath).artifactsPrompt !== false;
  } catch {
    return true;
  }
}

export function writeArtifactsPromptEnabled(enabled: boolean, settingsPath = getPiWebSettingsPath()): boolean {
  const stored = readStored(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({ ...stored, version: 1, artifactsPrompt: enabled }, null, 2));
  return isArtifactsPromptEnabled(settingsPath);
}

/** Merge keys into Pi Web's settings file, leaving every other key as it was. */
export function updatePiWebSettings(patch: Record<string, unknown>, settingsPath = getPiWebSettingsPath()): void {
  const stored = readStored(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({ ...stored, version: 1, ...patch }, null, 2));
}
