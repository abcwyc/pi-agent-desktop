#!/usr/bin/env node
// Points Casks/pi-agent.rb at a published release.
//   node scripts/update-homebrew-cask.mjs <version> <arm64 sha256> <x86_64 sha256>
// The release workflow calls this after the release is published, with the
// digests GitHub reports for the aarch64 and x64 DMGs.
//
// The cask's head (arch, version, sha256, url) is rewritten as a whole, so a
// cask that still has the Apple-Silicon-only shape (one sha256, an `_aarch64`
// url and `depends_on arch: :arm64`, as through 0.8.5) comes out serving both.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const CASK_PATH = fileURLToPath(new URL("../Casks/pi-agent.rb", import.meta.url));

const SHA256 = /^[0-9a-f]{64}$/;

export function updateCask(source, version, armSha256, intelSha256) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}`);
  if (!SHA256.test(armSha256)) throw new Error(`Invalid arm64 sha256: ${armSha256}`);
  if (!SHA256.test(intelSha256)) throw new Error(`Invalid x86_64 sha256: ${intelSha256}`);
  const head = /^(cask "pi-agent" do\n)[\s\S]*?\n(  name "Pi Agent"\n)/m;
  if (!head.test(source)) throw new Error("Casks/pi-agent.rb has no cask head to update");
  return source
    .replace(head, (_, open, name) => [
      open,
      `  arch arm: "aarch64", intel: "x64"\n\n`,
      `  version "${version}"\n`,
      `  sha256 arm:   "${armSha256}",\n`,
      `         intel: "${intelSha256}"\n\n`,
      `  url "https://github.com/abcwyc/pi-agent-desktop/releases/download/v#{version}/Pi.Agent_#{version}_macOS_#{arch}.dmg"\n`,
      name,
    ].join(""))
    .replace(/^  depends_on arch: :arm64\n/m, "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, rawArm, rawIntel] = process.argv.slice(2);
  if (!version || !rawArm || !rawIntel) {
    console.error("usage: update-homebrew-cask.mjs <version> <arm64 sha256> <x86_64 sha256>");
    process.exit(2);
  }
  const strip = (sha) => sha.replace(/^sha256:/, "");
  const [arm, intel] = [strip(rawArm), strip(rawIntel)];
  await writeFile(CASK_PATH, updateCask(await readFile(CASK_PATH, "utf8"), version, arm, intel));
  console.log(`Casks/pi-agent.rb -> ${version} (arm64 ${arm}, x86_64 ${intel})`);
}
