import { readdir, stat } from "fs/promises";
import { isPermissionError } from "./directory-browser";
import { hasParentDirectorySegment } from "./path-security";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";

/**
 * Whether a workspace the UI already knows (a session cwd, a project root, a
 * folder picked earlier) can still host a run. A workspace deleted outside the
 * app keeps its session history, but every cwd-scoped request then fails —
 * `/api/models` with "Directory does not exist", trust, worktrees and files
 * with "Access denied" — which reads as a model or permission problem (#1061).
 */
export type WorkspaceAvailability = "available" | "missing" | "not-directory" | "unreadable";

/** A workspace the UI knows is gone or unusable, for the composer notice. */
export interface UnavailableWorkspace {
  cwd: string;
  availability: Exclude<WorkspaceAvailability, "available">;
}

export type WorkspaceStatusResult =
  | { ok: true; availability: WorkspaceAvailability }
  | { ok: false };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Classifies `cwd` on disk. Callers must authorize the path first. */
export async function readWorkspaceAvailability(cwd: string): Promise<WorkspaceAvailability> {
  let info;
  try {
    info = await stat(cwd);
  } catch (error) {
    if (isPermissionError(error)) return "unreadable";
    const code = errorCode(error);
    // ENOTDIR: a parent component became a file, so the folder is gone all the same.
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    return "unreadable";
  }
  if (!info.isDirectory()) return "not-directory";
  try {
    await readdir(cwd);
  } catch {
    return "unreadable";
  }
  return "available";
}

/**
 * The status of `cwd`, or `{ ok: false }` when it is not a workspace the
 * caller may ask about. Authorization comes before any filesystem access, so
 * the answer never reveals whether an arbitrary path exists: the path must lie
 * inside the allowed roots lexically (a deleted folder cannot be resolved), and
 * a folder that does exist must also resolve inside them — a link that escapes
 * the roots is refused like any other path outside them.
 */
export async function getWorkspaceStatus(cwd: string, allowedRoots: Set<string>): Promise<WorkspaceStatusResult> {
  if (hasParentDirectorySegment(cwd) || !isFilePathAllowed(cwd, allowedRoots)) return { ok: false };
  const availability = await readWorkspaceAvailability(cwd);
  if (availability !== "missing" && !isExistingFilePathAllowed(cwd, allowedRoots)) return { ok: false };
  return { ok: true, availability };
}
