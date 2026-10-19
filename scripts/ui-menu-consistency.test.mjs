import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
async function components(directory = new URL("components/", root)) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) files.push(...await components(path));
    else if (entry.name.endsWith(".tsx")) files.push(path);
  }
  return files;
}

test("application choices cannot reintroduce browser-native select/datalist popups", async () => {
  const violations = [];
  for (const path of await components()) {
    const source = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ["select", "datalist"].includes(node.tagName.getText(source))) {
        violations.push(`${path.pathname}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: use AppSelect/AppCombobox`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(violations, []);
});

test("all declared popup surfaces opt into the shared app-menu design", async () => {
  const violations = [];
  let checked = 0;
  for (const path of await components()) {
    const source = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "className" && node.initializer) {
        const value = ts.isStringLiteral(node.initializer) ? node.initializer
          : ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
        const literal = value && ts.isStringLiteral(value) ? value.text
          : value && ts.isTemplateExpression(value) ? [value.head.text, ...value.templateSpans.map((span) => span.literal.text)].join(" ") : "";
        const classes = literal.split(/\s+/);
        if (classes.includes("native-popover")) {
          checked++;
          if (!classes.includes("app-menu")) violations.push(`${path.pathname}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(checked >= 20, "The popup inventory must cover the application, not one example");
  assert.deepEqual(violations, []);
});
