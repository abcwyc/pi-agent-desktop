# Remote relay with end-to-end encryption — design

Status: design, gated by a feasibility spike (results below). Replaces Tailscale as the
way to follow and drive local sessions from a phone. Tailscale remote access (PR 194)
stays as an optional route.

## Goal and threat model

The user's phone, anywhere, uses the full Pi UI served by their own computer. The
computer opens no port and needs no public address. A relay server the user rents
forwards traffic.

| Party | Trusted with | Must not be able to |
|---|---|---|
| Desktop Pi | everything (it runs the agent) | — |
| Paired phone | owner-level access (same as the computer's own window) | — |
| Relay server | availability, the agent id, traffic volume and timing | read or alter any request, response or page code; run commands |
| Entry host (static site serving the phone shell) | the shell's code | it is trusted code; it must be separate from the relay so a relay compromise cannot swap it |
| Network, push services | nothing | read anything (TLS, Noise, Web Push encryption) |

A relay that serves the page code could rewrite it and defeat any encryption, so the
phone's code comes from a separate static **entry host** (GitHub Pages or any static
host the user controls, at an origin root). The relay only ever sees ciphertext.

## Architecture

```
Phone browser (origin E = entry host)                 Relay (wss)              Desktop Pi
┌───────────────────────────────────────┐
│ /__shell/  trusted shell: Noise + WS ─┼──── ciphertext ───▶ forwards ◀── outbound wss ── connector
│   └ <iframe src="/">  the Pi web app  │                     by agent id                  │
│ service worker: every fetch of the    │                                                  ▼
│   iframe → shell → tunnel; push       │                                     http://127.0.0.1:<port>
└───────────────────────────────────────┘                                     (Next server, prod build)
```

- **Shell** (`/__shell/`, served by E): holds the WebSocket to the relay and the Noise
  session. Hosts the app in a full-screen iframe.
- **Tunnel service worker** (scope `/` on E): intercepts every request the app makes
  (documents, scripts, `fetch`, `EventSource`) and hands it to the shell over a
  `MessageChannel`; streams the response back as a `ReadableStream`. Also handles Web Push.
- **Relay** (`relay/`, Node + `ws`, Docker): pairs one desktop connection with its phone
  connections by agent id and copies opaque frames. Stateless apart from the registry of
  agent public keys.
- **Connector** (desktop, in the Pi server process): keeps the outbound connection,
  terminates Noise, replays each tunneled request against the local Next server, streams
  the response back.

## Crypto

All primitives come from WebCrypto (`crypto.subtle`), available in browsers and in
Node, so one TypeScript module runs on both ends.

- **Handshake: Noise `KK`** (`-> e, es, ss` / `<- e, ee, se`), DH over P-256, AES-256-GCM,
  SHA-256 (HKDF per the Noise spec). Both static keys are known after pairing, so each
  session is mutually authenticated and forward secret. Implemented with Noise's
  `MixKey`/`MixHash` state machine, tested against fixed vectors on both runtimes.
- **Transport:** the two `CipherState`s from `Split()`; 64-bit counters as nonces; any
  decrypt failure or counter gap closes the session.
- **Keys:** desktop static key in `~/.pi/agent/pi-web/relay-identity.json` (0600). Each
  phone generates a non-extractable static key kept in IndexedDB on E.
- **Relay login:** the desktop proves its agent id (hash of its relay-auth public key) by
  signing a relay challenge (ECDSA P-256). Registering a new agent needs the relay's
  admin token, so strangers cannot use the relay.

### Pairing

1. Desktop Settings shows a QR: `https://<E>/__shell/#pair=<relay, agent id, desktop
   static public key, one-time 128-bit secret>`. The fragment never reaches E or the relay.
   The secret expires after 5 minutes and is single use.
2. The phone opens it, creates its static key, and sends `{device public key, name}`
   AES-GCM-encrypted under `HKDF(secret)` through the relay.
3. The desktop shows "Allow <name>?"; on yes it stores the device key. Devices are listed
   and revocable in Settings; revoking closes that device's sessions.

## Desktop side

- Tunneled requests reach Next from 127.0.0.1, so the connector marks them: it strips any
  client-supplied `x-pi-relay-*` headers and adds the device id plus a per-process secret
  (as with the desktop token). `proxy.ts` treats a valid mark as an authenticated **remote**
  request: `isLocalRequest()` is false (no remote-access or chat-unlock changes), native
  dialog routes stay refused.
- `PwaRegistration` must not register `/sw.js` inside the tunnel (it would replace the
  tunnel worker on E): skip when the page is framed.
- Push: the app's existing subscribe flow runs inside the iframe against the tunnel
  worker's registration, so subscriptions carry E's origin and the device id; the desktop
  sends Web Push directly (no relay). The tunnel worker carries the push and
  notification-click handlers from `public/sw.js`.

## Spike results (2026-11-02)

Prototype in the scratchpad (no crypto, one local process standing in for relay +
connector), driven by Playwright against the production build:

| Check | Chromium | WebKit (iPhone 14 profile) |
|---|---|---|
| Full app loads and hydrates through the worker | 918 ms | 986 ms |
| POST with JSON body | ✓ | ✓ |
| SSE delivers start and end of a real run | ✓, no measurable lag | ✓, no measurable lag |
| Page errors | none | none |

Findings that shape the design:
- **Production builds only.** `next dev` stalls behind the tunnel (Turbopack's dev runtime
  needs its HMR WebSocket). The desktop app runs a production build, so this is fine.
- **Service workers cannot carry WebSockets.** The app has none: terminals, file watch,
  OAuth sign-in and session events are all SSE + POST, so every feature tunnels.
- The app's own service worker registration must be blocked inside the tunnel (seen live).
- Cookies set by tunneled responses are ignored; the web password is not used through the
  relay (device keys replace it).

Not yet verified: a real iPhone (service-worker lifetime during long streams, behaviour
when the PWA is backgrounded), and Safari's handling of very large responses.

## Phases

| Phase | Scope | Proof |
|---|---|---|
| R1 transport | framing (multiplexed streams, backpressure, cancel), relay server, connector, shell + worker, app framed-mode fixes | Playwright Chromium + WebKit through a real relay process |
| R2 E2E | Noise KK module, pairing QR, device registry and revoke UI, request marking in the proxy | cross-runtime vectors; tamper / replay / wrong-key tests; a test that the relay sees only ciphertext; mutation tests |
| R3 product | push through the tunnel worker, PWA manifest on E, Settings section, relay Dockerfile, entry-host build, deploy guide | end-to-end on a deployed relay |
| R4 hardening | independent adversarial review, rate limits, reconnect and resume, real iPhone test | review findings closed |

Deployment choice (Hong Kong vs mainland, entry host) is deferred until R3; everything
before that runs on localhost.
