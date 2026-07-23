import { appendFile } from "node:fs/promises";
import {
  compareVersions,
  readLocalComponentVersions,
  readRemoteComponentVersions,
} from "./release-components.mjs";

const local = await readLocalComponentVersions();
const remote = await readRemoteComponentVersions();
const piUpdate = compareVersions(remote.pi.version, local.pi) > 0;
const piWebUpdate = compareVersions(remote["pi-web"].version, local["pi-web"]) > 0;
const result = {
  pi_version: remote.pi.version,
  pi_tag: remote.pi.tag,
  pi_update: String(piUpdate),
  pi_web_version: remote["pi-web"].version,
  pi_web_tag: remote["pi-web"].tag,
  pi_web_update: String(piWebUpdate),
  pi_agent_desktop_latest: remote["pi-agent-desktop"]?.version ?? "",
  needs_update: String(piUpdate || piWebUpdate),
};

console.log(JSON.stringify({ local, remote, ...result }, null, 2));
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `${Object.entries(result).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}
