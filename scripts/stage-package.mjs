import { constants } from "node:fs";
import { access, cp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Package directories directly under a node_modules dir, resolving @scope/name. */
export async function listPackageDirs(nodeModulesDir) {
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

/** The version field of a package directory, or null when it cannot be read. */
export async function readPackageVersion(packageDir) {
  try {
    return JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
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
 *
 * @param {string} serverResourcesDir the staged `resources/server` directory
 * @param {(message: string) => void} [warn] surfaced when a nested copy is
 *   kept because the top-level version cannot be read — the 0.4.7 payload
 *   shipped exactly such a copy (its top-level `pi-agent-core` had `dist/`
 *   only, no package.json), and a Windows overwrite install left it next to
 *   the new 1.0.2 tree, where ESM nearest-resolution crashed every API route
 *   (#72). Callers must make sure the top-level copy carries a package.json.
 */
export async function dedupeNestedPackages(serverResourcesDir, warn = console.error) {
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
      if (!topVersion) {
        if (nested.name.startsWith("@earendil-works/")) {
          warn(
            `dedupeNestedPackages: keeping nested ${nested.name} — the top-level copy has no readable package.json; ` +
              `the staged tree is incomplete and assertNoNestedPiScopePackages() will fail the build (#72)`,
          );
        }
        continue;
      }
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

/**
 * Every `@earendil-works/*` package nested under another `@earendil-works/*`
 * package in a staged node_modules tree.
 *
 * The app pins the whole @earendil-works scope to one version line, so a
 * staged build never legitimately contains such a copy: npm only nests on
 * version conflicts, and dedupeNestedPackages() strips the redundant
 * duplicates npm leaves behind. A copy that survives is either a packaging
 * bug or — on a user machine — a stale leftover from an overwrite install
 * (#72), where Node's nearest-module resolution loads it instead of the
 * current top-level package and crashes the server at import time. Nested
 * non-pi dependencies (chalk, undici, …) are a normal npm layout and are not
 * reported.
 *
 * @param {string} stagedNodeModulesDir
 * @returns {Promise<string[]>} the offending package directories
 */
export async function findNestedPiScopePackages(stagedNodeModulesDir) {
  const scope = "@earendil-works";
  const found = [];
  const scopeDir = join(stagedNodeModulesDir, scope);
  let packages;
  try {
    packages = (await readdir(scopeDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return found;
  }
  for (const pkg of packages) {
    const nestedScopeDir = join(scopeDir, pkg.name, "node_modules", scope);
    let nested;
    try {
      nested = await readdir(nestedScopeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of nested) {
      if (entry.isDirectory()) found.push(join(nestedScopeDir, entry.name));
    }
  }
  return found;
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every copy of `name` in a staged node_modules tree: the top-level one, and
 * one nested directly under each top-level package.
 */
export async function findStagedCopies(stagedNodeModulesDir, name) {
  const copies = [];
  const topLevel = join(stagedNodeModulesDir, name);
  if (await isDirectory(topLevel)) copies.push(topLevel);
  for (const { dir } of await listPackageDirs(stagedNodeModulesDir)) {
    const nested = join(dir, "node_modules", name);
    if (await isDirectory(nested)) copies.push(nested);
  }
  return copies;
}

/**
 * Ship the complete source package over every copy of it in the staged tree.
 *
 * Next's file tracer keeps only what it can follow statically, so a package
 * that loads files through runtime `import.meta.resolve` / `require` (jiti,
 * quickjs-wasi) arrives incomplete. Which copy the tracer keeps depends on how
 * npm laid out node_modules: pi 1.0.0 nested quickjs-wasi under
 * pi-coding-agent, pi 1.0.1 hoists it to the top level for pi-codemode. So the
 * destination is wherever the staged tree actually has the package, not a
 * fixed path. Overwriting every copy also survives the dedupe pass, which
 * deletes nested copies that match the top-level version and would otherwise
 * leave an incomplete top-level one behind. With no copy staged at all it goes
 * to the top level, which every package's resolution reaches.
 *
 * @param {{ name: string, sources: string[], stagedNodeModulesDir: string }} options
 * @returns {Promise<string[]>} the directories written
 */
export async function stageCompletePackage({ name, sources, stagedNodeModulesDir }) {
  let source = null;
  for (const candidate of sources) {
    try {
      await access(candidate, constants.R_OK);
      source = candidate;
      break;
    } catch {
      // Try the next install shape.
    }
  }
  if (!source) {
    throw new Error(`${name} not found under node_modules; the packaged server would be broken.`);
  }

  const destinations = await findStagedCopies(stagedNodeModulesDir, name);
  if (destinations.length === 0) destinations.push(join(stagedNodeModulesDir, name));
  for (const destination of destinations) {
    await cp(source, destination, { recursive: true, force: true });
  }
  return destinations;
}
