import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { GET } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./route.ts");
test("font enumeration requires the per-process desktop token, loopback host and a trusted origin", async () => {
  const previous = process.env.PI_DESKTOP_API_TOKEN;
  process.env.PI_DESKTOP_API_TOKEN = "font-route-test-token-with-at-least-32-characters";
  try {
    for (const headers of [
      { Host: "localhost" },
      { Host: "localhost", "x-pi-desktop-token": "incorrect" },
      { Host: "192.168.0.2", "x-pi-desktop-token": process.env.PI_DESKTOP_API_TOKEN },
      { Host: "localhost", Origin: "https://untrusted.example", "x-pi-desktop-token": process.env.PI_DESKTOP_API_TOKEN },
    ]) {
      const response = await GET(new Request("http://localhost/api/desktop/fonts", { headers }));
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "Desktop authorization required" });
    }
  } finally {
    if (previous === undefined) delete process.env.PI_DESKTOP_API_TOKEN;
    else process.env.PI_DESKTOP_API_TOKEN = previous;
  }
});
