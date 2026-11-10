#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHelpText, parseLaunchOptions } = require("./pi-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getNextNodeArgs } = require("./pi-web-node-args");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("./process-lifecycle");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkNetworkExposure } = require("./network-exposure-warning");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { attachReadyHandoff, shouldOpenBrowser } = require("../lib/browser-open");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rotatePreviewSecrets, getRotationWarning } = require("./rotate-preview-secrets");

let launchOptions;
try {
  launchOptions = parseLaunchOptions();
} catch (error) {
  fs.writeSync(
    process.stderr.fd,
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

if (launchOptions.help) {
  fs.writeSync(process.stdout.fd, getHelpText());
  process.exit(0);
}

const { port, hostname, openBrowser } = launchOptions;
const wantOpen = openBrowser && shouldOpenBrowser(process.env);

const exposure = checkNetworkExposure(hostname);
if (exposure) console.warn(exposure.message);
if (exposure?.fatal) process.exit(1);

const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");

// Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
// may not exist when installed via npx).
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
} catch {
  // Fallback: locate next package root and derive the bin path manually.
  try {
    const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
    nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
  } catch {
    nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
  }
}

if (!fs.existsSync(nextDir)) {
  console.error("Build artifacts not found. Please report this issue.");
  process.exit(1);
}

// Replace the published preview-mode secrets with fresh random values so the
// previewModeId baked into the npm tarball cannot be used to skip the proxy
// (via the x-prerender-revalidate header). Must happen before `next start`.
const rotation = rotatePreviewSecrets(nextDir);
if (!rotation.ok) {
  console.warn(getRotationWarning(rotation.reason));
}

const nextArgs = ["start", "-p", port];
nextArgs.push("-H", hostname);

// Always run next's JS entry with node directly — avoids .bin symlink issues
// and path-with-spaces problems on Windows when shell: true is used.
const child = spawn(process.execPath, getNextNodeArgs(nextBin, nextArgs), {
  cwd: pkgDir,
  stdio: ["inherit", "pipe", "inherit"],
  env: { ...process.env, PI_WEB_HOSTNAME: hostname, PI_WEB_VERBOSE: launchOptions.verbose ? "1" : "0" },
});
attachReadyHandoff(child.stdout, { port, wantOpen });
wireChildProcessLifecycle(child);
