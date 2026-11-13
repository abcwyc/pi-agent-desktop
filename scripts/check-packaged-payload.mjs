import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertPayloadClean, resolvePayloadRoot } from "./packaged-payload.mjs";
import { rootDir } from "./release-components.mjs";

// Standalone re-check, usable on any staged tree and after a manual build:
//   node scripts/check-packaged-payload.mjs                    # src-tauri/resources
//   node scripts/check-packaged-payload.mjs --root .next-desktop/standalone
// `prepare-desktop.mjs` runs the same assertion at both points, so this exists
// for the "the package is already built, is it clean?" question.
const args = process.argv.slice(2);
const rootArgIndex = args.indexOf("--root");
const target = rootArgIndex === -1
  ? join(rootDir, "src-tauri", "resources")
  // Resolved, not joined by hand: an absolute `--root` would otherwise be
  // glued onto the checkout and scan nothing (which used to report "0
  // findings" and exit 0 — a wrong path looked exactly like a clean package).
  : resolvePayloadRoot(rootDir, args[rootArgIndex + 1], { exists: existsSync });

await assertPayloadClean(target, { label: target });
