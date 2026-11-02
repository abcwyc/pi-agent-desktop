# Remote relay with end-to-end encryption — design

Status: implemented (R1–R3), verified end to end in Chromium and WebKit; a real iPhone
and a deployed relay are not yet tested. Replaces Tailscale as the way to follow and
drive local sessions from a phone; Tailscale remote access (PR 194) stays as an option.
Deploying: [remote-relay-deploy.md](remote-relay-deploy.md).

## Where it lives

| Piece | Files |
|---|---|
| Noise IK / IKpsk2 (X25519, AES-GCM, SHA-256) on WebCrypto, shared by both ends | `lib/relay/noise.ts` (+ cacophony vectors in `__fixtures__/`) |
| Tunnel frames | `lib/relay/frames.ts` |
| Relay server, Docker, compose with Caddy | `relay/` |
| Desktop connector, storage, request mark, runtime | `lib/relay/connector.ts`, `store.ts`, `mark.ts`, `runtime.ts`; boot in `instrumentation-node.ts` |
| Settings and routes | `components/RelaySection.tsx`, `app/api/relay/**` |
| Phone client, shell, tunnel worker, build | `lib/relay/phone-client.ts`, `relay-shell/`, `scripts/build-relay-shell.mjs` (`npm run relay:shell`) |
| Tests | `lib/relay/*.test.mjs`, `relay/server.test.mjs`, `e2e/relay.mjs` (browser, production build) |

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

- **Handshake: Noise `IK`** (`-> e, es, s, ss` / `<- e, ee, se`), the standard
  `Noise_IK_25519_AESGCM_SHA256`: the phone knows the desktop's static key from pairing
  and sends its own encrypted in the first message; the desktop accepts it only if it is
  a paired device. Mutually authenticated and forward secret. The implementation matches
  the cacophony test vectors for `IK` and `IKpsk2` byte for byte. (The first draft planned
  `KK` over P-256; WebCrypto X25519 in Safari 17 and Chrome 133 made the standard,
  vector-checked suite possible.)
- **Transport:** the two `CipherState`s from `Split()`; 64-bit counters as nonces; any
  decrypt failure or counter gap closes the session.
- **Keys:** desktop static key in `~/.pi/agent/pi-web/relay-identity.json` (0600). Each
  phone generates its static key and keeps it in IndexedDB on E (see "Device key storage").
- **Relay login:** the desktop proves its agent id (hash of its relay-auth public key) by
  signing a relay challenge (ECDSA P-256). Registering a new agent needs the relay's
  admin token, so strangers cannot use the relay.

### Pairing

1. Desktop Settings shows a QR: `https://<E>/__shell/#pair=<relay, agent id, desktop
   static public key, pairing id, one-time 256-bit secret>`. The fragment never reaches E
   or the relay; the shell drops it from the address bar at once. It expires after 5
   minutes and pairs one phone.
2. The phone creates its static key and runs Noise `IKpsk2` with the secret as the psk
   (first byte `2` and the pairing id, in clear, select the ticket).
3. `IKpsk2` mixes the psk in only at the second message, so the desktop's side of the
   handshake completes without proof that the phone holds the secret. The phone's first
   transport message (`PairRequest {name}`, keys derived from the psk) is that proof; only
   then does the desktop show "Allow <name>?" and burn the ticket. (A test caught the
   first version accepting the request before the proof.)
4. On Allow the desktop stores the device key. Devices are listed and revocable in
   Settings; revoking closes that device's sessions and stops its pushes.

Normal sessions run Noise `IK` (first byte `1`): the desktop accepts only a static key
that is in its device list, read from disk on every handshake.

### Device key storage on the phone

The shell keeps a non-extractable `CryptoKey` in IndexedDB where it survives the round
trip; it probes that first (`canKeepCryptoKeys`), because Playwright's WebKit stores a
CryptoKey as null and a phone would forget its pairing on reload. Where the probe fails,
the key is kept as raw bytes. Requires X25519 in WebCrypto: iOS 17 / Chrome 133.

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

## End-to-end results (2026-11-03)

`node e2e/relay.mjs` (production build, real relay, shell on its own origin), Chromium
and WebKit with the iPhone 14 profile, all passing: pair from the QR link and approve on
the desktop; the app loads and hydrates through the tunnel; POST reaches its route; the
relay, pairing and remote-access settings refuse the phone (403, `local: false`); SSE
streams; reload reconnects with the stored key; a cross-site form POST to the entry host
is refused by the tunnel worker; a removed phone is shut out. Node tests add byte-exact
Noise vectors, relay routing and limits, and a man-in-the-middle tap showing the relay
never sees request paths, headers, bodies, device names or the relay mark.

## Independent review and mutation testing (2026-11-03)

An adversarial review found no break in the Noise core, the pairing proof, or the
mark / desktop-token guards, and ten weaker points, all fixed with tests:
the mark secret moved from `process.env` (inherited by the agent's shell) to a
`globalThis` symbol and is accepted only from the connector's own loopback requests;
nonces are reserved before awaiting; a phone counts as connected only after its first
valid frame (a replayed handshake used to); a six-digit code from the handshake hash is
shown on both ends while pairing, and a new QR retires older ones; the relay keeps
authenticated phones apart from strangers (the oldest stranger makes room, a byte budget
before authentication, backpressure) and reports "not paired" as its own close code
(4001); a pairing link on a paired phone needs an explicit replace; the shell frames only
app pages from an outside `?path=` (a link could otherwise run `/api/…` GETs with the
owner's authority) and refuses to run framed; malformed headers and duplicate ends no
longer strand or repeat requests.

Mutation testing reverts each security check alone and requires a failing test: 34 relay
mutants and 25 remote-access mutants, all killed. One equivalent mutant is left out: the
relay's guard against a replaced desktop socket writing, which the relay's own close makes
unreachable in practice.

Not verified here: a real iPhone (service-worker lifetime during long streams, behaviour
when backgrounded, whether Safari keeps the CryptoKey or the raw-key fallback runs), a
deployed relay behind Caddy, and `docker build` (no Docker daemon was running; the image's
steps were reproduced by hand).

## Phases

| Phase | Scope | Proof |
|---|---|---|
| R1 transport | framing (multiplexed streams, backpressure, cancel), relay server, connector, shell + worker, app framed-mode fixes | Playwright Chromium + WebKit through a real relay process |
| R2 E2E | Noise IK / IKpsk2 module, pairing QR, device registry and revoke UI, request marking in the proxy | cross-runtime vectors; tamper / replay / wrong-key tests; a test that the relay sees only ciphertext; mutation tests |
| R3 product | push through the tunnel worker, PWA manifest on E, Settings section, relay Dockerfile, entry-host build, deploy guide | end-to-end on a deployed relay |
| R4 hardening | independent adversarial review, rate limits, reconnect and resume, real iPhone test | review findings closed |

Deployment choice (Hong Kong vs mainland, entry host) is deferred until R3; everything
before that runs on localhost.
