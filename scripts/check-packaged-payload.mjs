import { join } from "node:path";
import { assertPayloadClean } from "./packaged-payload.mjs";
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
  : join(rootDir, args[rootArgIndex + 1] ?? "");

await assertPayloadClean(target, { label: target });
