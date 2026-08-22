import { access, chmod, copyFile, cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopTargetTriple } from "./desktop-platform.mjs";
import { piPackageDirNames } from "./pi-packages.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopBuildDir = join(rootDir, ".next-desktop");
const standaloneDir = join(desktopBuildDir, "standalone");
const serverResourcesDir = join(rootDir, "src-tauri", "resources", "server");
const serverHelperDir = join(rootDir, "src-tauri", "resources", "Pi Agent Server.app");
const nodeResourcesDir = join(rootDir, "src-tauri", "resources", "node");

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

async function assembleServer() {
  await access(join(standaloneDir, "server.js"), constants.R_OK);
  await rm(serverResourcesDir, { recursive: true, force: true });
  await mkdir(dirname(serverResourcesDir), { recursive: true });
  await cp(standaloneDir, serverResourcesDir, { recursive: true });

  // Next's file tracer follows normal imports but intentionally omits files
  // reached through dynamic provider/export/plugin paths. These packages are
  // serverExternalPackages, so preserve their complete runtime `dist/` trees.
  for (const packageName of await piPackageDirNames()) {
    const source = join(rootDir, "node_modules", "@earendil-works", packageName, "dist");
    const destination = join(
      serverResourcesDir,
      "node_modules",
      "@earendil-works",
      packageName,
      "dist",
    );
    await cp(source, destination, { recursive: true, force: true });
  }

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

async function readPackageVersion(packageDir) {
  try {
    return JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** Package directories directly under a node_modules dir, resolving @scope/name. */
async function listPackageDirs(nodeModulesDir) {
  const packages = [];
  let entries;
  try {
    entries = await readdir(nodeModulesDir, { withFileTypes: true });
  } catch {
    return packages;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const entryPath = join(nodeModulesDir, entry.name);

    if (entry.name.startsWith("@")) {
      for (const scoped of await readdir(entryPath, { withFileTypes: true })) {
        if (scoped.isDirectory()) {
          packages.push({ name: `${entry.name}/${scoped.name}`, dir: join(entryPath, scoped.name) });
        }
      }
      continue;
    }
    packages.push({ name: entry.name, dir: entryPath });
  }
  return packages;
}

/**
 * Drop nested node_modules copies that duplicate a top-level package at the
 * exact same version.
 *
 * npm nests a dependency when versions conflict, but it also leaves redundant
 * copies behind. Each nesting level adds ~45 characters to every path inside
 * it, and NSIS cannot open a path over Windows' 260-character MAX_PATH — one
 * file in @mistralai took the whole Windows installer down that way.
 *
 * Only exact version matches are removed, so a genuine version conflict keeps
 * its nested copy and Node still resolves it correctly.
 */
async function dedupeNestedPackages() {
  const topLevelDir = join(serverResourcesDir, "node_modules");
  const topLevelVersions = new Map();
  for (const { name, dir } of await listPackageDirs(topLevelDir)) {
    topLevelVersions.set(name, await readPackageVersion(dir));
  }

  let removed = 0;
  for (const { dir } of await listPackageDirs(topLevelDir)) {
    const nestedDir = join(dir, "node_modules");
    for (const nested of await listPackageDirs(nestedDir)) {
      const topVersion = topLevelVersions.get(nested.name);
      if (!topVersion) continue;
      if (topVersion !== (await readPackageVersion(nested.dir))) continue;

      await rm(nested.dir, { recursive: true, force: true });
      removed += 1;
    }

    // Removing @scope/name leaves the @scope directory behind. An empty
    // directory is harmless to Node but confuses anyone auditing the bundle.
    for (const entry of await readdir(nestedDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !entry.name.startsWith("@")) continue;
      const scopeDir = join(nestedDir, entry.name);
      if ((await readdir(scopeDir)).length === 0) await rm(scopeDir, { recursive: true, force: true });
    }
  }
  return removed;
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

await runNextBuild();
await assembleServer();

const deduped = await dedupeNestedPackages();
if (deduped > 0) console.log(`Removed ${deduped} redundant nested package cop${deduped === 1 ? "y" : "ies"}`);

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

console.log(`Desktop server staged at ${serverResourcesDir}`);
console.log(`Node runtime staged at ${nodeBinary} (${triple})`);
