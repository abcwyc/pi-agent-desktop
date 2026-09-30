import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildTlsConnectOptions, loadExtraCaCerts } = await jiti.import("./http-dispatcher.ts");

test("loadExtraCaCerts returns undefined when unset", () => {
  assert.equal(loadExtraCaCerts({}), undefined);
});

test("buildTlsConnectOptions enables autoSelectFamily and loads NODE_EXTRA_CA_CERTS", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-ca-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const certPath = join(dir, "corp.pem");
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  await writeFile(certPath, pem);

  const opts = buildTlsConnectOptions({ NODE_EXTRA_CA_CERTS: certPath });
  assert.equal(opts.autoSelectFamily, true);
  assert.ok(Buffer.isBuffer(opts.ca));
  assert.equal(opts.ca.toString("utf8"), pem);
});
