import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  checkImageMaxBytes,
  formatImageBytes,
  ImageMaxBytesError,
  imageMaxBytes,
  parseImageMaxBytes,
  withImageMaxBytes,
} = await jiti.import("./model-image-limits.ts");

test("setting the limit keeps the model's other input limits", () => {
  const model = {
    id: "vision",
    inputLimits: { maxRequestBytes: 9000000, images: { maxPerMessage: 4, resize: { maxWidth: 1568 } } },
  };
  const next = withImageMaxBytes(model, "524288");
  assert.deepEqual(next.inputLimits, {
    maxRequestBytes: 9000000,
    images: { maxPerMessage: 4, resize: { maxWidth: 1568, maxBytes: 524288 } },
  });
  assert.equal(imageMaxBytes(next), 524288);
  assert.equal(model.inputLimits.images.resize.maxBytes, undefined, "the original entry is not mutated");
});

test("clearing the limit prunes the containers it leaves empty", () => {
  const only = withImageMaxBytes({ id: "vision", inputLimits: { images: { resize: { maxBytes: 1000 } } } }, undefined);
  assert.deepEqual(only, { id: "vision" });
  const shared = withImageMaxBytes({ id: "vision", inputLimits: { images: { resize: { maxBytes: 1000, jpegQuality: 75 } } } }, undefined);
  assert.deepEqual(shared.inputLimits, { images: { resize: { jpegQuality: 75 } } });
});

test("text that is not a byte count stays a draft and Save refuses it with the model", () => {
  for (const text of ["0", "-1", "1.5", "1e6"]) {
    const model = withImageMaxBytes({ id: "vision" }, text);
    assert.equal(imageMaxBytes(model), text);
    assert.throws(
      () => checkImageMaxBytes({ providers: { gateway: { models: [model] } } }),
      (error) => error instanceof ImageMaxBytesError && error.model === "gateway/vision",
    );
  }
});

test("pi's rule: a whole number of at least 1", () => {
  assert.equal(parseImageMaxBytes(" 2048 "), 2048);
  assert.equal(parseImageMaxBytes(2048), 2048);
  assert.equal(parseImageMaxBytes(0), undefined);
  assert.equal(parseImageMaxBytes(2048.5), undefined);
  assert.equal(parseImageMaxBytes(null), undefined);
});

test("Save passes valid limits, models without one and blank-id models the store drops", () => {
  assert.doesNotThrow(() => checkImageMaxBytes({
    providers: {
      gateway: {
        models: [
          { id: "a", inputLimits: { images: { resize: { maxBytes: 524288 } } } },
          { id: "b" },
          { id: " ", inputLimits: { images: { resize: { maxBytes: "x" } } } },
        ],
      },
      managed: { modelOverrides: { c: { contextWindow: 1 } } },
    },
  }));
});

test("sizes read in binary units", () => {
  assert.equal(formatImageBytes(4.5 * 1024 * 1024), "4.5 MiB");
  assert.equal(formatImageBytes(524288), "512 KiB");
  assert.equal(formatImageBytes(1000), "1000 B");
  assert.equal(formatImageBytes(1500000), "1.4 MiB");
});
