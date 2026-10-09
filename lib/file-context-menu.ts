import { getFileName } from "./file-paths";
import { resolveLocalFileHref } from "./file-links";
import type { NativeMenuEntry } from "./desktop-menu-model";
import type { DesktopPlatform } from "./desktop-window";
import type { FileOpenApp } from "./desktop-native";

/**
 * Right-click menu for a file the chat mentions: Open (in the preview pane),
 * Open With ▸ (macOS), Reveal in the file manager, Copy Path. Pure helpers
 * only; the hook in `hooks/useFileContextMenu.ts` owns the native calls.
 */

const MAX_INLINE_PATH_LENGTH = 260;

/**
 * Absolute path a piece of inline code might name, or null when the text
 * cannot be a file path. This is only the cheap pre-filter run synchronously
 * on right-click; whether the file exists is decided by the server afterwards.
 */
export function inlineCodeFilePath(text: string, cwd: string | undefined): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_INLINE_PATH_LENGTH) return null;
  if (/[\r\n\t]/.test(trimmed)) return null;
  if (trimmed.startsWith("~") || trimmed.includes("://")) return null;
  return resolveLocalFileHref(trimmed, cwd);
}

/** Apps are listed per file type: Launch Services answers by extension, and one lookup costs ~150ms. */
export function appListCacheKey(filePath: string): string {
  const name = getFileName(filePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export type FileMenuLabels = {
  open: string;
  openWith: string;
  otherApp: string;
  reveal: string;
  copyPath: string;
  defaultApp: (name: string) => string;
};

export interface FileMenuActions {
  open: () => void;
  openWith: (appPath: string) => void;
  chooseOtherApp: () => void;
  reveal: () => void;
  copyPath: () => void;
}

/**
 * `apps` is null where the platform has no Open With (everything but macOS), so
 * the submenu is omitted; an empty list still offers "Other…".
 */
export function buildFileMenuEntries(
  labels: FileMenuLabels,
  actions: FileMenuActions,
  apps: FileOpenApp[] | null,
): NativeMenuEntry[] {
  const entries: NativeMenuEntry[] = [{ label: labels.open, onSelect: actions.open }];
  if (apps) {
    entries.push({
      kind: "submenu",
      label: labels.openWith,
      items: [
        ...apps.map((app): NativeMenuEntry => ({
          label: app.isDefault ? labels.defaultApp(app.name) : app.name,
          onSelect: () => actions.openWith(app.path),
        })),
        ...(apps.length > 0 ? [{ kind: "separator" as const }] : []),
        { label: labels.otherApp, onSelect: actions.chooseOtherApp },
      ],
    });
  }
  entries.push(
    { kind: "separator" },
    { label: labels.reveal, onSelect: actions.reveal },
    { label: labels.copyPath, onSelect: actions.copyPath },
  );
  return entries;
}

/** Message key for "reveal in the file manager", named after the platform's own. */
export function revealLabelKey(platform: DesktopPlatform): string {
  if (platform === "macos") return "fileMenu.revealInFinder";
  if (platform === "windows") return "fileMenu.revealInExplorer";
  return "fileMenu.revealInFileManager";
}
