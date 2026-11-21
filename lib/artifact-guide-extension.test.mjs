import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ARTIFACT_GUIDE, ARTIFACT_GUIDE_SECTION, createArtifactGuideExtension } = await jiti.import("./artifact-guide-extension.ts");
const { splitArtifacts } = await jiti.import("./artifacts.ts");

test("adds the artifacts section without forcing the prompt", async () => {
  const handlers = [];
  const extension = createArtifactGuideExtension();
  assert.equal(extension.hidden, true);
  await extension.factory({ on: (name, handler) => handlers.push([name, handler]) });
  assert.deepEqual(handlers.map(([name]) => name), ["before_agent_start"]);

  const event = { systemPromptOptions: { sections: {} } };
  const result = await handlers[0][1](event);
  assert.equal(result, undefined);
  assert.equal(event.systemPromptOptions.sections[ARTIFACT_GUIDE_SECTION], ARTIFACT_GUIDE);
});

test("the example in the guide parses as a complete artifact", () => {
  const example = ARTIFACT_GUIDE.slice(ARTIFACT_GUIDE.indexOf(":::artifact"), ARTIFACT_GUIDE.indexOf("\n:::\n") + 4);
  const [segment] = splitArtifacts(example);
  assert.equal(segment.kind, "artifact");
  assert.equal(segment.block.identifier, "tip-calculator");
  assert.equal(segment.block.type, "html");
  assert.equal(segment.block.complete, true);
});

test("leaves the section out, and removes it, when the setting is off", async () => {
  let enabled = true;
  const handlers = [];
  await createArtifactGuideExtension(() => enabled).factory({ on: (name, handler) => handlers.push(handler) });
  const event = { systemPromptOptions: { sections: {} } };
  await handlers[0](event);
  assert.ok(event.systemPromptOptions.sections[ARTIFACT_GUIDE_SECTION]);
  enabled = false;
  await handlers[0](event);
  assert.equal(ARTIFACT_GUIDE_SECTION in event.systemPromptOptions.sections, false);
});

test("tells the model what sendPrompt does and when not to call it", () => {
  assert.match(ARTIFACT_GUIDE, /sendPrompt\(/);
  assert.match(ARTIFACT_GUIDE, /never call it on load/);
  assert.match(ARTIFACT_GUIDE, /user reads and sends it/);
});

test("the guide tells the model to write small charts as ```chart JSON", () => {
  assert.match(ARTIFACT_GUIDE, /```chart fence/);
  for (const field of ['"items": [{"label", "value"}]', '"series": [{"name", "data"', '"matrix"', '"steps"', '"points"']) {
    assert.ok(ARTIFACT_GUIDE.includes(field), field);
  }
});
