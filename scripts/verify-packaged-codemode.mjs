#!/usr/bin/env node
/**
 * Verifies that Code mode works in the *packaged* server that `npm run
 * desktop:prepare` stages, using the Node runtime bundled with it.
 *
 * Code mode's QuickJS sandbox loads `quickjs-wasi` through runtime
 * `import.meta.resolve`, which Next's file tracer cannot follow, so a packaged
 * install can lose the wasm file while every source-tree test still passes
 * (see the quickjs-wasi copy in prepare-desktop.mjs). This starts the staged
 * server the way the desktop shell does, creates a session (which runs the
 * sandbox self-test in lib/builtin-extensions.ts) and reads the verdict from
 * `GET /api/mcp`, and fails on any "Cannot find module" in the server log.
 *
 * Not covered: jiti (user-extension loading). Its lib/jiti.cjs is only reached
 * on the lazy transform path, which a session start without a real extension
 * does not exercise.
 *
 *   npm run desktop:prepare && node scripts/verify-packaged-codemode.mjs
 *
 * Runs against a throwaway HOME / PI_CODING_AGENT_DIR, never the user's data.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const resourcesDir = join(rootDir, "src-tauri", "resources");
const serverDir = join(resourcesDir, "server");

const NODE_CANDIDATES = [
  join(resourcesDir, "Pi Agent Server.app", "Contents", "MacOS", "node"),
  join(resourcesDir, "node", "node"),
  join(resourcesDir, "node", "node.exe"),
];

const STARTUP_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

function fail(message) {
  console.error(`verify-packaged-codemode: ${message}`);
  process.exitCode = 1;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** The first object under `key` anywhere in a JSON value, depth first. */
export function findKey(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server exited early (code ${child.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/api/home`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the server did not answer within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

async function main() {
  const nodePath = NODE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!nodePath || !existsSync(join(serverDir, "server.js"))) {
    fail("no packaged server found; run `npm run desktop:prepare` first.");
    return;
  }

  const scratch = await mkdtemp(join(tmpdir(), "pi-packaged-codemode-"));
  const agentDir = join(scratch, "agent");
  const workDir = join(scratch, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logChunks = [];
  const child = spawn(nodePath, [join(serverDir, "server.js")], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOME: scratch,
      USERPROFILE: scratch,
      PI_CODING_AGENT_DIR: agentDir,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      PI_WEB_PARENT_PID: String(process.pid),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => logChunks.push(chunk.toString()));
  }
  const logTail = () => logChunks.join("").split("\n").slice(-25).join("\n");

  try {
    console.log(`runtime: ${nodePath}`);
    await waitForServer(baseUrl, child);

    const created = await fetch(`${baseUrl}/api/agent/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: workDir, type: "ensure_session" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!created.ok) {
      fail(`creating a session failed (HTTP ${created.status}): ${await created.text()}`);
      return;
    }

    const overview = await fetch(`${baseUrl}/api/mcp`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!overview.ok) {
      fail(`GET /api/mcp failed (HTTP ${overview.status}): ${await overview.text()}`);
      return;
    }
    const sandbox = findKey(await overview.json(), "sandbox");
    console.log(`sandbox: ${JSON.stringify(sandbox)}`);

    const resolutionErrors = [...new Set(logChunks.join("").match(/(?:Cannot find module|ERR_MODULE_NOT_FOUND)[^\n]*/g) ?? [])];
    if (sandbox?.state === "available" && resolutionErrors.length === 0) {
      console.log("OK: the packaged Code mode sandbox ran its self-test; no module resolution errors in the server log.");
    } else if (sandbox?.state === "available") {
      fail(`the server log reports missing modules:\n  ${resolutionErrors.join("\n  ")}`);
      console.error(`--- server log (tail) ---\n${logTail()}`);
    } else {
      fail(`the packaged Code mode sandbox is not available: ${JSON.stringify(sandbox)}`);
      console.error(`--- server log (tail) ---\n${logTail()}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    console.error(`--- server log (tail) ---\n${logTail()}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
      setTimeout(resolve, 3_000).unref();
    });
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
