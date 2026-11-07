"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

// Timestamp every line the server writes to stdout/stderr. Both streams are
// redirected into server.log by the Rust shell, and Next prints no times of its
// own, so without this a report like "it hung around 3pm" cannot be matched to
// anything in the file. UTC ISO, matching desktop.log.
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  let atLineStart = true;
  stream.write = (chunk, encoding, callback) => {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const stamp = `${new Date().toISOString()} `;
      const stamped = (atLineStart ? stamp : "") + text.replace(/\n(?=[^])/g, `\n${stamp}`);
      atLineStart = text.endsWith("\n");
      return write(stamped, typeof encoding === "string" ? encoding : undefined, typeof encoding === "function" ? encoding : callback);
    }
    return write(chunk, encoding, callback);
  };
}

// Reuse V8's compiled code across launches. The server loads a few hundred
// modules (Next, the pi SDK) and compiling them is most of its cold-start time;
// with the cache a relaunch skips that. Needs Node 22.1+, and a cache that
// cannot be created or read only costs the speed-up.
try {
  const cacheDir = process.env.PI_DESKTOP_COMPILE_CACHE_DIR;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeModule = require("node:module");
  if (cacheDir && typeof nodeModule.enableCompileCache === "function") {
    nodeModule.enableCompileCache(cacheDir);
  }
} catch (cacheError) {
  console.error("[Pi Agent] compile cache unavailable:", cacheError);
}

// Proxy-bypass guard. Next skips middleware (proxy.ts: the password gate and
// the Host/Origin/Fetch-Metadata checks) for any request whose
// `x-prerender-revalidate` header equals the build's `previewModeId`, which sits
// in `.next-desktop/prerender-manifest.json` — the same value in every copy of
// a release, readable by anyone who downloads the installer. Two layers close
// it: the header is stripped from every request before Next sees it (the app
// never uses on-demand revalidation), and the preview secrets are rewritten
// with fresh random values on each start so the shipped ones are worthless
// even if the strip is ever bypassed. Installed before the startup-timing hook
// below so that hook, when it unwraps itself, restores this one.
const PRERENDER_REVALIDATE_HEADERS = ["x-prerender-revalidate", "x-prerender-revalidate-if-generated"];
{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require("node:http");
  const emitWithRevalidateHeaders = http.Server.prototype.emit;
  http.Server.prototype.emit = function emitWithoutRevalidateHeaders(event, ...args) {
    if (event === "request") {
      const headers = args[0]?.headers;
      if (headers) {
        for (const name of PRERENDER_REVALIDATE_HEADERS) delete headers[name];
      }
    }
    return emitWithRevalidateHeaders.call(this, event, ...args);
  };
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto");
  const nextDir = path.join(__dirname, ".next-desktop");
  const manifestPath = path.join(nextDir, "prerender-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!manifest || typeof manifest.preview !== "object" || manifest.preview === null) {
      throw new Error("prerender-manifest.json has no preview block");
    }
    manifest.preview = {
      ...manifest.preview,
      // Lengths mirror what Next generates at build time.
      previewModeId: crypto.randomBytes(16).toString("hex"),
      previewModeSigningKey: crypto.randomBytes(32).toString("hex"),
      previewModeEncryptionKey: crypto.randomBytes(32).toString("hex"),
    };
    // Temp file + rename so the server never reads a half-written manifest.
    const tempPath = `${manifestPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(manifest));
      fs.renameSync(tempPath, manifestPath);
    } catch (writeError) {
      fs.rmSync(tempPath, { force: true });
      throw writeError;
    }
  }
} catch (rotateError) {
  // The header strip above still blocks the bypass; this only loses the second layer.
  console.error("[Pi Agent] could not rotate preview-mode secrets:", rotateError);
}

// Startup diagnostics (#157). On some Windows logins the shell's identity
// probe goes unanswered for over a minute after Next prints "Ready", and the
// log showed nothing in between. These lines say which it was: the probe never
// reaching the server, a slow first response, or the event loop being blocked
// (module loading, antivirus scanning). Observation only, and only for the
// first few minutes; times are seconds since this Node process started.
const sinceStart = () => `+${process.uptime().toFixed(1)}s`;
console.error(`[Pi Agent] launcher started ${sinceStart()} (node ${process.version})`);
{
  const STALL_TICK_MS = 250;
  const STALL_REPORT_MS = 2_000;
  const WATCH_FOR_MS = 5 * 60_000;
  const watchUntil = Date.now() + WATCH_FOR_MS;
  let lastTick = Date.now();
  const stallWatch = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick - STALL_TICK_MS;
    lastTick = now;
    if (gap >= STALL_REPORT_MS) {
      console.error(`[Pi Agent] event loop blocked for ${gap} ms (ended ${sinceStart()})`);
    }
    if (now > watchUntil) clearInterval(stallWatch);
  }, STALL_TICK_MS);
  stallWatch.unref();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require("node:http");
  const originalEmit = http.Server.prototype.emit;
  let sawConnection = false;
  let sawRequest = false;
  http.Server.prototype.emit = function emitWithStartupTiming(event, ...args) {
    if (event === "connection" && !sawConnection) {
      sawConnection = true;
      console.error(`[Pi Agent] first connection accepted ${sinceStart()}`);
    } else if (event === "request" && !sawRequest) {
      sawRequest = true;
      const [request, response] = args;
      const received = Date.now();
      const label = `${request?.method ?? "?"} ${String(request?.url ?? "?").split("?")[0]}`;
      console.error(`[Pi Agent] first request ${label} received ${sinceStart()}`);
      response?.once?.("finish", () => {
        console.error(
          `[Pi Agent] first response ${response.statusCode} sent after ${Date.now() - received} ms (${sinceStart()})`,
        );
      });
    }
    if (sawConnection && sawRequest && http.Server.prototype.emit === emitWithStartupTiming) {
      http.Server.prototype.emit = originalEmit;
    }
    return originalEmit.call(this, event, ...args);
  };
}

const expectedParentPid = Number.parseInt(process.env.PI_WEB_PARENT_PID ?? "", 10);

// A normal App quit is handled by the Rust shell. This small watchdog also
// prevents the local server from becoming orphaned if the GUI process crashes
// or is force-terminated by macOS.
const parentWatchdog = setInterval(() => {
  if (!Number.isInteger(expectedParentPid) || process.ppid === 1) {
    console.error("[Pi Agent] desktop shell is gone (orphaned); server exiting");
    process.exit(0);
  }

  try {
    process.kill(expectedParentPid, 0);
  } catch {
    console.error(`[Pi Agent] desktop shell (pid ${expectedParentPid}) is gone; server exiting`);
    process.exit(0);
  }
}, 1_000);
parentWatchdog.unref();

// Observation only: neither listener changes how the process dies.
process.on("uncaughtExceptionMonitor", (error, origin) => {
  console.error(`[Pi Agent] ${origin}:`, error);
});
process.on("exit", (code) => {
  console.error(`[Pi Agent] server process exit (code ${code})`);
});

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

// #149 self-heal: the packaged build ships no `route-cache`, but at runtime
// Next promotes the build's prerendered page (`server/app/index.html`) into
// `server/route-cache/` and from then on reads that copy first. The path holds
// a route hash only — no build id — so after an overwrite install (which adds
// files and never deletes any) the previous version's page keeps being served
// while the version number and the new `app/index.html` are already current.
// Tie the cache to the build: when BUILD_ID differs from the one recorded next
// to it (or nothing was recorded yet, as on installs that predate this check),
// drop the cache and record the new id. The marker is written only after the
// delete succeeded, so a failure is retried on the next start.
try {
  const nextDir = path.join(__dirname, ".next-desktop");
  const buildIdPath = path.join(nextDir, "BUILD_ID");
  if (fs.existsSync(buildIdPath)) {
    const buildId = fs.readFileSync(buildIdPath, "utf8").trim();
    const markerPath = path.join(nextDir, ".route-cache-build-id");
    let recorded = null;
    try {
      recorded = fs.readFileSync(markerPath, "utf8").trim();
    } catch {
      // No marker yet.
    }
    if (buildId && recorded !== buildId) {
      fs.rmSync(path.join(nextDir, "server", "route-cache"), { recursive: true, force: true });
      fs.writeFileSync(markerPath, buildId);
      console.error(
        `[Pi Agent] cleared route cache for build ${buildId} (previous: ${recorded ?? "none"}; see issue #149)`,
      );
    }
  }
} catch (cacheError) {
  // Cleanup must never keep the server from starting.
  console.error("[Pi Agent] route-cache cleanup failed:", cacheError);
}

// The standalone Next.js entrypoint is CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./server.js");
