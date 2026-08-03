import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("publishes the fixed sponsored UserOperation path", async () => {
  const [html, build, browser] = await Promise.all([
    readFile(join(appRoot, "user-operation.html"), "utf8"),
    readFile(join(appRoot, "build.mjs"), "utf8"),
    readFile(join(appRoot, "..", "spikes", "hosted-user-operation", "main.ts"), "utf8"),
  ]);
  assert.match(html, /fixed counter increment/i);
  assert.match(html, /creator signs only the EntryPoint hash/i);
  assert.match(html, /src="\.\/user-operation\.js/);
  assert.match(build, /user-operation\.html/);
  assert.match(build, /hosted-user-operation\/main\.ts/);
  assert.match(browser, /loadConfirmedStatus/);
  assert.match(browser, /method:\s*"GET"/);
});
