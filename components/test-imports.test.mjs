import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// On Windows jiti is expected to resolve "@/x" (no extension) to a path with
// backslashes and "@/x.ts" or "../x.ts" to one with forward slashes, and it
// loads the module once per string (#1211). A test that shares state with a
// component through one of these modules (the I18n context, the draft store)
// must import it as the components do, "@/<path>", or it writes to a copy the
// component never reads.
const SHARED_STATE_MODULES = ["hooks/useI18n", "lib/draft-store"];
const ROOTS = ["app", "components", "hooks", "lib", "public"];

test("tests import shared-state modules without their extension, as the components do", () => {
  const offending = [];
  for (const root of ROOTS) {
    const dir = new URL(`../${root}/`, import.meta.url);
    for (const file of readdirSync(dir, { recursive: true })) {
      if (!file.endsWith(".test.mjs")) continue;
      const source = readFileSync(new URL(file, dir), "utf8");
      for (const [, specifier] of source.matchAll(/\b\w*[jJ]iti\.import\(\s*["']([^"']+)["']/g)) {
        const path = SHARED_STATE_MODULES.find((module) => new RegExp(`(^|/)${module}(\\.tsx?)?$`).test(specifier));
        if (path && specifier !== `@/${path}`) offending.push(`${root}/${file}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(offending, []);
});
