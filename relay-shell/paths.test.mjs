import assert from "node:assert/strict";
import test from "node:test";

const { safeAppPath } = await import("./paths.ts");

test("the shell frames only app pages from outside input", () => {
  for (const ok of ["/", "/?session=abc", "/?view=tasks"]) assert.equal(safeAppPath(ok), ok);
  for (const bad of ["/api/agent/x/events", "/api/auth/login/x", "//evil.example/", "/\\evil.example", "/__shell/", "https://evil.example/", "", null, 5, "/?x=\\y"]) {
    assert.equal(safeAppPath(bad), "/", String(bad));
  }
});
