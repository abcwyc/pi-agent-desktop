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
  }
}

export function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

/**
 * The proxy the server uses (Settings › General › Network proxy, or the
 * environment), so the updater's own HTTP client goes the same way. The Tauri
 * process does not see that setting; a failed lookup just checks directly.
 */
async function updaterProxy(): Promise<string | undefined> {
  try {
    const response = await fetch("/api/network-proxy", { cache: "no-store" });
    if (!response.ok) return undefined;
    const data = await response.json() as { effective?: { url?: unknown } };
    const url = data.effective?.url;
    return typeof url === "string" && url ? url : undefined;
  } catch {
    return undefined;
  }
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
  const proxy = await updaterProxy();
  const update = await check({ timeout: 30_000, ...(proxy ? { proxy } : {}) });
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
