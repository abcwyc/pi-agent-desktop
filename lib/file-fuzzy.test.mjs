import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-fuzzy.ts");
}

test("builds closed file mentions and quotes paths containing spaces", async () => {
  const { buildAtMentionText, buildFileAtMentionsText } = await loadSubject();

  assert.equal(buildAtMentionText("notes/todo.md", false), "@notes/todo.md ");
  assert.equal(buildAtMentionText("project files/design brief.md", false), "@\"project files/design brief.md\" ");
  assert.equal(
    buildFileAtMentionsText(["notes/todo.md", "project files/design brief.md"]),
    "@notes/todo.md @\"project files/design brief.md\" ",
  );
});

test("builds line-scoped file mentions", async () => {
  const { buildFileLineMentionText } = await loadSubject();

  assert.equal(buildFileLineMentionText("src/app.ts", 12, 12), "@src/app.ts:12 ");
  assert.equal(buildFileLineMentionText("src/app.ts", 18, 12), "@src/app.ts:12-18 ");
  assert.equal(
    buildFileLineMentionText("project files/app.ts", 3, 9),
    "@\"project files/app.ts\":3-9 ",
  );
  assert.equal(buildFileLineMentionText("src/app.ts", 0, 0), "@src/app.ts:1 ");
});

test("builds session mentions from the visible name", async () => {
  const { buildSessionMentionText } = await loadSubject();

  assert.equal(buildSessionMentionText("Design review"), '#"Design review" ');
  assert.equal(buildSessionMentionText("abc-1"), "#abc-1 ");
});

test("composer selectors detect tokens next to text and at the caret", async () => {
  const { extractAtQuery, extractHashQuery, extractSlashQuery } = await loadSubject();
  for (const prefix of ["", "hello", "请参考", "first line\n正文：", "("]) {
    for (const [trigger, extract] of [["@", extractAtQuery], ["#", extractHashQuery], ["/", extractSlashQuery]]) {
      for (const query of ["", "file"]) {
        const text = prefix + trigger + query + " suffix";
        const token = extract(text.slice(0, prefix.length + 1 + query.length));
        assert.equal(token.start, prefix.length);
        assert.equal(token.query, query);
        assert.equal(extract(text), null);
      }
    }
  }
  assert.deepEqual(extractAtQuery('参考@"my dir/fi'), { start: 2, query: "my dir/fi", quoted: true });
  assert.deepEqual(extractHashQuery('参考#"Design review'), { start: 2, query: "Design review", quoted: true });
  assert.equal(extractSlashQuery("参考@src/"), null, "directory drill-down keeps the file selector");
  assert.equal(extractAtQuery("@old#new"), null);
  assert.equal(extractHashQuery("@old#new").start, 4);
  assert.equal(extractHashQuery("#old@new"), null);
  assert.equal(extractAtQuery("#old@new").start, 4);
});
