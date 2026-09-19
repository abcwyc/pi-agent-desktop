export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export type ToolPreset = "none" | "default" | "full";

export const PRESET_NONE: string[] = [];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"];

const BUILTIN_TOOL_NAMES = new Set(PRESET_FULL);

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter((t) => t.active);
  if (activeTools.length === 0) return "none";

  const active = activeTools
    .map((t) => t.name)
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(",");

  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...PRESET_FULL].sort().join(",")) return "full";
  return "default";
}

export function getToolNamesForPreset(preset: ToolPreset): string[] {
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "full") return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}

export const TOOL_PRESET_STORAGE_KEY = "pi-agent.tool-preset";

const TOOL_PRESETS: readonly ToolPreset[] = ["none", "default", "full"];

export function isToolPreset(value: unknown): value is ToolPreset {
  return typeof value === "string" && (TOOL_PRESETS as readonly string[]).includes(value);
}

/** Minimal storage surface, so tests can pass a fake implementation. */
export interface ToolPresetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultToolPresetStorage(): ToolPresetStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Read the user's persisted tool preset for newly created sessions. */
export function readStoredToolPreset(
  storage: ToolPresetStorage | null = defaultToolPresetStorage(),
): ToolPreset | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(TOOL_PRESET_STORAGE_KEY);
    return isToolPreset(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Persist the user's tool preset so new sessions start with it. */
export function storeToolPreset(
  preset: ToolPreset,
  storage: ToolPresetStorage | null = defaultToolPresetStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(TOOL_PRESET_STORAGE_KEY, preset);
  } catch {
    // Ignore storage failures (private mode, quota, disabled storage).
  }
}
