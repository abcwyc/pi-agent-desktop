import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * What Settings › Remote access needs from the local Tailscale client: this
 * computer's tailnet name and the signed-in login, read from
 * `tailscale status --json`. The packaged server's PATH rarely includes the
 * CLI, so the usual install locations are tried as well.
 */

export type TailscaleStatus =
  | { state: "missing" }
  | { state: "stopped"; backendState: string }
  | { state: "running"; hostname: string; login: string | null };

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
  ],
  linux: ["/usr/bin/tailscale", "/usr/local/bin/tailscale"],
  win32: ["C:\\Program Files\\Tailscale\\tailscale.exe"],
};

function tailscaleBinaries(platform = process.platform): string[] {
  return [...(CANDIDATES[platform] ?? []).filter((path) => existsSync(path)), "tailscale"];
}

function run(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["status", "--json"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // `status` exits non-zero while logged out but still prints the JSON.
        if (stdout && stdout.trim().startsWith("{")) resolve(stdout);
        else reject(error ?? new Error("tailscale printed no status"));
      });
  });
}

interface StatusJson {
  BackendState?: unknown;
  Self?: { DNSName?: unknown; UserID?: unknown };
  User?: Record<string, { LoginName?: unknown }>;
}

export function parseTailscaleStatus(raw: string): TailscaleStatus {
  const status = JSON.parse(raw) as StatusJson;
  const backendState = typeof status.BackendState === "string" ? status.BackendState : "Unknown";
  const dnsName = typeof status.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  if (backendState !== "Running" || !dnsName) return { state: "stopped", backendState };
  const userId = status.Self?.UserID;
  const loginName = userId !== undefined ? status.User?.[String(userId)]?.LoginName : undefined;
  return {
    state: "running",
    hostname: dnsName,
    login: typeof loginName === "string" && loginName ? loginName.toLowerCase() : null,
  };
}

// Settings and a phone's settings page both ask; one CLI run serves a few seconds of them.
const STATUS_TTL_MS = 5000;
let cached: { at: number; status: Promise<TailscaleStatus> } | null = null;

export function readTailscaleStatus(): Promise<TailscaleStatus> {
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
  const status = readTailscaleStatusUncached();
  cached = { at: Date.now(), status };
  return status;
}

async function readTailscaleStatusUncached(): Promise<TailscaleStatus> {
  for (const binary of tailscaleBinaries()) {
    try {
      return parseTailscaleStatus(await run(binary));
    } catch {
      // Try the next location.
    }
  }
  return { state: "missing" };
}
