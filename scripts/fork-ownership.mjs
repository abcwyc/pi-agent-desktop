/**
 * Merge-boundary classifier for pi-web upstream syncs.
 *
 * Reads scripts/fork-ownership.json and answers one question: does this
 * incoming upstream release touch files this fork has also edited? If it does,
 * `git merge` may succeed while the two sides silently disagree, so the sync
 * must stop for a human instead of pushing to main and cutting a signed
 * release unattended.
 *
 * CLI:
 *   node scripts/fork-ownership.mjs classify <paths-file>
 *   git diff --name-only BASE TAG | node scripts/fork-ownership.mjs classify -
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(rootDir, "scripts", "fork-ownership.json");

export const RISK_ORDER = ["low", "medium", "high"];

export async function readForkOwnership() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

/**
 * Intersect an incoming upstream changeset with the fork's drifted files.
 *
 * @param {string[]} changedFiles paths upstream changed since our last sync
 * @param {object} manifest result of readForkOwnership()
 */
export function classifyIncomingChanges(changedFiles, manifest) {
  const ignored = new Set(manifest.ignored ?? []);
  const drifted = manifest.driftedUpstreamFiles ?? {};
  const blockOn = new Set(manifest.autoPushPolicy?.blockOnRisk ?? ["high", "medium"]);

  const overlaps = [];
  for (const file of changedFiles) {
    const path = file.trim();
    if (!path || ignored.has(path)) continue;
    const entry = drifted[path];
    if (entry) overlaps.push({ path, ...entry });
  }

  // Rank by structural drift, not total drift: swapping an inline style object
  // for a className produces a big diff that conflicts textually (and so fails
  // loudly), while a rewritten JSX tree produces the silent kind.
  const weight = (entry) => entry.structuralDrift ?? entry.drift ?? 0;
  overlaps.sort((a, b) => {
    const byRisk = RISK_ORDER.indexOf(b.risk) - RISK_ORDER.indexOf(a.risk);
    return byRisk !== 0 ? byRisk : weight(b) - weight(a);
  });

  const highestRisk = overlaps.reduce(
    (worst, entry) =>
      RISK_ORDER.indexOf(entry.risk) > RISK_ORDER.indexOf(worst) ? entry.risk : worst,
    "none",
  );

  return {
    overlaps,
    highestRisk,
    reviewRequired: overlaps.some((entry) => blockOn.has(entry.risk)),
  };
}

/** Human-readable report for CI logs and PR bodies. */
export function formatReport(result) {
  if (result.overlaps.length === 0) {
    return "No overlap with fork-modified upstream files. Safe for unattended sync.";
  }

  const lines = [
    `This upstream release touches ${result.overlaps.length} file(s) the fork has also modified.`,
    "Review each one for silent semantic conflicts — a clean `git merge` does not mean the two sides agree.",
    "",
  ];
  for (const entry of result.overlaps) {
    const drift =
      entry.structuralDrift === undefined
        ? `${entry.drift} lines`
        : `${entry.structuralDrift} structural of ${entry.drift} lines`;
    lines.push(`- **${entry.path}** (risk: ${entry.risk}, fork drift: ${drift})`);
    lines.push(`  ${entry.reason}`);
  }
  lines.push("", "Boundary rules: docs/ownership-boundaries.md");
  return lines.join("\n");
}

async function readPaths(source) {
  if (source === "-" || source === undefined) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(source, "utf8");
}

async function main() {
  const [command, source] = process.argv.slice(2);
  if (command !== "classify") {
    console.error("usage: node scripts/fork-ownership.mjs classify <paths-file|->");
    process.exitCode = 2;
    return;
  }

  const manifest = await readForkOwnership();
  const changedFiles = (await readPaths(source)).split("\n").filter(Boolean);
  const result = classifyIncomingChanges(changedFiles, manifest);
  const report = formatReport(result);

  console.log(report);

  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import("node:fs/promises");
    // The report is multi-line, so it needs heredoc-delimited output syntax.
    await appendFile(
      process.env.GITHUB_OUTPUT,
      [
        `review_required=${result.reviewRequired}`,
        `highest_risk=${result.highestRisk}`,
        `overlap_count=${result.overlaps.length}`,
        "report<<FORK_OWNERSHIP_EOF",
        report,
        "FORK_OWNERSHIP_EOF",
        "",
      ].join("\n"),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
