import { readdir } from "fs/promises";
import { userHome } from "./user-home.ts";
import path from "path";
import { getAdditionalAllowedRoots, normalizeSlashes } from "./allowed-roots";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { listAllSessions } from "./session-reader";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots";
export { isWindowsAbsolutePath } from "./paths";

// Short-TTL cache for the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly; stored on globalThis so it
// survives Next.js hot-reload.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
}

const ALLOWED_ROOTS_TTL_MS = 5_000;

export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;

  // Stale is fine here: the set only ever lags by one background rebuild, the
  // same staleness the 5 s TTL already accepts, and routes that create a new
  // location call allowFileRoot() directly. Forcing a fresh scan made the 10 s
  // worktree poll pay a full catalogue rebuild whenever agent activity had
  // invalidated the list — which during use is almost always.
  const sessions = await listAllSessions({ allowStale: true });
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  // Also allow the ~/pi-cwd parent that default-cwd creates under (one folder
  // per local date) and the legacy flat ~/pi-cwd-YYYYMMDD layout it used before
  // the upstream merge. Scanning keeps those browsable after a restart, when the
  // in-memory allowFileRoot() additions from the creating request are gone.
  try {
    const base = userHome();
    roots.add(normalizeSlashes(path.join(base, "pi-cwd")));
    for (const name of await readdir(base)) {
      if (/^pi-cwd-\d{8}$/.test(name)) {
        roots.add(normalizeSlashes(path.join(base, name)));
      }
    }
  } catch {
    // ignore if home is unreadable
  }


  for (const root of getAdditionalAllowedRoots()) roots.add(root);

  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

/** Authorize a path lexically, without touching the filesystem. */
export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isPathWithinRoots(target, allowedRoots);
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}

/** Whether `target` is a session cwd / project root / explicitly allowed dir
 *  that currently exists — the gate shared by /api/files and /api/worktrees. */
export async function isCwdAllowed(target: string): Promise<boolean> {
  const allowedRoots = await getAllowedFileRoots();
  return isFilePathAllowed(target, allowedRoots) && isExistingFilePathAllowed(target, allowedRoots);
}
