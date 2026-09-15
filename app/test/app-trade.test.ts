import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const NEVER = ["untraceable", "unlinkab", "no trail"];
const ONLY_WHEN_DENIED = ["anonymous", "hidden trade", "mainnet"];
const DENIAL = /\b(not|never|no|without|cannot|isn't|won't|will not|do not|does not|excludes?)\b/i;
test("the Trade page makes no claim the code does not keep", async () => {
  const text = await readFile(join(appRoot, "trade.html"), "utf8");
  for (const word of NEVER) assert.equal(text.toLowerCase().includes(word), false, `trade.html claims "${word}"`);
  const bad = text.split(/\n/).map((l) => l.trim()).filter((l) => ONLY_WHEN_DENIED.some((w) => new RegExp(w, "i").test(l)) && !DENIAL.test(l));
  assert.deepEqual(bad, []);
  const script = await readFile(join(appRoot, "src/trade-page.ts"), "utf8");
  assert.doesNotMatch(script, /https?:\/\//, "the page talks only to Chit's API");
  assert.match(script, /markSent\(/, "a slice must be marked sent before the request goes out");
});
