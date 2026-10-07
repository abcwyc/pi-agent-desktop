import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const presets = await createJiti(import.meta.url).import("./schedule-presets.ts");

test("presets produce the expected cron expressions", () => {
  const at = { hour: 9, minute: 30, weekday: 3 };
  assert.equal(presets.cronFromPreset({ preset: "hourly", ...at }), "30 * * * *");
  assert.equal(presets.cronFromPreset({ preset: "daily", ...at }), "30 9 * * *");
  assert.equal(presets.cronFromPreset({ preset: "weekdays", ...at }), "30 9 * * 1-5");
  assert.equal(presets.cronFromPreset({ preset: "weekly", ...at }), "30 9 * * 3");
});

test("an expression maps back to the preset that produced it", () => {
  for (const preset of ["hourly", "daily", "weekdays", "weekly"]) {
    const spec = { preset, hour: 14, minute: 5, weekday: 6 };
    const back = presets.presetFromCron(presets.cronFromPreset(spec));
    assert.equal(back.preset, preset);
    assert.equal(back.minute, 5);
    if (preset !== "hourly") assert.equal(back.hour, 14);
    if (preset === "weekly") assert.equal(back.weekday, 6);
  }
});

test("anything the presets cannot say is left to the custom field", () => {
  for (const expr of ["*/15 * * * *", "0 9 1 * *", "0 9,17 * * *", "0 9 * * 1,3", "0 25 * * *", "61 9 * * *", "0 9 * * 7", "0 * * * 1-5", "nonsense", ""]) {
    assert.equal(presets.presetFromCron(expr), null, expr);
  }
});

test("extra whitespace does not defeat the match", () => {
  assert.equal(presets.presetFromCron("  0   9  * * * ").preset, "daily");
});

test("clock parsing accepts only valid 24-hour times", () => {
  assert.deepEqual(presets.parseClock("09:05"), { hour: 9, minute: 5 });
  assert.deepEqual(presets.parseClock("9:05"), { hour: 9, minute: 5 });
  assert.equal(presets.parseClock("24:00"), null);
  assert.equal(presets.parseClock("09:60"), null);
  assert.equal(presets.parseClock("0905"), null);
  assert.equal(presets.formatClock(9, 5), "09:05");
});
