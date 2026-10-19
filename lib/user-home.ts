import { homedir } from "os";

/**
 * The user's home directory, resolved at runtime rather than at build time.
 *
 * Use this instead of `os.homedir()` anywhere the result reaches a filesystem
 * call — `readdir`, `stat`, `join` feeding one of those, and so on. Path display
 * helpers must also use this: NFT can infer directory assets from string
 * operations even without an fs call (see displaySettingsPath).
 *
 * Next's file tracer (@vercel/nft) statically evaluates the arguments to fs
 * calls. When it can fold an expression down to the home directory it globs
 * that directory at build time to find matching files. The diagnostic run
 * captured the patterns it issued on a Windows runner:
 *
 *     C:\Users\runneradmin/**\/*
 *     C:\Users\runneradmin\pi-cwd-*
 *
 * A Windows user profile contains legacy junctions that loop back on themselves
 * (Application Data -> AppData\Roaming, Local Settings -> AppData\Local,
 * Cookies, ...) plus WindowsApps reparse points. Enumerating them returns
 * EPERM/EACCES, which fails the webpack build outright — that is why the
 * Windows release leg had never once succeeded. macOS runs the same code and
 * never scans outside the checkout, so it only ever broke on Windows.
 *
 * Reading an env var first makes the expression dynamic, so nft stops folding
 * it. PI_AGENT_HOME is also a genuine override for anyone who wants pi's data
 * somewhere other than the real home directory.
 *
 * See .github/workflows/windows-build-debug.yml for the full diagnosis.
 */
export function userHome(): string {
  return process.env.PI_AGENT_HOME || homedir();
}
