# Deploying the remote relay

How to reach Pi from a phone through your own relay, end to end encrypted.
Design and threat model: [remote-relay.md](remote-relay.md).

## What you need

- **A small server** with a public IP. A Hong Kong lightweight server needs no ICP
  filing; a mainland one needs ICP filing for the domain before HTTPS works. The relay
  only forwards bytes: 1 CPU / 1 GB is plenty.
- **A domain** with two names, for example:
  - `relay.example.com`: the relay (WebSocket over HTTPS);
  - `pi.example.com`: the **entry host** that serves the phone shell (static files).
- **iPhone with iOS 17 or later** (X25519 in WebCrypto), or a current Chrome on Android.

## 1. Run the relay

On the server, with Docker and Docker Compose installed:

```bash
git clone <this repository> pi && cd pi/relay
cat > .env <<EOF
RELAY_DOMAIN=relay.example.com
RELAY_ADMIN_TOKEN=$(openssl rand -hex 32)
EOF
docker compose up -d
```

Point `relay.example.com` (DNS A record) at the server and open ports 80 and 443; Caddy
gets the certificate by itself. Check: `https://relay.example.com/healthz` answers
`{"ok":true,...}`. Keep `RELAY_ADMIN_TOKEN`: the desktop needs it once, to register.

Without Docker: `cd relay && npm ci --omit=dev && RELAY_ADMIN_TOKEN=… PORT=8787 node server.mjs`
behind any TLS reverse proxy (set `RELAY_TRUST_PROXY=1` so rate limits see client addresses).

## 2. Publish the phone shell (the entry host)

Build it on your computer:

```bash
npm run relay:shell        # → relay-shell/dist/
```

Serve `relay-shell/dist/` **at the root** of `https://pi.example.com` (the app's paths
like `/api/…` and `/_next/…` must stay under the shell's service worker). The entry host
serves the code that holds your keys on the phone, so choose by how much you trust it:

| Option | How | Protects against |
|---|---|---|
| **A. Separate static host** (recommended) | Any static hosting with a custom domain at the root: GitHub Pages (custom domain), Cloudflare Pages, an object-storage website. Upload `relay-shell/dist/`. | A compromised relay *server*: it never serves code. |
| **B. Same server, second site** | Add a Caddy site for `pi.example.com` with `root * /srv/pi-shell` and `file_server`, and copy `dist/` there. | A compromised relay *process*, not the whole server. |
| **C. The relay serves it** | Set `RELAY_SHELL_DIR=/srv/pi-shell` on the relay and use the relay's own URL as the entry URL. | Nothing beyond TLS: the relay could serve altered code. Only for trying it out. |

The entry origin must serve **nothing else**: any other page on the same origin (for
example a project site under `user.github.io/…`) could use the phone's stored device key.
Use a dedicated host name at the origin root.

Rebuild and re-upload the shell after updating Pi.

## 3. Connect Pi

On the computer: **Settings › General › Remote relay**

- Relay server: `wss://relay.example.com`
- Phone entry page: `https://pi.example.com`
- Relay admin token: the `RELAY_ADMIN_TOKEN` (used once; Pi deletes it after the relay has
  registered this computer)
- Turn on **Connect to the relay** → "Connected".

The computer must be awake and Pi running (launch at login and "keep in tray" help).

## 4. Pair the phone

1. Settings › Remote relay › **Show QR code** (valid 5 minutes, one phone).
2. Scan it with the phone's camera; Safari opens the pairing page. Name the phone, tap **Pair**.
3. On the computer, **Allow** the request (check the name is your phone).
4. On iPhone: Share → **Add to Home Screen**, and open Pi from the home screen from now on.
5. For notifications: in Pi on the phone, Settings › General › **Notify this device**, then **Test**.

Remove a lost phone in Settings › Remote relay › Paired phones: it is disconnected at once
and its notifications stop.

## Security notes

- The relay sees which desktop is connected, how many bytes flow and when, never content.
- Phones are authenticated by their own keys (Noise IK); the relay admin token only lets a
  desktop register.
- A paired phone has owner-level access (terminals, sessions), like the computer's own
  window. It cannot change the relay, pair phones, unlock chats, or open windows on the computer.
- Where the browser cannot keep a non-extractable key in storage, the shell keeps the
  device key as raw bytes in IndexedDB (see `canKeepCryptoKeys` in `relay-shell/shell.ts`).

## Troubleshooting

| Phone shows | Meaning |
|---|---|
| Offline · computer offline | Pi on the computer is not connected to the relay (asleep, quit, or the relay URL is wrong). |
| This phone is no longer paired | It was removed on the computer; pair again. |
| Pairing failed / expired | Show a new QR code; each one works once for 5 minutes. |

| Settings shows | Meaning |
|---|---|
| Not connected: unknown desktop: registration needs the relay admin token | Enter the admin token and turn the switch off and on. |
| Not connected: key mismatch | This relay knows another key for this computer's id; reset the relay's `agents.json`. |
