import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canLed, ledDots, renderLed } from "../src/fleet/led.js";

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

test("a rendered figure carries its exact value as text, and its unit beside it", () => {
  const previous = (globalThis as { document?: unknown }).document;
  const makeNode = (): { setAttribute(): void; append(): void; className: string; textContent: string } => ({
    setAttribute() {},
    append() {},
    className: "",
    textContent: "",
  });
  (globalThis as { document?: unknown }).document = {
    createElement: makeNode,
    createElementNS: makeNode,
  };
  const children: { className: string; textContent: string }[] = [];
  const host = {
    replaceChildren() {},
    classList: { add() {} },
    append(...nodes: { className: string; textContent: string }[]) {
      children.push(...nodes);
    },
  } as unknown as HTMLElement;

  renderLed(host, "0.049979", "ETH");

  const srOnly = children.find((child) => child.className === "sr-only");
  assert.equal(srOnly?.textContent, "0.049979");
  const unit = children.find((child) => child.className === "led__unit");
  assert.equal(unit?.textContent, "ETH");

  (globalThis as { document?: unknown }).document = previous;
});
