import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("lark mermaid diagrams do not reuse node ids with different labels", async () => {
  const content = await readFile("docs/product/donkey-product-plan.lark.xml", "utf8");
  const diagrams = [...content.matchAll(/<whiteboard type="mermaid">([\s\S]*?)<\/whiteboard>/g)];

  assert.ok(diagrams.length > 0);

  for (const [diagramIndex, diagram] of diagrams.entries()) {
    const labelsById = new Map<string, string>();
    const body = diagram[1] ?? "";
    for (const match of body.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*(\[[^\]]+\]|\{[^}]+\})/g)) {
      const id = match[1] ?? "";
      const label = match[2] ?? "";
      const previous = labelsById.get(id);
      assert.equal(previous ?? label, label, `diagram ${diagramIndex + 1} reuses node ${id} as ${previous} and ${label}`);
      labelsById.set(id, label);
    }
  }
});
