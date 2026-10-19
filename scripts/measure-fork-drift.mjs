/**
 * Measure how far this fork has drifted from the pi-web baseline, split by the
 * distinction that actually matters for merge safety:
 *
 *   cosmetic   — inline style objects swapped for classNames, colour tokens.
 *                Produces big diffs, but an upstream edit to the same line
 *                conflicts textually and fails the sync loudly. Safe.
 *   structural — rewritten JSX, new components, logic moved across files.
 *                Merges cleanly while being wrong. This is the real risk.
 *
 * Feeds the `risk` and `structuralDrift` fields in scripts/fork-ownership.json.
 * Re-run it after any significant change to a shared file:
 *
 *   node scripts/measure-fork-drift.mjs [baseline-ref]
 *
 * The baseline defaults to the merge base with the last synced upstream tag.
 */

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readForkOwnership } from "./fork-ownership.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" });

// CSS-ish property names that appear in inline style objects.
const STYLE_PROPS = [
  "display", "flex", "flexDirection", "flexShrink", "gap", "padding", "margin",
  "font", "fontSize", "fontWeight", "fontFamily", "color", "background",
  "backgroundColor", "border", "borderRadius", "width", "height", "minWidth",
  "maxWidth", "minHeight", "maxHeight", "alignItems", "alignSelf", "justifyContent",
  "cursor", "opacity", "position", "top", "left", "right", "bottom", "overflow",
  "overflowX", "overflowY", "transition", "transform", "boxShadow", "lineHeight",
  "letterSpacing", "textAlign", "whiteSpace", "zIndex", "accentColor", "objectFit",
  "pointerEvents", "userSelect", "textOverflow", "borderColor", "borderBottom",
  "borderTop", "borderLeft", "borderRight", "outline", "visibility", "content",
].join("|");

// Each entry is a top-level alternative — keep the `|` joins explicit, since a
// bare concatenation silently turns the alternation into a sequence.
const COSMETIC = new RegExp(
  [
    "className=",
    "style=\\{",
    `^\\s*(?:${STYLE_PROPS})\\s*:`,
    "^\\s*[\"']?#[0-9a-fA-F]{3,8}",
    "var\\(--",
  ].join("|"),
);

function resolveBaseline(explicit) {
  if (explicit) return explicit;
  try {
    return git("merge-base", "HEAD", "pi-web-upstream/main").trim();
  } catch {
    const manifest = baselineFromManifest();
    console.error(`No pi-web-upstream remote; falling back to tag ${manifest}.`);
    return manifest;
  }
}

let cachedManifest;
function baselineFromManifest() {
  cachedManifest ??= manifest;
  // The manifest also carries a human label, e.g. "main@6fcd7d4 (v0.10.0)".
  // Resolve its commit rather than passing that whole label to git as a ref.
  return cachedManifest.upstreamBaseline.match(/@([0-9a-f]{7,40})(?:\s|$)/)?.[1]
    ?? cachedManifest.upstreamBaseline;
}

const manifest = await readForkOwnership();
const baseline = resolveBaseline(process.argv[2]);

// Diffed against the working tree, not HEAD, so the effect of an in-progress
// revert is visible before it is committed.
const files = git("diff", "--name-status", baseline)
  .split("\n")
  .filter((line) => line.startsWith("M\t"))
  .map((line) => line.split("\t")[1])
  .filter((file) => /^(?:components|hooks|lib|app)\/.*\.tsx?$/.test(file));

const rows = files.map((file) => {
  const diff = git("diff", "-U0", baseline, "--", file);
  let cosmetic = 0;
  let structural = 0;

  for (const line of diff.split("\n")) {
    if (!/^[+-]/.test(line) || /^(?:\+\+\+|---)/.test(line)) continue;
    const body = line.slice(1);
    if (!body.trim()) continue;
    if (COSMETIC.test(body)) cosmetic += 1;
    else structural += 1;
  }

  return { file, cosmetic, structural, total: cosmetic + structural };
});

rows.sort((a, b) => b.structural - a.structural);

const { high, medium } = manifest.riskModel.thresholds;
const riskFor = (structural) =>
  structural >= high ? "high" : structural >= medium ? "medium" : "low";

console.log(`baseline: ${baseline}\n`);
console.log(
  "file".padEnd(34),
  "total".padStart(6),
  "cosmetic".padStart(9),
  "structural".padStart(11),
  "  risk",
);

let drifted = 0;
for (const row of rows) {
  const risk = riskFor(row.structural);
  const recorded = manifest.driftedUpstreamFiles[row.file];
  const stale = recorded && recorded.risk !== risk ? `  <- manifest says ${recorded.risk}` : "";
  if (stale) drifted += 1;
  console.log(
    row.file.padEnd(34),
    String(row.total).padStart(6),
    String(row.cosmetic).padStart(9),
    String(row.structural).padStart(11),
    `  ${risk}${stale}`,
  );
}

const totals = rows.reduce(
  (acc, row) => ({ c: acc.c + row.cosmetic, s: acc.s + row.structural }),
  { c: 0, s: 0 },
);
const structuralShare = Math.round((totals.s / (totals.c + totals.s)) * 100);
console.log(
  `\ncosmetic: ${totals.c}   structural: ${totals.s}   (${structuralShare}% structural)`,
);

if (drifted > 0) {
  console.error(`\n${drifted} file(s) disagree with scripts/fork-ownership.json — update it.`);
  process.exitCode = 1;
}
