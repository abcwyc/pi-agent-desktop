import assert from "node:assert/strict";
import test from "node:test";

import { formatCompactRelativeTime, formatRelativeTime, formatUpdatedTime, interpolateMessage, translateMessage } from "./format.ts";

test("interpolates string and numeric parameters", () => {
  assert.equal(interpolateMessage("Hello, {name} ({count})", { name: "Pi", count: 2 }), "Hello, Pi (2)");
});

test("falls back to English and returns the key when both are missing", () => {
  assert.equal(translateMessage("zh-CN", "common.ok", { en: { "common.ok": "OK" }, "zh-CN": {} }), "OK");
  assert.equal(translateMessage("zh-CN", "missing.key", { en: {}, "zh-CN": {} }), "missing.key");
});

test("formats relative time using the selected locale", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(formatRelativeTime(new Date("2026-01-01T00:05:00.000Z"), "en", now), "in 5 minutes");
  assert.equal(formatRelativeTime(new Date("2025-12-31T23:00:00.000Z"), "zh-CN", now), "1小时前");
  assert.equal(formatRelativeTime(new Date("2025-12-31T23:00:00.000Z"), "zh-TW", now), "1 小時前");
});

test("shows a clock time today and a relative day for earlier updates", () => {
  const now = new Date(2026, 8, 22, 21, 18, 0);
  const today = new Date(2026, 8, 22, 9, 5, 0);
  const earlier = new Date(2026, 8, 19, 21, 18, 0);
  assert.equal(
    formatUpdatedTime(today.getTime(), "zh-CN", now),
    today.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
  );
  assert.equal(formatUpdatedTime(earlier.getTime(), "zh-CN", now), "3天前");
  assert.equal(formatUpdatedTime(earlier.getTime(), "en", now), "3 days ago");
  assert.equal(formatUpdatedTime(earlier.getTime(), "zh-TW", now), "3 天前");
});

test("formats compact relative time for the narrow sidebar column", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const ago = (ms) => new Date(now.getTime() - ms);
  assert.equal(formatCompactRelativeTime(ago(5_000), "en", now), "now");
  assert.equal(formatCompactRelativeTime(ago(5_000), "zh-CN", now), "现在");
  assert.equal(formatCompactRelativeTime(ago(3 * 60_000), "en", now), "3m");
  assert.equal(formatCompactRelativeTime(ago(2 * 3_600_000), "en", now), "2h");
  assert.equal(formatCompactRelativeTime(ago(3 * 86_400_000), "en", now), "3d");
  assert.equal(formatCompactRelativeTime(ago(14 * 86_400_000), "en", now), "2w");
  assert.equal(formatCompactRelativeTime(ago(3 * 86_400_000), "zh-CN", now), "3天");
  assert.equal(formatCompactRelativeTime(new Date(now.getTime() + 60_000), "en", now), "now");
  assert.equal(formatCompactRelativeTime("not a date", "en", now), "");
});
