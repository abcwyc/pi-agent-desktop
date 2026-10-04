"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

const expectedParentPid = Number.parseInt(process.env.PI_WEB_PARENT_PID ?? "", 10);

// A normal App quit is handled by the Rust shell. This small watchdog also
// prevents the local server from becoming orphaned if the GUI process crashes
// or is force-terminated by macOS.
const parentWatchdog = setInterval(() => {
  if (!Number.isInteger(expectedParentPid) || process.ppid === 1) {
    process.exit(0);
  }

  try {
    process.kill(expectedParentPid, 0);
  } catch {
    process.exit(0);
  }
}, 1_000);
parentWatchdog.unref();

// ABI-mismatch tourniquet: wrap process.dlopen so a native module compiled
// against a different NODE_MODULE_VERSION surfaces a clear, actionable error
// instead of a cryptic "Live session indexing failed" or a bare
// "compiled against a different Node.js version" that users cannot act on.
//
// This is the desktop-vs-CLI shared-cache clash (#32): the desktop bundles
// Node v22 (ABI 127) while `pi` on the CLI may run under the system Node
// (e.g. v26, ABI 147), and both load .node files from the same
// ~/.pi/agent/npm/node_modules. A .node is locked to the ABI it was built
// for, so whichever runtime did not compile it fails to load it. Catching
// the failure here lets us tell the user how to rebuild instead of leaving
// the session indexer (or any other native extension) half-broken.
if (typeof process.dlopen === "function") {
  const originalDlopen = process.dlopen;
  process.dlopen = function dlopenAbiGuard(module, filename, ...rest) {
    try {
      return originalDlopen.call(this, module, filename, ...rest);
    } catch (error) {
      const message = String(error?.message ?? error);
      // Node's dlopen ABI error names both NODE_MODULE_VERSION numbers.
      const match = /NODE_MODULE_VERSION\s+(\d+)/gi.exec(message);
      const secondMatch = match && /NODE_MODULE_VERSION\s+(\d+)/gi.exec(message.slice(match.index + match[0].length));
      if (match) {
        const compiledAbi = match[1];
        const runtimeAbi = secondMatch ? secondMatch[1] : String(process.versions.modules);
        const enhanced = new Error(
          `[Pi Agent] Native module ABI mismatch: ${filename}\n` +
            `  compiled for NODE_MODULE_VERSION ${compiledAbi}, runtime is NODE_MODULE_VERSION ${runtimeAbi} (Node ${process.version}).\n` +
            `  The desktop bundles Node ${process.version} but ~/.pi/agent/npm is shared with the CLI, which may\n` +
            `  have compiled this .node under a different Node major.\n` +
            `  Fix: run \`pi update --extensions\` (or remove the offending package from\n` +
            `  ~/.pi/agent/npm/node_modules and let pi reinstall it), or run the desktop and\n` +
            `  the CLI under the same Node major version.\n` +
            `  Original error: ${message}`,
        );
        if (error?.code) enhanced.code = error.code;
        throw enhanced;
      }
      throw error;
    }
  };
}

// #72 self-heal: Tauri's NSIS overwrite installs only add files and never
// delete the previous payload, so upgrading in place leaves a stale
// `@earendil-works/*` package nested under another `@earendil-works/*`
// package. Node resolves modules nearest-first, so the stale copy shadows the
// current top-level one and the server dies at import time (e.g. "does not
// provide an export named 'runToolCall'") with every API route returning 500.
// The app pins the whole @earendil-works scope to one version line, so a build
// never legitimately ships such a nested copy — any one found here is an
// overwrite-install leftover and safe to delete. Nested non-pi dependencies
// (chalk, undici, …) are a normal npm layout and are deliberately left alone.
try {
  const scopeDir = path.join(__dirname, "node_modules", "@earendil-works");
  for (const pkg of fs.readdirSync(scopeDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const nestedScopeDir = path.join(scopeDir, pkg.name, "node_modules", "@earendil-works");
    if (!fs.existsSync(nestedScopeDir)) continue;
    for (const entry of fs.readdirSync(nestedScopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      fs.rmSync(path.join(nestedScopeDir, entry.name), { recursive: true, force: true });
      console.error(
        `[Pi Agent] removed stale ${pkg.name}/node_modules/@earendil-works/${entry.name} ` +
          `left behind by an overwrite install (see issue #72)`,
      );
    }
  }
} catch (cleanupError) {
  // Cleanup must never keep the server from starting.
  console.error("[Pi Agent] stale-dependency cleanup failed:", cleanupError);
}

// The standalone Next.js entrypoint is CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./server.js");
