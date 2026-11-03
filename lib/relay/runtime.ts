import { getAgentDir } from "../session-reader";
import { RelayConnector } from "./connector";
import { loadOrCreateIdentity, readDevices, readRelayConfig, relayDir } from "./store";

/**
 * The one relay connector of this server process, on globalThis so a hot
 * reload does not start a second connection (same reason as the session
 * registry in rpc-manager.ts).
 */

type RelayGlobal = typeof globalThis & {
  __piRelayConnector?: RelayConnector | null;
  __piRelayStarting?: Promise<RelayConnector | null>;
};
const relayGlobal = globalThis as RelayGlobal;

export function relayFilesDir(): string {
  return relayDir(getAgentDir());
}

/** This server, as the connector reaches it. Next sets PORT for `dev` and `start`; the desktop shell sets it too. */
export function relayLocalOrigin(): string {
  return `http://127.0.0.1:${process.env.PORT || "30141"}`;
}

export function getRelayConnector(): RelayConnector | null {
  return relayGlobal.__piRelayConnector ?? null;
}

/** (Re)start the connector from relay.json; stops it when the relay is off or unset. */
export function restartRelayFromConfig(): Promise<RelayConnector | null> {
  const previous = relayGlobal.__piRelayStarting ?? Promise.resolve(null);
  const next = previous.catch(() => null).then(async () => {
    relayGlobal.__piRelayConnector?.stop();
    relayGlobal.__piRelayConnector = null;
    const dir = relayFilesDir();
    const config = readRelayConfig(dir);
    if (!config?.enabled) return null;
    const identity = await loadOrCreateIdentity(dir);
    const connector = new RelayConnector({
      dir,
      config,
      identity,
      localOrigin: relayLocalOrigin,
      log: (line) => console.log(line),
    });
    connector.start();
    relayGlobal.__piRelayConnector = connector;
    return connector;
  });
  relayGlobal.__piRelayStarting = next;
  return next;
}

/** Whether a relay device id is still paired (push subscriptions check it on each send). */
export function isRelayDevicePaired(deviceId: string): boolean {
  return readDevices(relayFilesDir()).some((device) => device.id === deviceId);
}
