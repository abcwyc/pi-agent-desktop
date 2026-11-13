import { readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * What must never be inside a staged payload.
 *
 * The payload is a distributable installer, so "the checkout happened to have a
 * `.pi/` (with `mcp.json` and its Bearer keys) at that moment" must not be able
 * to reach a user. `scripts/prepare-desktop.mjs` runs this check over the traced
 * standalone output and again over `src-tauri/resources` before `tauri build`
 * can package anything.
 *
 * The rules are about consequences, not the tracer's behaviour: whatever makes a
 * file land in the payload, it fails the build.
 */

/**
 * `matchesPath` gets the payload-relative path with forward slashes;
 * `matchesContent` gets the file decoded as latin1 (one char per byte), which
 * keeps arbitrary binaries matchable without a UTF-8 decode error. A rule with
 * `needle` is only evaluated when the raw bytes contain that literal, so big
 * binaries (node.exe, native addons) are never decoded into a string just to
 * find nothing.
 */
export const PAYLOAD_RULES = [
  {
    id: "local-config",
    describe: "this checkout's own tool configuration directory (`.pi/` holds mcp.json with Bearer keys)",
    matchesPath: (path) => path.split("/").includes(".pi"),
  },
  {
    id: "build-output",
    describe: "build output staged inside the payload (a previous run's server, or `src-tauri/target`)",
    matchesPath: (path) =>
      path.includes("src-tauri/target/") ||
      path.endsWith("src-tauri/target") ||
      /(^|\/)src-tauri\/resources\/(server|node)\//.test(path),
  },
  {
    id: "bearer-token",
    describe: "a Bearer `ak_` token, the key shape this project's own MCP endpoints use (a project-specific check, not a general secret scanner)",
    // Anchored on "Bearer ": a bare `ak_` sweep drowns in `ak_malloced` /
    // `ak_Slovakia` / `ak_ordering` symbols inside node.exe, libvips.dll and
    // the pdb files, which is why no path allowlist is needed for those.
    needle: "Bearer ak_",
    matchesContent: (text) => text.includes("Bearer ak_"),
  },
  {
    id: "private-key",
    describe: "an armoured private key",
    needle: "PRIVATE KEY-----",
    matchesContent: (text) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text),
  },
];

/**
 * Known false positives, matched by payload-relative path.
 *
 * Only for rules where a *string that looks like* a secret is the documented
 * behaviour, never for a real one: an armoured key with a base64 body is not
 * allowlisted anywhere, so this list cannot hide a key.
 */
export const PAYLOAD_ALLOWED = [
  {
    rule: "private-key",
    path: /(^|\/)node_modules\/npm\/(docs|man)\//,
    reason: "npm ships its own documentation, which prints `-----BEGIN PRIVATE KEY-----` as an example",
  },
  {
    rule: "private-key",
    path: /(^|\/)node_modules\/npm\/node_modules\/@npmcli\/config\/lib\/definitions\//,
    reason: "the same example text, as `npm config` help shows it",
  },
];

/** `-----BEGIN … PRIVATE KEY-----` followed by real key material, never allowed. */
const ARMOURED_KEY_BODY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{64,}/;

/**
 * Walks `root` and returns every `.pi` directory as a payload-relative path.
 * With `{ remove: true }` each one is deleted (and not descended into).
 */
async function walkLocalConfigDirs(root, { remove = false } = {}) {
  const found = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name === ".pi") {
        found.push(relative(root, full).split(sep).join("/"));
        if (remove) await rm(full, { recursive: true, force: true });
        continue;
      }
      await visit(full);
    }
  }
  await visit(root);
  return found;
}

/** Every `.pi` directory inside `root`, as payload-relative paths. */
export const findLocalConfigDirs = (root) => walkLocalConfigDirs(root);

/**
 * Deletes the traced copy of this checkout's `.pi/` from a build output tree.
 *
 * The pi SDK resolves its project config as `join(cwd, ".pi", "mcp.json")` with
 * `cwd` defaulting to `process.cwd()`, and `@vercel/nft` evaluates that default
 * against the build directory, so routes importing the SDK trace
 * `<repo>/.pi/mcp.json`. `outputFileTracingExcludes` would drop it, but Next
 * applies those globs as `path.join(dir, exclude)` and picomatch reads the
 * Windows drive backslash as an escape, so on Windows they match nothing.
 *
 * The caller asserts the payload right afterwards, so anything else that
 * arrives still fails the build. Note the rule also matches a `.pi` directory
 * inside `node_modules`; that is fail-closed on purpose.
 */
export const pruneLocalConfig = (root) => walkLocalConfigDirs(root, { remove: true });

function allowedBy(ruleId, path) {
  return PAYLOAD_ALLOWED.find((entry) => entry.rule === ruleId && entry.path.test(path)) ?? null;
}

/**
 * Walks `root` and applies every rule.
 *
 * Returns `{ files, findings, allowed }`: `findings` must be empty for the
 * payload to be packageable, `allowed` is what the allowlist suppressed (so the
 * scan can print it instead of staying silent about it).
 */
export async function scanPayload(root, options = {}) {
  const readFileImpl = options.readFile ?? readFile;
  const readdirImpl = options.readdir ?? readdir;
  const findings = [];
  const allowed = [];
  let files = 0;

  const record = (rule, path, extra = {}) => {
    const entry = allowedBy(rule.id, path);
    if (entry) {
      allowed.push({ rule: rule.id, path, reason: entry.reason });
      return;
    }
    findings.push({ rule: rule.id, describe: rule.describe, path, ...extra });
  };

  async function visit(dir) {
    let entries;
    try {
      entries = await readdirImpl(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const path = relative(root, full).split(sep).join("/");
      for (const rule of PAYLOAD_RULES) {
        if (rule.matchesPath?.(path)) record(rule, path);
      }
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      // Symlinks that a package legitimately needs are not followed (a link
      // into the user's home must not make the scanner read it); their path was
      // still checked above.
      if (!entry.isFile()) continue;
      files += 1;
      let buffer;
      try {
        buffer = await readFileImpl(full);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      let text;
      const decoded = () => (text ??= buffer.toString("latin1"));
      for (const rule of PAYLOAD_RULES) {
        if (!rule.matchesContent) continue;
        if (rule.needle && !buffer.includes(rule.needle, 0, "latin1")) continue;
        if (rule.matchesContent(decoded())) record(rule, path);
      }
      if (buffer.includes("PRIVATE KEY-----", 0, "latin1") && ARMOURED_KEY_BODY.test(decoded())) {
        findings.push({
          rule: "private-key-material",
          describe: "an armoured private key with a key body — never a documentation example",
          path,
        });
      }
    }
  }

  await visit(root);
  return { files, findings, allowed };
}

/** Like `join(base, arg)` but the two mistakes that silently scan the wrong tree
 * are errors instead of surprises: an absolute path (`join` glues it onto the
 * base, e.g. `D:/repo/C:/Users/…`) and a path that does not exist (0 files).
 * The check is fail-closed, so a typo must not be able to produce "0 findings".
 */
export function resolvePayloadRoot(baseDir, arg, { exists } = {}) {
  if (typeof arg !== "string" || arg.trim() === "") {
    throw new Error("a payload root is required (pass a path relative to the repository, e.g. src-tauri/resources)");
  }
  if (isAbsolute(arg) || /^[A-Za-z]:[\\/]/.test(arg)) {
    throw new Error(
      `payload root must be relative to the repository, got ${JSON.stringify(arg)} ` +
        `(an absolute path would be glued onto ${baseDir} and scan nothing)`,
    );
  }
  const resolved = join(baseDir, arg);
  if (exists && !exists(resolved)) {
    throw new Error(`payload root does not exist: ${resolved}`);
  }
  return resolved;
}

/** `"{label}: 12,345 files, no findings (4 allowlisted ...)"` plus the details. */
export function describePayloadScan(label, { files, findings, allowed }) {
  const counts = new Map();
  for (const entry of allowed) counts.set(entry.rule, (counts.get(entry.rule) ?? 0) + 1);
  const allowedSummary = [...counts.entries()].map(([rule, count]) => `${count} allowlisted (${rule})`).join(", ");
  return `${label}: ${files.toLocaleString("en-US")} files scanned, ${findings.length} finding(s)` +
    (allowedSummary ? `, ${allowedSummary}` : "");
}

/**
 * Scans `root` and throws when anything matched.
 *
 * Deliberately no `--soft` / skip switch: a payload that carries this
 * checkout's credentials must not be packaged, and a check that can be waved
 * through is not a check.
 */
export async function assertPayloadClean(root, { label = root, options = {} } = {}) {
  const result = await scanPayload(root, options);
  console.log(describePayloadScan(label, result));
  for (const entry of result.allowed) {
    console.log(`  allowlisted  ${entry.path}  (${entry.reason})`);
  }
  // A scan that saw nothing proves nothing: a wrong `--root`, an empty staging
  // directory, or a build that never staged the payload would all report "0
  // findings" and exit 0, which reads exactly like a clean package. Refuse to
  // call that clean — the scan only counts as evidence if it looked at files.
  if (result.files === 0) {
    throw new Error(
      `Nothing to scan under ${label}: 0 files. That is not a clean payload — ` +
        `check the path (it must be the staged tree, not the checkout root).`,
    );
  }
  if (result.findings.length === 0) return result;
  console.error(`Refusing to package ${label}:`);
  for (const finding of result.findings) {
    console.error(`  [${finding.rule}] ${finding.path}`);
    console.error(`      ${finding.describe}`);
  }
  throw new Error(
    `${result.findings.length} finding(s) in the staged payload ` +
      `(the installer must not carry this checkout's configuration or credentials).`,
  );
}
