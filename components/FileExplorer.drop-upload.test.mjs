import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("files dropped on the tree upload to the folder under the pointer, else the project root (F4)", () => {
  // A folder row claims the drag and the drop, and stops it reaching the panel.
  const row = source.slice(source.indexOf("export function TreeNode("), source.indexOf("function ChangeRow("));
  assert.match(row, /onDragOver=\{node\.isDir && onDropFiles \? \(event\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?onDropTargetChange\?\.\(node\.fullPath\);/);
  assert.match(row, /onDropFiles\(node\.fullPath, droppedItems\(event\.dataTransfer\)\);/);
  // Nested rows pass the target on.
  assert.match(row, /dropTargetPath=\{dropTargetPath\}\s*onDropFiles=\{onDropFiles\}/);
  // The panel background means the project root.
  assert.match(source, /handleDropFiles\(dropTargetPath \?\? cwd, droppedItems\(event\.dataTransfer\)\);/);
  // The upload and its conflict retry go to that folder.
  assert.match(source, /await uploadFiles\(directory, files, strategy, setUploadProgress\)/);
  assert.match(source, /performUpload\(pendingConflict\.files, "overwrite", pendingConflict\.directory\)/);
  // Folders are not uploaded; the chat's notice says so.
  assert.match(source, /t\("chat\.dropFoldersUnsupported", \{ names: folders\.join\(", "\) \}\)/);
  assert.match(source, /className="file-tree-drop-hint"/);
});
