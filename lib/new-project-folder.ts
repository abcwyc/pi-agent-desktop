import { isAbsolute, join, relative, resolve, sep, dirname } from "path";
import { existsSync, realpathSync } from "fs";
import { userHome } from "./user-home";

export interface NewProjectFolderResolution {
  /** Absolute path of the folder to create. */
  dir?: string;
  /** User-facing error when the candidate is empty or escapes home. */
  error?: string;
}

/**
 * Normalize a "New Folder…" candidate and confine it to the home directory.
 *
 * A bare name or relative path is created inside the home directory; an
 * absolute or `~/` path is honored only while it stays within home. Creation
 * is a filesystem write, so unlike `/api/cwd/validate` it must not accept
 * arbitrary locations — the dev server can be exposed beyond loopback via
 * `npm run start:lan`. The optional `home` parameter keeps this pure for
 * tests; production callers omit it.
 */
export function resolveNewProjectFolder(
  candidate: string,
  home: string = userHome(),
): NewProjectFolderResolution {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return { error: "Folder name is required" };
  }
  const dir = trimmed === "~"
    ? home
    : trimmed.startsWith("~/")
      ? resolve(home, trimmed.slice(2))
      : isAbsolute(trimmed)
        ? resolve(trimmed)
        : join(home, trimmed);
  const rel = relative(home, dir);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { error: "New folders can only be created inside your home directory" };
  }
  const realHome = realpathSync(home);
  let existing = dir;
  while (!existsSync(existing) && existing !== dirname(existing)) existing = dirname(existing);
  const realParent = realpathSync(existing);
  const parentRel = relative(realHome, realParent);
  if (parentRel === ".." || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) {
    return { error: "New folders can only be created inside your home directory" };
  }
  return { dir };
}
