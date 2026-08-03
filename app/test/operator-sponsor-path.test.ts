import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("publishes the honestly labeled operator-controlled second sponsor path", async () => {
  const [html, build] = await Promise.all([
    readFile(join(appRoot, "sponsor-two.html"), "utf8"),
    readFile(join(appRoot, "build.mjs"), "utf8"),
  ]);
  assert.match(html, /operator-controlled sponsor/i);
  assert.match(html, /not an independent sponsor/i);
  assert.match(html, /Transfer 1,000 CHIT/);
  assert.match(html, /src="\.\/sponsor-two\.js/);
  assert.match(build, /sponsor-two\.html/);
  assert.match(build, /operator-sponsor\/main\.ts/);
});
