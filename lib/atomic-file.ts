import { randomUUID } from "crypto";
import { chmodSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(tempPath, path);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}

/**
 * Replace a file the user owns (a session transcript, settings.json, a SKILL.md,
 * auth.json) so that a crash or a full disk leaves either the old text or the
 * new one, never a truncated file. A symlinked file is replaced at its target,
 * keeping the link (dotfiles setups link ~/.pi/agent files), and the file keeps
 * its permission bits unless `mode` is given.
 */
export function replaceFileAtomicSync(path: string, contents: string, options: { mode?: number } = {}): void {
  let target = path;
  let mode = options.mode;
  try {
    target = realpathSync(path);
    mode ??= statSync(target).mode & 0o7777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tempPath = join(dirname(target), `.${basename(target)}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
    chmodSync(tempPath, mode ?? 0o644);
    renameSync(tempPath, target);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Never created, or already renamed.
    }
    throw error;
  }
}
