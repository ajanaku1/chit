import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canLed, ledDots } from "../src/fleet/led.js";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("every glyph is drawn dot for dot from the landing's bitmaps", () => {
  // "1" is 010/110/010/010/010/010/111: ten lit dots in a three-column glyph.
  assert.equal(ledDots("1").dots.length, 10);
  // "0" is 01110/10001/10011/10101/11001/10001/01110: nineteen lit dots.
  assert.equal(ledDots("0").dots.length, 19);
});

test("glyphs sit side by side with one blank column between them", () => {
  assert.equal(ledDots("1").width, 15);
  assert.equal(ledDots("0.05").width, 95);
});

test("only digits, the point and the colon become dots; anything else stays text", () => {
  assert.equal(canLed("0.0500"), true);
  assert.equal(canLed("12:40"), true);
  assert.equal(canLed("—"), false);
  assert.equal(canLed(""), false);
  assert.equal(canLed("1 ETH"), false);
});

test("an unknown character is refused, never silently skipped", () => {
  assert.throws(() => ledDots("1x"), /no glyph/);
});

test("the dots are decoration; the value stays readable text", async () => {
  const source = await readFile(join(appRoot, "src/fleet/led.ts"), "utf8");
  const render = /export const renderLed[\s\S]*?\n\};/.exec(source);
  assert.ok(render, "no renderLed");
  assert.match(render[0], /setAttribute\("aria-hidden", "true"\)/);
  assert.match(render[0], /className = "sr-only"/);
});
