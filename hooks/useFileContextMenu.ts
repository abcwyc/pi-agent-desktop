"use client";

import { useCallback, type MouseEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { canUseNativeMenu, showNativeMenu } from "@/lib/desktop-menu";
import { openDomMenu } from "@/lib/dom-menu-store";
import type { NativeMenuEntry } from "@/lib/desktop-menu-model";
import { isTauriDesktop } from "@/lib/desktop-updater";
import {
  listAppsForFileNative,
  openPathWithNative,
  revealItemInDirNative,
  selectApplicationNative,
  type FileOpenApp,
} from "@/lib/desktop-native";
import { getDesktopPlatform } from "@/lib/desktop-window";
import { appListCacheKey, buildFileMenuEntries, revealLabelKey } from "@/lib/file-context-menu";
import { encodeFilePathForApi } from "@/lib/file-paths";

const APP_LIST_TTL_MS = 5 * 60_000;
/** Past this the menu opens without the app list rather than keep the user waiting. */
const APP_LIST_WAIT_MS = 800;

const appListCache = new Map<string, { apps: FileOpenApp[]; at: number }>();

async function loadApps(filePath: string): Promise<FileOpenApp[]> {
  const key = appListCacheKey(filePath);
  const cached = appListCache.get(key);
  if (cached && Date.now() - cached.at < APP_LIST_TTL_MS) return cached.apps;
  const apps = await listAppsForFileNative(filePath);
  appListCache.set(key, { apps, at: Date.now() });
  return apps;
}

async function loadAppsWithinDeadline(filePath: string): Promise<FileOpenApp[]> {
  const slow = new Promise<FileOpenApp[]>((resolve) => setTimeout(() => resolve([]), APP_LIST_WAIT_MS));
  try {
    return await Promise.race([loadApps(filePath), slow]);
  } catch {
    return [];
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/files/${encodeFilePathForApi(filePath)}?type=meta`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The native popup while those are on, otherwise the in-app menu
 * (components/DomContextMenuHost.tsx), which draws the same entries.
 */
async function showMenu(entries: NativeMenuEntry[], at: { x: number; y: number }): Promise<void> {
  // `false` means the native menu could not be shown: fall back to the in-app one.
  if (canUseNativeMenu() && await showNativeMenu(entries, at)) return;
  openDomMenu(entries, at);
}

function reportFailure(action: string, error: unknown): void {
  console.error(`File menu: ${action} failed`, error);
}

export interface FileMenuTarget {
  filePath: string;
  /** PDF page fragment of a markdown link, handed back to `onOpenFile`. */
  page?: number;
  /**
   * The path is only a guess (inline code): ask the server whether the file
   * exists, and when it does not, leave the right-click to the plain
   * copy-selection menu instead of offering file actions.
   */
  verify?: boolean;
}

/**
 * Returns a `contextmenu` handler that shows the file menu in the desktop
 * shell: the native popup while those are on, otherwise the in-app menu. In a
 * browser it does nothing, so the browser's own menu stays.
 */
export function useFileContextMenu(
  onOpenFile?: (filePath: string, page?: number) => void,
): (event: MouseEvent, target: FileMenuTarget) => void {
  const { t } = useI18n();

  return useCallback((event, { filePath, page, verify }) => {
    if (!isTauriDesktop()) return;
    // Claim the right-click now: the checks below are async, and the document
    // fallback in useNativeContextMenu only respects a prevented event.
    event.preventDefault();
    const at = { x: event.clientX, y: event.clientY };

    void (async () => {
      if (verify && !(await fileExists(filePath))) {
        const selection = window.getSelection()?.toString() ?? "";
        if (selection !== "") {
          await showMenu(canUseNativeMenu()
            ? [
                { kind: "predefined", item: "Copy" },
                { kind: "separator" },
                { kind: "predefined", item: "SelectAll" },
              ]
            : [{ label: t("fileMenu.copy"), onSelect: () => { copyText(selection).catch((error) => reportFailure("copy", error)); } }],
          at);
        }
        return;
      }

      const platform = getDesktopPlatform();
      const apps = platform === "macos" ? await loadAppsWithinDeadline(filePath) : null;
      const openWith = (appPath: string) => {
        openPathWithNative(filePath, appPath).catch((error) => reportFailure("open with", error));
      };

      await showMenu(buildFileMenuEntries(
        {
          open: t("fileMenu.open"),
          openWith: t("fileMenu.openWith"),
          otherApp: t("fileMenu.otherApp"),
          reveal: t(revealLabelKey(platform)),
          copyPath: t("fileMenu.copyPath"),
          defaultApp: (name) => t("fileMenu.defaultApp", { name }),
        },
        {
          open: () => onOpenFile?.(filePath, page),
          openWith,
          chooseOtherApp: () => {
            selectApplicationNative()
              .then((appPath) => { if (appPath) openWith(appPath); })
              .catch((error) => reportFailure("choose app", error));
          },
          reveal: () => { revealItemInDirNative(filePath).catch((error) => reportFailure("reveal", error)); },
          copyPath: () => { copyText(filePath).catch((error) => reportFailure("copy path", error)); },
        },
        apps,
      ), at);
    })();
  }, [onOpenFile, t]);
}
