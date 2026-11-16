// The bar's protocol limits are duplicated by necessity: the client asks, the engine
// answers. Keep the two copies honest instead of trusting a comment.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { PROTOCOL } = await import("../app/src/main/assets/www/js/assist.js");

function rustConst(file, name) {
  const source = readFileSync(new URL(`../engine/src/assist/${file}`, import.meta.url), "utf8");
  const match = new RegExp(`const ${name}: usize = (\\d+);`).exec(source);
  assert.ok(match, `${name} is declared in ${file}`);
  return Number(match[1]);
}

test("the assist protocol limits agree with the engine", () => {
  assert.equal(PROTOCOL.variants, rustConst("prototypes.rs", "MAX_VARIANTS"));
  assert.equal(PROTOCOL.slotExamples, rustConst("prototypes.rs", "MAX_SLOT_EXAMPLES"));
  assert.equal(PROTOCOL.defaultMatches, rustConst("complete.rs", "DEFAULT_MATCHES"));
  assert.equal(PROTOCOL.maxMatches, rustConst("complete.rs", "MAX_MATCHES"));
});
