"use strict";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The warning to print when the server listens beyond loopback, or null when it
 * does not. Shared by `bin/pi-web.js` and the `dev:lan` / `start:lan` scripts,
 * which start Next directly and would otherwise expose the terminal and file
 * APIs without a word.
 */
function getNetworkExposureWarning(hostname, env = process.env) {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return null;
  if (env.PI_WEB_PASSWORD) {
    return `Warning: pi-web is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`;
  }
  return `Warning: pi-web is listening on ${hostname} without authentication. Anyone who can reach this port can run shell commands and read files as you. Set PI_WEB_PASSWORD, or only use this on a trusted network.`;
}

module.exports = { getNetworkExposureWarning };

// `node bin/network-exposure-warning.js <hostname>` prints the warning (if any).
if (require.main === module) {
  const warning = getNetworkExposureWarning(process.argv[2] ?? "");
  if (warning) console.warn(warning);
}
