import assert from "node:assert/strict";

export async function checkComposerGeometry(page) {
  const input = page.locator(".chat-input-textarea");
  const previousDraft = await input.inputValue();
  const heights = [];
  try {
    for (const draft of ["Short draft", "First line\nSecond line\nThird line\nFourth line", "A long draft that wraps naturally. ".repeat(80), "Short again"]) {
      await input.fill(draft);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.locator(".chat-composer").evaluate((card) => {
        const button = card.querySelector(".composer-send-button");
        const outer = card.getBoundingClientRect();
        const inner = button.getBoundingClientRect();
        const radius = parseFloat(getComputedStyle(card).borderBottomRightRadius);
        return {
          height: outer.height,
          width: inner.width,
          buttonHeight: inner.height,
          radius,
          dx: outer.right - radius - (inner.left + inner.width / 2),
          dy: outer.bottom - radius - (inner.top + inner.height / 2),
        };
      });
      assert.ok(Math.abs(geometry.width - geometry.buttonHeight) < 0.5, "Send must remain circular");
      assert.ok(Math.abs(geometry.dx) < 0.5, `Horizontal arc centers must coincide: ${JSON.stringify(geometry)}`);
      assert.ok(Math.abs(geometry.dy) < 0.5, `Vertical arc centers must coincide after resizing: ${JSON.stringify(geometry)}`);
      heights.push(geometry.height);
    }
    assert.ok(heights[1] > heights[0], "Newlines must grow the input card");
    assert.ok(heights[2] >= heights[1], "Wrapped text must preserve the geometry through the height limit");
    assert.ok(Math.abs(heights[3] - heights[0]) < 0.5, "Removing newlines must shrink the card back");
  } finally {
    await input.fill(previousDraft);
  }
}
