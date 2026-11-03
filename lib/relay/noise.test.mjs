import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const noise = await import("./noise.ts");
const { vectors } = JSON.parse(readFileSync(new URL("./__fixtures__/noise-vectors.json", import.meta.url), "utf8"));

const hex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const toHex = (b) => Buffer.from(b).toString("hex");

for (const vector of vectors) {
  test(`${vector.protocol_name}: matches the cacophony test vector byte for byte`, async () => {
    const pattern = vector.protocol_name.split("_")[1];
    const initiator = await noise.HandshakeState.create({
      pattern, initiator: true, prologue: hex(vector.init_prologue),
      s: await noise.keyPairFromPrivate(hex(vector.init_static)),
      e: await noise.keyPairFromPrivate(hex(vector.init_ephemeral)),
      rs: hex(vector.init_remote_static),
      psk: vector.init_psks?.[0] && hex(vector.init_psks[0]),
    });
    const responder = await noise.HandshakeState.create({
      pattern, initiator: false, prologue: hex(vector.resp_prologue),
      s: await noise.keyPairFromPrivate(hex(vector.resp_static)),
      e: await noise.keyPairFromPrivate(hex(vector.resp_ephemeral)),
      psk: vector.resp_psks?.[0] && hex(vector.resp_psks[0]),
    });

    const [m0, m1, ...transport] = vector.messages;
    const c0 = await initiator.writeMessage(hex(m0.payload));
    assert.equal(toHex(c0), m0.ciphertext, "message 0");
    assert.equal(toHex(await responder.readMessage(c0)), m0.payload);
    const c1 = await responder.writeMessage(hex(m1.payload));
    assert.equal(toHex(c1), m1.ciphertext, "message 1");
    assert.equal(toHex(await initiator.readMessage(c1)), m1.payload);

    const i = await initiator.split();
    const r = await responder.split();
    assert.equal(toHex(i.handshakeHash), vector.handshake_hash);
    assert.equal(toHex(r.handshakeHash), vector.handshake_hash);
    assert.deepEqual(r.remoteStatic, (await noise.keyPairFromPrivate(hex(vector.init_static))).publicKey);

    for (const [index, message] of transport.entries()) {
      const [sender, receiver] = index % 2 === 0 ? [i, r] : [r, i];
      const ciphertext = await sender.send.encrypt(new Uint8Array(0), hex(message.payload));
      assert.equal(toHex(ciphertext), message.ciphertext, `transport message ${index + 2}`);
      assert.equal(toHex(await receiver.receive.decrypt(new Uint8Array(0), ciphertext)), message.payload);
    }
  });
}

async function pair(pattern = "IK", { psk, responderPsk } = {}) {
  const desktop = await noise.generateKeyPair();
  const phone = await noise.generateKeyPair();
  const prologue = new TextEncoder().encode("pi-relay/1 agent-x");
  const initiator = await noise.HandshakeState.create({ pattern, initiator: true, prologue, s: phone, rs: desktop.publicKey, psk });
  const responder = await noise.HandshakeState.create({ pattern, initiator: false, prologue, s: desktop, psk: responderPsk ?? psk });
  return { desktop, phone, initiator, responder, prologue };
}

test("a fresh IK session round-trips and the desktop learns the phone's key", async () => {
  const { phone, initiator, responder } = await pair();
  await responder.readMessage(await initiator.writeMessage());
  assert.deepEqual(responder.remoteStatic, phone.publicKey);
  await initiator.readMessage(await responder.writeMessage());
  const a = await initiator.split();
  const b = await responder.split();
  const msg = new TextEncoder().encode("hello");
  assert.deepEqual(await b.receive.decrypt(new Uint8Array(0), await a.send.encrypt(new Uint8Array(0), msg)), msg);
});

test("a phone that does not know the desktop's real key cannot finish the handshake", async () => {
  const { initiator } = await pair();
  const imposter = await noise.generateKeyPair();
  const wrong = await noise.HandshakeState.create({ pattern: "IK", initiator: false, prologue: new TextEncoder().encode("pi-relay/1 agent-x"), s: imposter });
  await assert.rejects(wrong.readMessage(await initiator.writeMessage()), noise.NoiseError);
});

test("a different prologue (another agent id) is refused", async () => {
  const desktop = await noise.generateKeyPair();
  const phone = await noise.generateKeyPair();
  const i = await noise.HandshakeState.create({ pattern: "IK", initiator: true, prologue: new TextEncoder().encode("pi-relay/1 agent-a"), s: phone, rs: desktop.publicKey });
  const r = await noise.HandshakeState.create({ pattern: "IK", initiator: false, prologue: new TextEncoder().encode("pi-relay/1 agent-b"), s: desktop });
  await assert.rejects(r.readMessage(await i.writeMessage()), noise.NoiseError);
});

test("pairing with the wrong one-time secret fails on the phone", async () => {
  const psk = crypto.getRandomValues(new Uint8Array(32));
  const { initiator, responder } = await pair("IKpsk2", { psk, responderPsk: crypto.getRandomValues(new Uint8Array(32)) });
  await responder.readMessage(await initiator.writeMessage());
  await assert.rejects(initiator.readMessage(await responder.writeMessage()), noise.NoiseError);
});

test("tampered, replayed and reordered transport messages are refused", async () => {
  const { initiator, responder } = await pair();
  await responder.readMessage(await initiator.writeMessage());
  await initiator.readMessage(await responder.writeMessage());
  const a = await initiator.split();
  const b = await responder.split();
  const ad = new Uint8Array(0);
  const first = await a.send.encrypt(ad, Uint8Array.of(1));
  const second = await a.send.encrypt(ad, Uint8Array.of(2));
  const flipped = first.slice();
  flipped[0] ^= 1;
  await assert.rejects(b.receive.decrypt(ad, flipped), noise.NoiseError);
  await assert.rejects(b.receive.decrypt(ad, second), noise.NoiseError, "out of order");
  assert.deepEqual(await b.receive.decrypt(ad, first), Uint8Array.of(1));
  await assert.rejects(b.receive.decrypt(ad, first), noise.NoiseError, "replay");
});

test("handshake messages out of turn or truncated are refused", async () => {
  const { initiator, responder } = await pair();
  await assert.rejects(responder.writeMessage(), noise.NoiseError);
  const m0 = await initiator.writeMessage();
  await assert.rejects(responder.readMessage(m0.subarray(0, 40)), noise.NoiseError);
});

test("an all-zero (low-order) ephemeral key is refused", async () => {
  const { initiator, responder } = await pair();
  const m0 = await initiator.writeMessage();
  const forged = m0.slice();
  forged.fill(0, 0, 32);
  await assert.rejects(responder.readMessage(forged), noise.NoiseError);
});

test("concurrent encryptions never reuse a nonce", async () => {
  const { initiator, responder } = await pair();
  await responder.readMessage(await initiator.writeMessage());
  await initiator.readMessage(await responder.writeMessage());
  const a = await initiator.split();
  const zero = new Uint8Array(16);
  const [x, y] = await Promise.all([a.send.encrypt(new Uint8Array(0), zero), a.send.encrypt(new Uint8Array(0), zero)]);
  assert.notDeepEqual(x, y, "same plaintext, different nonces, different ciphertext");
});
