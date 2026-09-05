import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const address = "0xD523A627030509021cC39B6d7C8543417D3E50D8";

test("publishes a copyable canonical contract address in the masthead", async () => {
  const [html, script] = await Promise.all([
    readFile(join(appRoot, "index.html"), "utf8"),
    readFile(join(appRoot, "src/main.ts"), "utf8"),
  ]);

  assert.match(html, new RegExp(`id="contract-address">${address}`));
  assert.match(html, /<button id="copy-contract-address" type="button" aria-label="Copy contract address">/);
  assert.match(script, /navigator\.clipboard\.writeText\(element\("contract-address"\)\.textContent \?\? ""\)/);
  assert.equal((html + script).split(address).length - 1, 1);
});
