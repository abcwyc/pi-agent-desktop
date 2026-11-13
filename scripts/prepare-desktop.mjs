import { access, chmod, copyFile, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { constants, existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopTargetTriple } from "./desktop-platform.mjs";
import { assertPayloadClean, findLocalConfigDirs, pruneLocalConfig } from "./packaged-payload.mjs";
import { piPackageDirNames } from "./pi-packages.mjs";
import { dedupeNestedPackages, externalPackageSpecifiers, findNestedPiScopePackages, stageCompletePackage, stageResolvedClosure } from "./stage-package.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopBuildDir = join(rootDir, ".next-desktop");
const standaloneDir = join(desktopBuildDir, "standalone");
const tauriTargetDir = join(rootDir, "src-tauri", "target");
const serverResourcesDir = join(rootDir, "src-tauri", "resources", "server");
const serverHelperDir = join(rootDir, "src-tauri", "resources", "Pi Agent Server.app");
const nodeResourcesDir = join(rootDir, "src-tauri", "resources", "node");

/**
 * CI canary for the payload assertion.
 *
 * A clean CI checkout has no `.pi/` (it is gitignored), so "the payload must not
 * carry a `.pi/`" would pass vacuously. With `PAYLOAD_CANARY=1` this script
 * plants a `.pi/mcp.json` holding a fake `Bearer ak_` token before the build,
 * reports whether the tracer picked it up, and fails if it survives into the
 * payload. A checkout that already has `.pi/mcp.json` is left alone. On exit
 * (including SIGINT/SIGTERM) only what this script created is removed: the file,
 * and the `.pi/` directory only if it did not exist before.
 */
const CANARY_DIR = join(rootDir, ".pi");
const CANARY_FILE = join(CANARY_DIR, "mcp.json");
const CANARY_TOKEN = "Bearer ak_PAYLOADCANARYNOTAREALKEY000000";

async function plantPayloadCanary() {
  if (process.env.PAYLOAD_CANARY !== "1") return false;
  if (existsSync(CANARY_FILE)) {
    console.log("Payload canary: this checkout already has .pi/mcp.json; scanning that instead of planting one");
    return false;
  }
  const createdDir = !existsSync(CANARY_DIR);
  await mkdir(CANARY_DIR, { recursive: true });
  await writeFile(
    CANARY_FILE,
    `${JSON.stringify(
      { mcpServers: { canary: { url: "http://127.0.0.1:1/entity/mcp", headers: { Authorization: CANARY_TOKEN } } } },
      null,
      2,
    )}\n`,
  );
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (createdDir) rmSync(CANARY_DIR, { recursive: true, force: true });
      else rmSync(CANARY_FILE, { force: true });
    } catch {
      // Best effort; the file holds no real credential.
    }
  };
  process.once("exit", cleanup);
  // Node does not emit `exit` for a default SIGINT/SIGTERM.
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      cleanup();
      process.exit(code);
    });
  }
  console.log("Payload canary: planted .pi/mcp.json (fake token) so the payload assertion has something to catch");
  return true;
}

async function runNextBuild() {
  const require = createRequire(import.meta.url);
  const nextBin = require.resolve("next/dist/bin/next", { paths: [rootDir] });

  await rm(desktopBuildDir, { recursive: true, force: true });

  // The packaged server leaks its runtime config into spawned process trees
  // via __NEXT_PRIVATE_STANDALONE_CONFIG; JSON drops function values, so an
  // inherited build dies on `generateBuildId`. Always load config fresh.
  const buildEnv = { ...process.env };
  delete buildEnv.__NEXT_PRIVATE_STANDALONE_CONFIG;
  delete buildEnv.__NEXT_PRIVATE_ORIGIN;

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextBin, "build", "--webpack"], {
      cwd: rootDir,
      env: {
        ...buildEnv,
        NEXT_TELEMETRY_DISABLED: "1",
        PI_WEB_DESKTOP_BUILD: "1",
      },
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Next.js desktop build failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

/**
 * Removes everything under `src-tauri/` that an earlier build has written, so
 * the file tracer cannot fold a previous run's staged server into this one
 * (which nested `resources/server` inside itself on repeated runs).
 *
 * Deleted: `resources/{server,node}`, the macOS helper `.app`, and the payload
 * copies and installers under `target/<profile>/{resources,bundle}`,
 * `target/nsis` and per-triple variants. This includes locally built
 * dmg/deb/NSIS installers. The cargo cache stays.
 *
 * `outputFileTracingExcludes` cannot do this job on Windows (see
 * `next.config.ts`), and `target/<profile>/resources` is filled by `tauri build`
 * without deleting stale files, so the copy has to start empty.
 */
async function clearTracedBuildOutput() {
  const removed = [];
  const remove = async (path) => {
    await rm(path, { recursive: true, force: true });
    removed.push(relative(rootDir, path));
  };

  await remove(serverResourcesDir);
  await remove(serverHelperDir);
  await remove(nodeResourcesDir);

  const profiles = new Set(["debug", "release"]);
  const removeProfileOutput = async (dir) => {
    for (const name of ["resources", "bundle"]) {
      await remove(join(dir, name));
    }
  };

  let targetEntries = [];
  try {
    targetEntries = await readdir(tauriTargetDir, { withFileTypes: true });
  } catch {
    // No `tauri build` has run in this checkout yet.
  }
  for (const entry of targetEntries) {
    if (!entry.isDirectory()) continue;
    const full = join(tauriTargetDir, entry.name);
    if (profiles.has(entry.name)) {
      await removeProfileOutput(full);
      continue;
    }
    if (entry.name === "nsis") {
      // The installer stager embeds the whole payload.
      await remove(full);
      continue;
    }
    // A cross-compilation target triple: `target/<triple>/<profile>/…`.
    let tripleEntries = [];
    try {
      tripleEntries = await readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const inner of tripleEntries) {
      if (inner.isDirectory() && profiles.has(inner.name)) {
        await removeProfileOutput(join(full, inner.name));
      }
    }
  }

  console.log(`Cleared previous build output: ${removed.length} path(s)`);
}

async function assembleServer() {
  await access(join(standaloneDir, "server.js"), constants.R_OK);
  await rm(serverResourcesDir, { recursive: true, force: true });
  await mkdir(dirname(serverResourcesDir), { recursive: true });
  await cp(standaloneDir, serverResourcesDir, { recursive: true });

  // Next's file tracer follows normal imports but intentionally omits files
  // reached through dynamic provider/export/plugin paths. These packages are
  // serverExternalPackages, so preserve their complete runtime `dist/` trees.
  // package.json rides along so dedupeNestedPackages() can read the top-level
  // version: without it a nested duplicate survives dedupe and ships (the
  // 0.4.7 installer shipped exactly that, #72).
  for (const packageName of await piPackageDirNames()) {
    const packageSource = join(rootDir, "node_modules", "@earendil-works", packageName);
    const packageDestination = join(
      serverResourcesDir,
      "node_modules",
      "@earendil-works",
      packageName,
    );
    await cp(join(packageSource, "dist"), join(packageDestination, "dist"), {
      recursive: true,
      force: true,
    });
    await copyFile(join(packageSource, "package.json"), join(packageDestination, "package.json"));
  }

  // node-pty loads its native binding through a runtime-computed path
  // (`prebuilds/${platform}-${arch}/*.node`), which Next's file tracer cannot
  // follow — the standalone output ships only lib/ and package.json. Copy the
  // full prebuilds tree (one signed build serves every platform it supports)
  // and restore the executable bit macOS strips from spawn-helper.
  const ptySource = join(rootDir, "node_modules", "node-pty");
  const ptyDestination = join(serverResourcesDir, "node_modules", "node-pty");
  // Windows starts its output worker and console-list helper by computed path.
  // The tracer omits both; copying native prebuilds alone still exits with -1.
  await cp(join(ptySource, "lib"), join(ptyDestination, "lib"), { recursive: true, force: true });
  const ptyPrebuildsSource = join(ptySource, "prebuilds");
  let ptyPrebuildsPresent = false;
  try {
    await access(ptyPrebuildsSource, constants.R_OK);
    ptyPrebuildsPresent = true;
  } catch {
    // node-pty without prebuilds (source build) — nothing to copy.
  }
  if (ptyPrebuildsPresent) {
    await cp(ptyPrebuildsSource, join(ptyDestination, "prebuilds"), { recursive: true, force: true });
    // macOS strips the executable bit from spawn-helper in every published
    // prebuild (fix once upstream preserves it). Fix all darwin variants so a
    // staged build works on either host architecture.
    for (const variant of ["darwin-arm64", "darwin-x64"]) {
      try {
        await chmod(join(ptyDestination, "prebuilds", variant, "spawn-helper"), 0o755);
      } catch {
        // variant not present in this checkout — nothing to fix.
      }
    }
  }

  // Next's file tracer drops files that a package loads through runtime
  // `require` / `import.meta.resolve`, so jiti and quickjs-wasi arrive
  // incomplete:
  //  - jiti: only lib/jiti-static.mjs survives, the pi-coding-agent bundle
  //    reaches lib/jiti.cjs only through a lazy require("jiti"), and extension
  //    loading fails with "Cannot find module .../jiti/lib/jiti.cjs".
  //  - quickjs-wasi: the sandbox loads "quickjs-wasi/quickjs.wasm" plus the
  //    extensions' *.so through `import.meta.resolve`; without them Code mode
  //    is off for every packaged session.
  // Ship each complete source package over every staged copy of it. Where that
  // copy lives depends on npm's layout (pi 1.0.0 nested quickjs-wasi under
  // pi-coding-agent, pi 1.0.1 hoists it for pi-codemode) and the dedupe pass
  // below deletes nested copies that match the top level, so see
  // stage-package.mjs before assuming a path. `npm run desktop:verify`
  // checks the result by running the packaged Code mode sandbox.
  const stagedNodeModulesDir = join(serverResourcesDir, "node_modules");
  const piCodingAgentModules = join(rootDir, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
  await stageCompletePackage({
    name: "jiti",
    sources: [join(rootDir, "node_modules", "jiti")],
    stagedNodeModulesDir,
  });
  await stageCompletePackage({
    name: "quickjs-wasi",
    sources: [join(piCodingAgentModules, "quickjs-wasi"), join(rootDir, "node_modules", "quickjs-wasi")],
    stagedNodeModulesDir,
  });

  // pi-ai loads Amazon Bedrock through a variable specifier
  // (`import(runtimeSpecifier)` in bedrock-converse-stream.lazy.js) so bundlers
  // cannot follow it into the Node-only AWS SDK. Next's file tracer is one of
  // those bundlers: the standalone server gets pi-ai's dist, but not
  // @aws-sdk/client-bedrock-runtime, and a packaged session on amazon-bedrock
  // dies with ERR_MODULE_NOT_FOUND at the first stream. Copy the closure Node
  // actually resolves from that entry. Nested copies have to stay nested —
  // pi-ai's https-proxy-agent is 9.1.0 because the hoisted one is 7.0.6.
  const bedrockEntry = join(
    rootDir,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "api",
    "bedrock-converse-stream.js",
  );
  await stageResolvedClosure({
    importer: bedrockEntry,
    specifiers: await externalPackageSpecifiers(bedrockEntry, [
      "@aws-sdk/client-bedrock-runtime",
      "@smithy/node-http-handler",
      "http-proxy-agent",
      "https-proxy-agent",
    ]),
    sourceRoot: rootDir,
    stagedNodeModulesDir,
  });

  await copyFile(
    join(rootDir, "desktop", "server-launcher.cjs"),
    join(serverResourcesDir, "desktop-server.cjs"),
  );

  const staticSource = join(desktopBuildDir, "static");
  const staticDestination = join(serverResourcesDir, ".next-desktop", "static");
  await mkdir(dirname(staticDestination), { recursive: true });
  await cp(staticSource, staticDestination, { recursive: true });

  const publicDir = join(rootDir, "public");
  try {
    await access(publicDir, constants.R_OK);
    await cp(publicDir, join(serverResourcesDir, "public"), { recursive: true });
  } catch {
    // `public/` is optional in Next.js projects.
  }
}

/** Paths that would exceed Windows' MAX_PATH once staged on a runner. */
async function findOverlongPaths() {
  // Mirrors the checkout location on a windows-latest runner. Measured even on
  // macOS so a long path fails the build here instead of inside makensis.
  const windowsPrefix = "D:\\a\\pi-agent-desktop\\pi-agent-desktop\\src-tauri\\resources\\server";
  const overlong = [];

  async function walk(dir, relative) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}\\${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), childRelative);
        continue;
      }
      const full = `${windowsPrefix}\\${childRelative}`;
      if (full.length > 260) overlong.push({ length: full.length, path: childRelative });
    }
  }

  await walk(serverResourcesDir, "");
  return overlong;
}

async function findNpmSource() {
  const npmFromCurrentRun = process.env.npm_execpath
    ? dirname(dirname(process.env.npm_execpath))
    : null;
  const candidates = [
    npmFromCurrentRun,
    join(dirname(process.execPath), "node_modules", "npm"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(join(candidate, "bin", "npx-cli.js"), constants.R_OK);
      return candidate;
    } catch {
      // Try the next Node installation layout.
    }
  }

  throw new Error("Could not locate npm next to the bundled Node.js runtime.");
}

async function bundleNodeRuntime() {
  const triple = desktopTargetTriple();
  await rm(serverHelperDir, { recursive: true, force: true });
  await rm(nodeResourcesDir, { recursive: true, force: true });

  let binaryPath;
  if (process.platform === "darwin") {
    // Wrap Node in an LSBackgroundOnly .app so it does not appear in the Dock.
    // Info.plist uses the parent CFBundleIdentifier (com.abcwyc.pi-agent) so
    // macOS TCC SystemPolicyAppData grants persist across launches — a distinct
    // helper id re-prompts "access data from other apps" every cold start.
    const contentsDir = join(serverHelperDir, "Contents");
    binaryPath = join(contentsDir, "MacOS", "node");
    await mkdir(dirname(binaryPath), { recursive: true });
    await copyFile(process.execPath, binaryPath);
    await chmod(binaryPath, 0o755);
    await copyFile(
      join(rootDir, "desktop", "server-helper-Info.plist"),
      join(contentsDir, "Info.plist"),
    );
  } else {
    const executableName = process.platform === "win32" ? "node.exe" : "node";
    binaryPath = join(nodeResourcesDir, executableName);
    await mkdir(nodeResourcesDir, { recursive: true });
    await copyFile(process.execPath, binaryPath);
    await chmod(binaryPath, 0o755);
    await cp(
      await findNpmSource(),
      join(nodeResourcesDir, "node_modules", "npm"),
      { recursive: true },
    );
  }

  return { binaryPath, triple };
}

await clearTracedBuildOutput();
const canaryPlanted = await plantPayloadCanary();
await runNextBuild();

// The tracer is not trusted to have kept this checkout's configuration and
// credentials out: drop the traced `.pi/` (the exclude list is inert on
// Windows), then fail early if anything else got in.
if (process.env.PAYLOAD_CANARY === "1") {
  const traced = await findLocalConfigDirs(standaloneDir);
  console.log(
    traced.length > 0
      ? `Payload canary: the tracer DID pull .pi/ into the standalone (${traced.join(", ")}) — the prune below is what keeps it out of the package`
      : "Payload canary: the tracer no longer pulls .pi/ into the standalone (the assertion stays as belt-and-braces)",
  );
}
const pruned = await pruneLocalConfig(standaloneDir);
if (pruned.length > 0) {
  console.log(`Dropped ${pruned.length} traced local-config director${pruned.length === 1 ? "y" : "ies"}: ${pruned.join(", ")}`);
}
await assertPayloadClean(standaloneDir, { label: ".next-desktop/standalone" });

await assembleServer();

const deduped = await dedupeNestedPackages(serverResourcesDir);
if (deduped > 0) console.log(`Removed ${deduped} redundant nested package cop${deduped === 1 ? "y" : "ies"}`);

// #72 build gate: the app pins the whole @earendil-works scope to one version
// line, so the staged tree must never contain a pi package nested under
// another pi package. If one survives dedupe, shipping it breaks every
// Windows user on the next overwrite install (Node's nearest-module
// resolution loads the stale copy after the upgrade leaves it in place).
const nestedPiScope = await findNestedPiScopePackages(join(serverResourcesDir, "node_modules"));
if (nestedPiScope.length > 0) {
  console.error(
    `Staged node_modules contains @earendil-works packages nested under other @earendil-works packages:\n` +
      nestedPiScope.map((dir) => `  ${relative(rootDir, dir)}`).join("\n"),
  );
  throw new Error(
    "Refusing to package: a nested @earendil-works copy would shadow the top-level one after overwrite installs (#72).",
  );
}

// Fail here rather than inside makensis, which reports a bare "failed opening
// file" and takes an entire signed release build down with it.
const overlong = await findOverlongPaths();
if (overlong.length > 0) {
  console.error(
    `${overlong.length} staged path(s) exceed Windows' 260-character limit:\n` +
      overlong.map(({ length, path }) => `  ${length}  ${path}`).join("\n"),
  );
  throw new Error("Staged paths would break the Windows installer.");
}

const { binaryPath: nodeBinary, triple } = await bundleNodeRuntime();

// Last gate before `tauri build` runs: nothing in the staged payload may carry
// this checkout's own configuration or credentials.
await assertPayloadClean(join(rootDir, "src-tauri", "resources"), { label: "src-tauri/resources" });
console.log(`Desktop server staged at ${serverResourcesDir}`);
console.log(`Node runtime staged at ${nodeBinary} (${triple})`);
