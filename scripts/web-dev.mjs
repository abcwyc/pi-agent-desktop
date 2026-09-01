import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parseLaunchOptions } = require("../bin/pi-web-options.js");
const { attachReadyHandoff, followChildUntilExit, shouldOpenBrowser } = require("../lib/browser-open.js");

const pkgDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const { port, openBrowser } = parseLaunchOptions(args);
const wantOpen = openBrowser && shouldOpenBrowser(process.env);

function leftoverNextArgs(argv) {
  const leftover = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") continue;
    if (arg === "-p" || arg === "--port" || arg === "-H" || arg === "--hostname") {
      i += 1;
      continue;
    }
    if (
      arg.startsWith("-p=")
      || arg.startsWith("--port=")
      || arg.startsWith("-H=")
      || arg.startsWith("--hostname=")
    ) {
      continue;
    }
    leftover.push(arg);
  }
  return leftover;
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

const child = spawn(
  process.execPath,
  [resolveNextBin(), "dev", "-H", "127.0.0.1", "-p", port, ...leftoverNextArgs(args)],
  {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
  },
);

attachReadyHandoff(child.stdout, { port, wantOpen });
followChildUntilExit(child);

child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
