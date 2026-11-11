import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * What must never be inside a staged payload.
 *
 * DEFECT-000089: the first 0.8.2 package of 2026-11-10 shipped
 * `resources/server/.pi/mcp.json`, i.e. the checkout's own MCP endpoint config —
 * complete with `Bearer ak_…` keys for the demo and test stacks. The payload is
 * a distributable installer, so "the repository happened to have a `.pi/` at
 * that moment" must not be able to reach a user. This module is the fail-closed
 * check: `scripts/prepare-desktop.mjs` runs it over the traced standalone
 * output and again over `src-tauri/resources` before `tauri build` can package
 * anything.
 *
 * The rules are deliberately about *consequences*, not about the tracer's
 * behaviour: whatever makes a file land in the payload (a traced `resolve()`,
 * a copied staging directory, a future script), it fails the build.
 */

/**
 * `matchesPath` gets the payload-relative path with forward slashes;
 * `matchesContent` gets the file decoded as latin1 (one char per byte), which
 * keeps arbitrary binaries matchable without a UTF-8 decode error.
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
    describe: "a Bearer `ak_` token, the shape our MCP endpoints authenticate with",
    // Anchored on "Bearer ": a bare `ak_` sweep drowns in `ak_malloced` /
    // `ak_Slovakia` / `ak_ordering` symbols inside node.exe, libvips.dll and
    // the pdb files, which is why no path allowlist is needed for those.
    matchesContent: (text) => text.includes("Bearer ak_"),
  },
  {
    id: "private-key",
    describe: "an armoured private key",
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
 * Deletes the traced copy of this checkout's `.pi/` from a build output tree.
 *
 * The tracer cannot be talked out of it on Windows: the pi SDK resolves its
 * project config directory as `join(cwd, CONFIG_DIR_NAME, "mcp.json")` with
 * `cwd` defaulting to `process.cwd()`, and `@vercel/nft` evaluates that default
 * against the build directory, so every route that imports the SDK traces
 * `<repo>/.pi/mcp.json` (28 route traces in the 2026-11-10 build).
 * `outputFileTracingExcludes` would be the right place to drop it, but Next
 * applies those globs as `path.join(dir, exclude)` and picomatch then reads the
 * Windows drive backslash as an escape, so on Windows they match nothing.
 *
 * Deleting the traced file is not a silent pass: the caller asserts the payload
 * immediately afterwards, so anything *else* that arrives still fails the build.
 */
export async function pruneLocalConfig(root) {
  const removed = [];
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
      const path = relative(root, full).split(sep).join("/");
      if (entry.name === ".pi") {
        await rm(full, { recursive: true, force: true });
        removed.push(path);
        continue;
      }
      await visit(full);
    }
  }
  await visit(root);
  return removed;
}

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
      const text = buffer.toString("latin1");
      for (const rule of PAYLOAD_RULES) {
        if (rule.matchesContent?.(text)) record(rule, path);
      }
      if (ARMOURED_KEY_BODY.test(text)) {
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
 * through is not a check (DEFECT-000089).
 */
export async function assertPayloadClean(root, { label = root, options = {} } = {}) {
  const result = await scanPayload(root, options);
  console.log(describePayloadScan(label, result));
  for (const entry of result.allowed) {
    console.log(`  allowlisted  ${entry.path}  (${entry.reason})`);
  }
  if (result.findings.length === 0) return result;
  console.error(`Refusing to package ${label}:`);
  for (const finding of result.findings) {
    console.error(`  [${finding.rule}] ${finding.path}`);
    console.error(`      ${finding.describe}`);
  }
  throw new Error(
    `${result.findings.length} finding(s) in the staged payload — see DEFECT-000089 (` +
      `the installer must not carry this checkout's configuration or credentials).`,
  );
}
