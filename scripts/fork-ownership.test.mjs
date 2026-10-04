import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  RISK_ORDER,
  classifyIncomingChanges,
  formatReport,
  readForkOwnership,
} from "./fork-ownership.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = await readForkOwnership();

async function exists(relativePath) {
  try {
    await access(join(rootDir, relativePath), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

test("every drifted file entry is well formed", () => {
  const entries = Object.entries(manifest.driftedUpstreamFiles);
  assert.ok(entries.length > 0);

  for (const [path, entry] of entries) {
    assert.ok(RISK_ORDER.includes(entry.risk), `${path}: unknown risk "${entry.risk}"`);
    assert.equal(typeof entry.drift, "number", `${path}: drift must be a number`);
    assert.ok(entry.reason?.length > 20, `${path}: reason must explain the conflict mode`);
  }
});

test("every drifted file has a recorded disposition", () => {
  // New drift should force a decision — keep it and accept the review cost, or
  // remove it — rather than accumulating silently on the blocked list.
  const known = Object.keys(manifest.dispositions);
  assert.ok(known.length > 0, "the manifest must define its disposition vocabulary");

  for (const [path, entry] of Object.entries(manifest.driftedUpstreamFiles)) {
    assert.ok(
      known.includes(entry.disposition),
      `${path}: disposition must be one of ${known.join(", ")}, got ${entry.disposition}`,
    );
  }
});

test("the decision log is not empty", () => {
  // Records why the accepted files were accepted, so the call is not re-litigated
  // from scratch by whoever next reads a blocked sync PR.
  assert.ok(Array.isArray(manifest.decisionLog));
  assert.ok(manifest.decisionLog.length >= 3);
  for (const entry of manifest.decisionLog) {
    assert.match(entry, /^\d{4}-\d{2}-\d{2} — /, `decision log entries need a date: ${entry}`);
  }
});

test("drifted files still exist — stale entries would silently weaken the gate", async () => {
  for (const path of Object.keys(manifest.driftedUpstreamFiles)) {
    assert.ok(await exists(path), `${path} is listed as drifted but is missing from the tree`);
  }
});

test("fork-owned paths still exist", async () => {
  for (const path of manifest.forkOwnedPaths) {
    assert.ok(await exists(path), `${path} is listed as fork-owned but is missing from the tree`);
  }
});

test("the structurally rewritten files are all classified high risk", () => {
  // These carry rewritten JSX or code moved across files, where a clean merge
  // is the dangerous outcome rather than the safe one.
  for (const path of [
    "components/SessionSidebar.tsx",
    "components/AppShell.tsx",
    "components/FileViewer.tsx",
  ]) {
    assert.equal(manifest.driftedUpstreamFiles[path]?.risk, "high", `${path} must stay high risk`);
  }
});

test("risk follows the declared structural-drift thresholds", () => {
  // Guards against someone downgrading a file's risk without actually
  // reverting the structural drift that earned it.
  const { high, medium } = manifest.riskModel.thresholds;
  for (const [path, entry] of Object.entries(manifest.driftedUpstreamFiles)) {
    if (entry.structuralDrift === undefined) continue;
    const expected =
      entry.structuralDrift >= high ? "high" : entry.structuralDrift >= medium ? "medium" : "low";
    assert.equal(
      entry.risk,
      expected,
      `${path}: ${entry.structuralDrift} structural lines should be ${expected}, not ${entry.risk}`,
    );
  }
});

test("files fully adopted from upstream leave the manifest", () => {
  // ModelsConfig was the historical style-only example (146 total / 13
  // structural). After the v0.9.1 sync it tracks upstream exactly, so it
  // must no longer be registered as drifted.
  assert.equal(manifest.driftedUpstreamFiles["components/ModelsConfig.tsx"], undefined);
});

test("high and medium overlaps require review; low-only does not", () => {
  const high = classifyIncomingChanges(["components/SessionSidebar.tsx"], manifest);
  assert.equal(high.reviewRequired, true);
  assert.equal(high.highestRisk, "high");

  const medium = classifyIncomingChanges(["hooks/useTheme.ts"], manifest);
  assert.equal(medium.reviewRequired, true);
  assert.equal(medium.highestRisk, "medium");

  // BranchNavigator crossed into medium with the merged branch-locking work,
  // so the low example is a file still under the threshold.
  const low = classifyIncomingChanges(["lib/directory-browser.ts"], manifest);
  assert.equal(low.reviewRequired, false);
  assert.equal(low.highestRisk, "low");
});

test("untouched and ignored files never trigger review", () => {
  const result = classifyIncomingChanges(
    ["app/api/skills/route.ts", "lib/bounded-form-data.ts", "package-lock.json", ""],
    manifest,
  );
  assert.equal(result.reviewRequired, false);
  assert.equal(result.highestRisk, "none");
  assert.equal(result.overlaps.length, 0);
  assert.match(formatReport(result), /Safe for unattended sync/);
});

test("the real v0.8.0 -> v0.8.1 changeset would have demanded review", () => {
  // Regression anchor: this is what upstream actually shipped in one patch
  // release. Eight of these files carry fork drift, so the previous
  // push-straight-to-signed-release path was applying them unattended.
  // lib/directory-browser.ts is in both lists for a reason — v0.8.1 introduced
  // it, and its homedir() usage is what broke the Windows build.
  const result = classifyIncomingChanges(
    [
      "app/api/models/route.ts",
      "app/globals.css",
      "bin/pi-web.js",
      "components/AppShell.tsx",
      "components/ChatInput.tsx",
      "components/ChatWindow.tsx",
      "components/DirectoryPicker.tsx",
      "components/FileViewer.tsx",
      "components/MessageView.tsx",
      "components/SessionSidebar.tsx",
      "hooks/useAgentSession.ts",
      "lib/directory-browser.ts",
      "lib/rpc-manager.ts",
    ],
    manifest,
  );

  assert.equal(result.reviewRequired, true);
  assert.equal(result.highestRisk, "high");
  assert.equal(result.overlaps.length, 8);
  assert.equal(result.overlaps[0].risk, "high", "the riskiest overlap must be reported first");
  assert.match(formatReport(result), /silent semantic conflicts/);
});
