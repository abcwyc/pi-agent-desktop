import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);

test("path display tracing does not enumerate the runtime home directory", { timeout: 20_000 }, async (t) => {
  const base = await mkdtemp(join(os.tmpdir(), "pi-home-tracing-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const app = join(base, "app");
  await mkdir(home);
  await mkdir(app);
  const sentinel = join(home, "unrelated-private-file.txt");
  await writeFile(sentinel, "This fixture must not become an application asset.");

  // Load NFT after mocking os: both ESM and CJS fixtures resolve only this
  // disposable home, never the real profile. Keeping it inside base makes the
  // regression detectable on every OS, independently of cross-drive behavior.
  t.mock.method(os, "homedir", () => home);
  const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
  const source = await readFile(new URL("../lib/enabled-models-runtime.ts", import.meta.url), "utf8");
  const helper = await readFile(new URL("../lib/user-home.ts", import.meta.url), "utf8");
  const legacy = source.replace(
    'import { userHome } from "./user-home";',
    'import { homedir as userHome } from "os";',
  );
  assert.notEqual(legacy, source, "the control must restore static home resolution");

  for (const moduleKind of [ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS]) {
    const transpile = (code) => ts.transpileModule(code, {
      compilerOptions: { module: moduleKind, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const helperPath = join(app, "user-home.js");
    await writeFile(helperPath, transpile(helper));
    for (const [name, code] of [["legacy", legacy], ["fixed", source]]) {
      const entry = join(app, `${name}.js`);
      await writeFile(entry, transpile(code));
      const result = await nodeFileTrace([entry], {
        base,
        processCwd: app,
        // Only trace this module and its real home helper; no SDK graph or build.
        resolve: async (id) => {
          if (id === "./user-home") return helperPath;
          throw new Error(`Outside isolated tracing fixture: ${id}`);
        },
      });
      assert.equal(
        result.fileList.has(relative(base, sentinel)),
        name === "legacy",
        `${name} (${ts.ModuleKind[moduleKind]}): only the legacy code should collect home files`,
      );
    }
  }
});
