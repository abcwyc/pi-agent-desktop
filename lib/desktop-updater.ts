export type DesktopUpgradePhase = "checking" | "downloading" | "installing";

export interface DesktopUpgradeProgress {
  phase: DesktopUpgradePhase;
  downloadedBytes?: number;
  totalBytes?: number;
  targetVersion?: string;
}

export interface DesktopUpgradeResult {
  installed: boolean;
  targetVersion?: string;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __PI_REMOTE_BACKEND__?: boolean;
  }
}

export function isTauriDesktop(): boolean {
  return typeof window !== "undefined"
    && Boolean(window.__TAURI_INTERNALS__)
    && !window.__PI_REMOTE_BACKEND__;
}

export async function installLatestDesktopRelease(
  onProgress: (progress: DesktopUpgradeProgress) => void,
): Promise<DesktopUpgradeResult> {
  if (!isTauriDesktop()) {
    throw new Error("Automatic installation is only available in the packaged desktop app.");
  }

  onProgress({ phase: "checking" });
  const [{ check }, { relaunch }] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/plugin-process"),
  ]);
  const update = await check({ timeout: 30_000 });
  if (!update) return { installed: false };

  let downloadedBytes = 0;
  let totalBytes: number | undefined;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      totalBytes = event.data.contentLength;
      onProgress({
        phase: "downloading",
        downloadedBytes,
        totalBytes,
        targetVersion: update.version,
      });
    } else if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      onProgress({
        phase: "downloading",
        downloadedBytes,
        totalBytes,
        targetVersion: update.version,
      });
    } else {
      onProgress({ phase: "installing", targetVersion: update.version });
    }
  });

  onProgress({ phase: "installing", targetVersion: update.version });
  await relaunch();
  return { installed: true, targetVersion: update.version };
}
