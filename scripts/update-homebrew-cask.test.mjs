import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CASK_PATH, updateCask } from "./update-homebrew-cask.mjs";

const ARM = "a".repeat(64);
const INTEL = "b".repeat(64);

test("updateCask serves the aarch64 DMG to Apple Silicon and the x64 DMG to Intel", async () => {
  const next = updateCask(await readFile(CASK_PATH, "utf8"), "9.8.7", ARM, INTEL);
  assert.match(next, /^  arch arm: "aarch64", intel: "x64"$/m);
  assert.match(next, /^  version "9\.8\.7"$/m);
  assert.match(next, new RegExp(`^  sha256 arm:   "${ARM}",\\n         intel: "${INTEL}"$`, "m"));
  assert.match(next, /releases\/download\/v#\{version\}\/Pi\.Agent_#\{version\}_#\{arch\}\.dmg"$/m);
  assert.doesNotMatch(next, /depends_on arch:/);
  assert.equal(next.match(/^  sha256 /gm).length, 1);
  assert.equal(next.match(/^  url /gm).length, 1);
});

test("updateCask is stable on a cask it already wrote", async () => {
  const once = updateCask(await readFile(CASK_PATH, "utf8"), "9.8.7", ARM, INTEL);
  assert.equal(updateCask(once, "9.8.7", ARM, INTEL), once);
  const bumped = updateCask(once, "9.8.8", INTEL, ARM);
  const before = once.split("\n");
  const changed = bumped.split("\n").filter((line, i) => line !== before[i]);
  assert.equal(changed.length, 3, "only the version and the two sha256 lines may change");
});

test("updateCask keeps the rest of the cask", async () => {
  const source = await readFile(CASK_PATH, "utf8");
  const next = updateCask(source, "9.8.7", ARM, INTEL);
  const tail = (text) => text.slice(text.indexOf('  name "Pi Agent"'));
  assert.equal(tail(next), tail(source).replace(/^  depends_on arch: :arm64\n/m, ""));
});

test("the cask's fixed parts", async () => {
  const source = await readFile(CASK_PATH, "utf8");
  // `depends_on macos: ">= :big_sur"` is deprecated in Homebrew 5+, and any
  // versioned minimum at or below Big Sur is redundant under Homebrew's own
  // macOS 11 floor, so the bare form is the one Homebrew 7 asks for.
  assert.match(source, /^  depends_on :macos$/m);
  assert.doesNotMatch(
    source,
    /depends_on (?:macos|maximum_macos): "/,
    "depends_on macos: must not use the deprecated string comparison format",
  );
  assert.doesNotMatch(
    source,
    /depends_on macos: :(?:big_sur|catalina|mojave|high_sierra|sierra|el_capitan)/,
    "a minimum macOS at or below Homebrew's own floor is redundant",
  );
  assert.match(source, /auto_updates true/);
  assert.doesNotMatch(source, /"~\/\.pi/, "zap must not delete ~/.pi, which the pi CLI shares");
});

test("updateCask rejects malformed input", async () => {
  const source = await readFile(CASK_PATH, "utf8");
  assert.throws(() => updateCask(source, "v1.2.3", ARM, INTEL), /Invalid version/);
  assert.throws(() => updateCask(source, "1.2.3", "abc", INTEL), /Invalid arm64 sha256/);
  assert.throws(() => updateCask(source, "1.2.3", ARM, "abc"), /Invalid x86_64 sha256/);
  assert.throws(() => updateCask("cask \"x\" do\nend\n", "1.2.3", ARM, INTEL), /no cask head/);
});
