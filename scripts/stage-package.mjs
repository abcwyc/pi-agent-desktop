import { constants } from "node:fs";
import { access, cp, readdir, stat } from "node:fs/promises";
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
