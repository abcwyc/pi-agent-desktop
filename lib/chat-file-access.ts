import { closeSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { userHome } from "./user-home";

/**
 * The two ways a chat reaches the user's own files, both bound to what the user said:
 *
 * - it may `read` a file whose path the user wrote in their own message (never a path
 *   that only a web page, a tool result or the model came up with), and one it saved;
 * - it may save a file into the Downloads folder with `save_to_downloads`.
 *
 * Both act on the computer that runs Pi, so they are off when the server listens beyond
 * the loopback address (see `isNetworkExposedServer`).
 */

/** True when the server was started to accept connections from other machines. */
export function isNetworkExposedServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const host = env.PI_WEB_HOSTNAME?.trim().toLowerCase();
  if (!host) return false;
  return !(host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127."));
}

export function chatDownloadsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_DOWNLOAD_DIR?.trim();
  return configured && isAbsolute(configured) ? configured : join(userHome(), "Downloads");
}

// ---------------------------------------------------------------------------------------
// Files the user names
// ---------------------------------------------------------------------------------------

const MAX_PATH_CHARS = 1024;
const MAX_NAMED_PATHS = 100;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}，。；：！？、）】」』》”’]+$/;

/**
 * Paths a message names: absolute (`/Users/me/a.md`, `C:\\Users\\me\\a.md`), `~/…`,
 * `file://…`, either bare (ending at whitespace or closing punctuation, `\\ ` escapes a
 * space) or in quotes (where spaces are fine). Candidates only: whether a file exists and
 * may be read is decided when the chat asks to read it.
 */
export function extractUserNamedPaths(text: string): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    let value = raw.trim();
    if (value.startsWith("file://")) {
      try {
        value = decodeURIComponent(new URL(value).pathname);
      } catch {
        return;
      }
    }
    value = value.replace(/\\ /g, " ").replace(TRAILING_PUNCTUATION, "");
    if (!value || value.length > MAX_PATH_CHARS || value.includes("\0")) return;
    if (!/^(~[\\/]|\/|[A-Za-z]:[\\/])/.test(value)) return;
    // A lone "/" or "~/" names no file.
    if (/^(~?[\\/]?|[A-Za-z]:[\\/]?)$/.test(value)) return;
    if (!found.includes(value)) found.push(value);
  };

  const quoted = /["'`]((?:file:\/\/)?(?:~[\\/]|\/|[A-Za-z]:[\\/])[^"'`\n]*)["'`]|[“‘「『]((?:file:\/\/)?(?:~[\\/]|\/|[A-Za-z]:[\\/])[^”’」』\n]*)[”’」』]/g;
  const withoutQuoted = text.replace(quoted, (_match, straight: string | undefined, curly: string | undefined) => {
    add((straight ?? curly) as string);
    return " ";
  });

  const bare = /(?<![\w.~/:@\\-])((?:file:\/\/)?(?:~[\\/]|\/|[A-Za-z]:[\\/])(?:\\ |[^\s"'`<>|*?])*)/g;
  for (const match of withoutQuoted.matchAll(bare)) add(match[1] as string);

  return found.slice(0, MAX_NAMED_PATHS);
}

function userPath(value: string, cwd: string): string {
  let next = value.trim();
  if (next === "~") next = userHome();
  else if (next.startsWith("~/") || next.startsWith("~\\")) next = join(userHome(), next.slice(2));
  return isAbsolute(next) ? resolve(next) : resolve(cwd, next);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

const SECRET_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker", ".config/gcloud", "Library/Keychains"];
const SECRET_FILE_NAMES = new Set([".netrc", ".npmrc", ".pypirc", ".git-credentials", "id_rsa", "id_ed25519", "id_ecdsa"]);

/**
 * Locations a chat never reads even when the user names them: credentials and keys. The
 * user's own request is the authority for everything else, but a path pasted in from
 * somewhere should not hand over a login.
 */
export function isSensitivePath(realPath: string): boolean {
  const home = safeRealpath(userHome()) ?? userHome();
  if (SECRET_HOME_DIRS.some((dir) => isInside(join(home, dir), realPath))) return true;
  if (SECRET_FILE_NAMES.has(basename(realPath))) return true;
  const agentDir = safeRealpath(getAgentDir()) ?? getAgentDir();
  // Pi's own settings, keys and tokens live as JSON beside the sessions folder.
  return isInside(agentDir, realPath)
    && !isInside(join(agentDir, "sessions"), realPath)
    && basename(realPath).toLowerCase().endsWith(".json");
}

/** The real path of an existing regular file the user named, or null. */
export function resolveNamedFile(candidate: string, cwd: string): string | null {
  const real = safeRealpath(userPath(candidate, cwd));
  if (!real || isSensitivePath(real)) return null;
  try {
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The files a chat may read besides its skills: what the user named in their messages
 * and what the chat saved to Downloads. Candidates are checked against the filesystem at
 * read time, so a file that did not exist when it was named still works later.
 */
export class ChatFileGrants {
  private readonly named = new Set<string>();
  private readonly saved = new Set<string>();
  private scannedSession = false;

  /** Record the paths a user message names. */
  noteUserText(text: string): void {
    for (const path of extractUserNamedPaths(text)) {
      if (this.named.size >= MAX_NAMED_PATHS) break;
      this.named.add(path);
    }
  }

  /** On the first run of a reopened chat, recover the paths its earlier messages named. */
  noteSessionOnce(userTexts: () => Iterable<string>): void {
    if (this.scannedSession) return;
    this.scannedSession = true;
    for (const text of userTexts()) this.noteUserText(text);
  }

  noteSaved(realPath: string): void {
    this.saved.add(realPath);
  }

  /** Whether `real` (already through realpath) is a file the chat may read. */
  allows(real: string, cwd: string): boolean {
    if (isSensitivePath(real)) return false;
    if (this.saved.has(real)) return true;
    for (const candidate of this.named) {
      if (resolveNamedFile(candidate, cwd) === real) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Saving to Downloads
// ---------------------------------------------------------------------------------------

export const DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Files that run or install something when opened. Scripts and source files (`.sh`, `.js`,
 * `.py`, ...) are fine: they are written without the execute bit, so opening one shows it
 * in an editor.
 */
const BLOCKED_DOWNLOAD_EXTENSIONS = new Set([
  ".app", ".command", ".pkg", ".dmg", ".mpkg", ".exe", ".msi", ".bat", ".cmd", ".com", ".scr",
  ".vbs", ".vbe", ".jse", ".wsf", ".jar", ".apk", ".deb", ".rpm", ".run", ".workflow", ".action",
  ".terminal", ".desktop", ".lnk", ".scpt", ".dll", ".dylib", ".pif", ".reg", ".hta", ".cpl",
]);

export type DownloadNameCheck = { ok: true; name: string } | { ok: false; reason: string };

export function checkDownloadName(raw: unknown): DownloadNameCheck {
  if (typeof raw !== "string") return { ok: false, reason: "filename must be a string" };
  const name = raw.normalize("NFC").trim();
  if (!name) return { ok: false, reason: "filename is empty" };
  if (name.length > 200) return { ok: false, reason: "filename is too long" };
  if (/[\\/\0]/.test(name) || name.includes("..")) {
    return { ok: false, reason: "give a file name only, without a folder or path" };
  }
  if (name.startsWith(".")) return { ok: false, reason: "hidden files are not saved" };
  if (/[\x00-\x1f<>:"|?*]/.test(name)) return { ok: false, reason: "filename contains characters that are not allowed" };
  if (/[. ]$/.test(name)) return { ok: false, reason: "filename must not end with a dot or space" };
  const extension = extname(name).toLowerCase();
  if (BLOCKED_DOWNLOAD_EXTENSIONS.has(extension)) {
    return { ok: false, reason: `${extension} files can run code, so a chat does not save them` };
  }
  return { ok: true, name };
}

export interface SavedDownload {
  path: string;
  name: string;
  size: number;
}

/**
 * Write `data` into `dir` under `filename`, never replacing a file: a taken name becomes
 * `name (1).ext`, `name (2).ext`, and so on.
 */
export function saveDownload(dir: string, filename: string, data: Buffer): SavedDownload {
  if (data.length > DOWNLOAD_MAX_BYTES) {
    throw new Error(`file is larger than ${DOWNLOAD_MAX_BYTES / (1024 * 1024)} MB`);
  }
  mkdirSync(dir, { recursive: true });
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const name = attempt === 0 ? filename : `${stem} (${attempt})${extension}`;
    const path = resolve(dir, name);
    // The name has no separators, so this stays directly inside `dir`.
    if (!path.startsWith(resolve(dir) + sep)) throw new Error("invalid file name");
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o644);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    return { path, name, size: data.length };
  }
  throw new Error("too many files with this name already exist");
}
