import { isTauriDesktop } from "@/lib/desktop-updater";
import {
  DESKTOP_API_TOKEN_HEADER,
  MAX_DESKTOP_SAVE_BYTES,
} from "@/lib/desktop-api";

export type DesktopDialogFilter = {
  name: string;
  extensions: string[];
};

export type SelectFilesOptions = {
  multiple?: boolean;
  defaultPath?: string;
  title?: string;
  filters?: DesktopDialogFilter[];
};

export type SelectSavePathOptions = {
  defaultPath?: string;
  title?: string;
  filters?: DesktopDialogFilter[];
};

function asPathArray(selection: string | string[] | null): string[] {
  if (selection == null) return [];
  return Array.isArray(selection) ? selection.filter((path) => typeof path === "string") : [selection];
}

let desktopApiTokenPromise: Promise<string> | null = null;

async function getDesktopApiToken(): Promise<string> {
  if (!isTauriDesktop()) {
    throw new Error("Desktop filesystem authorization is only available in the desktop app.");
  }
  if (!desktopApiTokenPromise) {
    desktopApiTokenPromise = import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string>("get_desktop_api_token"))
      .then((token) => {
        if (typeof token !== "string" || token.length < 32) {
          throw new Error("Desktop filesystem authorization is unavailable.");
        }
        return token;
      })
      .catch((error) => {
        desktopApiTokenPromise = null;
        throw error;
      });
  }
  return desktopApiTokenPromise;
}

async function desktopApiHeaders(initial?: HeadersInit): Promise<Headers> {
  const headers = new Headers(initial);
  headers.set(DESKTOP_API_TOKEN_HEADER, await getDesktopApiToken());
  return headers;
}

async function readResponseBytesWithinLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new Error(`File is larger than ${maxBytes / (1024 * 1024)}MB`);
  }

  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`File is larger than ${maxBytes / (1024 * 1024)}MB`);
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Native folder-selection dialog (desktop shell only). Resolves null when cancelled. */
export async function selectDirectoryNative(defaultPath?: string): Promise<string | null> {
  if (!isTauriDesktop()) {
    throw new Error("Native directory selection is only available in the desktop app.");
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selection = await open({
    directory: true,
    multiple: false,
    defaultPath,
    title: "Select project folder",
  });
  return typeof selection === "string" ? selection : null;
}

/** Native file-selection dialog. Resolves [] when cancelled. */
export async function selectFilesNative(options: SelectFilesOptions = {}): Promise<string[]> {
  if (!isTauriDesktop()) {
    throw new Error("Native file selection is only available in the desktop app.");
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selection = await open({
    directory: false,
    multiple: options.multiple ?? true,
    defaultPath: options.defaultPath,
    title: options.title ?? "Select files",
    filters: options.filters,
  });
  return asPathArray(selection);
}

/** Native save dialog. Resolves null when cancelled. */
export async function selectSavePathNative(options: SelectSavePathOptions = {}): Promise<string | null> {
  if (!isTauriDesktop()) {
    throw new Error("Native save dialog is only available in the desktop app.");
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const selection = await save({
    defaultPath: options.defaultPath,
    title: options.title ?? "Save as",
    filters: options.filters,
  });
  return typeof selection === "string" ? selection : null;
}

/** Open http(s)/mailto URLs in the system handler; fall back to window.open on web. */
export async function openExternal(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) return;

  if (!isTauriDesktop()) {
    window.open(trimmed, "_blank", "noopener,noreferrer");
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_external_url", { url: trimmed });
}

/** Open a local path with the OS default application. */
export async function openPathNative(path: string): Promise<void> {
  if (!isTauriDesktop()) {
    throw new Error("Opening local paths is only available in the desktop app.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_path", { path });
}

/** Reveal a local path in Finder / Explorer / file manager. */
export async function revealItemInDirNative(path: string): Promise<void> {
  if (!isTauriDesktop()) {
    throw new Error("Reveal in folder is only available in the desktop app.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_item_in_dir", { path });
}

/** An application that can open a given file (Finder's "Open With" list). */
export type FileOpenApp = {
  name: string;
  /** Absolute path of the `.app` bundle. */
  path: string;
  isDefault: boolean;
};

/** Applications that can open `path`, default first. Empty where the shell cannot tell (non-macOS). */
export async function listAppsForFileNative(path: string): Promise<FileOpenApp[]> {
  if (!isTauriDesktop()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  const apps = await invoke<FileOpenApp[]>("list_apps_for_file", { path });
  return Array.isArray(apps) ? apps : [];
}

/** Open a local path with a specific application bundle. */
export async function openPathWithNative(path: string, appPath: string): Promise<void> {
  if (!isTauriDesktop()) {
    throw new Error("Open With is only available in the desktop app.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_path_with", { path, app: appPath });
}

/** Native picker for an application bundle (macOS). Resolves null when cancelled. */
export async function selectApplicationNative(): Promise<string | null> {
  const [path] = await selectFilesNative({
    multiple: false,
    defaultPath: "/Applications",
    title: "Choose Application",
    filters: [{ name: "Applications", extensions: ["app"] }],
  });
  return path ?? null;
}

function triggerBrowserDownload(url: string, fileName?: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  if (fileName) anchor.download = fileName;
  anchor.rel = "noopener noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Desktop: save-dialog + write bytes from a same-origin URL.
 * Web: trigger a normal browser download.
 * Returns false when the user cancels the save dialog.
 */
export async function downloadUrlAsFile(url: string, defaultFileName: string): Promise<boolean> {
  if (!isTauriDesktop()) {
    triggerBrowserDownload(url, defaultFileName);
    return true;
  }

  const destPath = await selectSavePathNative({ defaultPath: defaultFileName });
  if (!destPath) return false;

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Download failed (HTTP ${response.status})`);
  }
  const bytes = await readResponseBytesWithinLimit(response, MAX_DESKTOP_SAVE_BYTES);
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  const saveResponse = await fetch("/api/desktop/save", {
    method: "POST",
    headers: await desktopApiHeaders({
      "Content-Type": "application/octet-stream",
      "X-Pi-Dest-Path": encodeURIComponent(destPath),
    }),
    body,
  });
  if (!saveResponse.ok) {
    const data = await saveResponse.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `Save failed (HTTP ${saveResponse.status})`);
  }
  return true;
}

/**
 * Desktop: save-dialog + server-side copy of an allowed local file.
 * Web: trigger download via the files API.
 */
export async function saveLocalFileAs(
  sourcePath: string,
  defaultFileName: string,
  downloadUrl: string,
): Promise<boolean> {
  if (!isTauriDesktop()) {
    triggerBrowserDownload(downloadUrl, defaultFileName);
    return true;
  }

  const destPath = await selectSavePathNative({ defaultPath: defaultFileName });
  if (!destPath) return false;

  const response = await fetch("/api/desktop/save", {
    method: "POST",
    headers: await desktopApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ sourcePath, destPath }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `Save failed (HTTP ${response.status})`);
  }
  return true;
}

export type DesktopImageAttachment = {
  name: string;
  mimeType: string;
  data: string;
  previewUrl: string;
};

/** Read image files selected via native dialog into chat attachment payloads. */
export async function readDesktopImageAttachments(paths: string[]): Promise<DesktopImageAttachment[]> {
  if (paths.length === 0) return [];
  const response = await fetch("/api/desktop/read-images", {
    method: "POST",
    headers: await desktopApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ paths }),
  });
  const data = await response.json().catch(() => ({})) as {
    error?: string;
    files?: Array<{ name: string; mimeType: string; data: string }>;
  };
  if (!response.ok) {
    throw new Error(data.error || `Failed to read images (HTTP ${response.status})`);
  }
  return (data.files ?? []).map((file) => ({
    ...file,
    previewUrl: `data:${file.mimeType};base64,${file.data}`,
  }));
}

export type DesktopImportResult = {
  uploaded: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
};

/** Copy local source paths into a project directory (desktop native import). */
export async function importLocalFiles(options: {
  destDirectory: string;
  sourcePaths: string[];
  conflict: "error" | "overwrite" | "skip";
  encodeDestPath: (path: string) => string;
}): Promise<{ status: number; data: DesktopImportResult & { error?: string; conflicts?: string[]; nonReplaceable?: string[] } }> {
  const response = await fetch(
    `/api/files/${options.encodeDestPath(options.destDirectory)}?type=import&conflict=${options.conflict}`,
    {
      method: "POST",
      headers: await desktopApiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sourcePaths: options.sourcePaths }),
    },
  );
  const data = await response.json().catch(() => ({})) as DesktopImportResult & {
    error?: string;
    conflicts?: string[];
    nonReplaceable?: string[];
  };
  return { status: response.status, data };
}

/** Intercept primary clicks on external anchors so desktop uses the system browser. */
export function handleExternalLinkClick(
  event: {
    preventDefault(): void;
    defaultPrevented: boolean;
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  url: string | undefined | null,
): void {
  if (!url || !isTauriDesktop()) return;
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void openExternal(url);
}

export async function setCloseQuitsNative(quit: boolean): Promise<void> {
  if (!isTauriDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_close_quits", { quit });
}

export async function quitAppNative(): Promise<void> {
  if (!isTauriDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("quit_app");
}

export async function showMainWindowNative(): Promise<void> {
  if (!isTauriDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("show_main_window_cmd");
}

/** Relaunch the desktop shell and its packaged local server. */
export async function relaunchAppNative(): Promise<void> {
  if (!isTauriDesktop()) return;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/**
 * Read an image from the system clipboard as a PNG File.
 *
 * WebKitGTK (Linux) delivers an empty `clipboardData.items` list on paste even
 * when the clipboard holds an image (WebKit bug 320303), so the browser-side
 * paste handler cannot recover it. This native fallback uses the Tauri
 * clipboard-manager `readImage()` command, converts the raw RGBA bytes to a
 * PNG via an offscreen canvas, and returns a File the rest of the paste path
 * can consume exactly like a browser-provided image item.
 *
 * Returns null when there is no image in the clipboard or the runtime is not
 * a Tauri desktop shell.
 */
export async function readClipboardImageFileNative(): Promise<File | null> {
  if (!isTauriDesktop()) return null;
  try {
    const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
    const img = await readImage();
    const rgba = await img.rgba();
    const { width, height } = await img.size();
    if (!width || !height || rgba.byteLength < width * height * 4) return null;
    // RGBA -> PNG via an offscreen canvas.
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
    ctx.putImageData(imageData, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) return null;
    const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 14);
    return new File([blob], `clipboard-${stamp}.png`, { type: "image/png" });
  } catch {
    // Clipboard has no image or read failed — not an error worth surfacing.
    return null;
  }
}

export { isTauriDesktop };
