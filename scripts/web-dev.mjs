import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getHelpText, parseLaunchOptions } = require("../bin/pi-web-options.js");
const { getNextNodeArgs } = require("../bin/pi-web-node-args.js");
const { wireChildProcessLifecycle } = require("../bin/process-lifecycle.js");
const { attachReadyHandoff, shouldOpenBrowser } = require("../lib/browser-open.js");

const pkgDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

let launchOptions;
try {
  launchOptions = parseLaunchOptions(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (launchOptions.help) {
  process.stdout.write(getHelpText());
  process.exit(0);
}

if (!loopbackHosts.has(launchOptions.hostname)) {
  console.error("npm run web listens on 127.0.0.1. Use npm run dev:lan to bind another host.");
  process.exit(1);
}

function resolveNextBin() {
  try {
    return require.resolve("next/dist/bin/next", { paths: [pkgDir] });
  } catch {
    try {
      const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
      return path.join(path.dirname(nextPkg), "dist", "bin", "next");
    } catch {
      return path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
    }
  }
}

const nextBin = resolveNextBin();
const child = spawn(
  process.execPath,
  getNextNodeArgs(nextBin, ["dev", "-H", "127.0.0.1", "-p", launchOptions.port]),
  {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, PI_WEB_HOSTNAME: "127.0.0.1" },
  },
);

attachReadyHandoff(child.stdout, {
  port: launchOptions.port,
  wantOpen: launchOptions.openBrowser && shouldOpenBrowser(process.env),
});
wireChildProcessLifecycle(child);
