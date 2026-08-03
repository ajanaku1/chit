import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("publishes an explicit creator-signed Nox enrollment path", async () => {
  const [html, build] = await Promise.all([
    readFile(join(appRoot, "enroll.html"), "utf8"),
    readFile(join(appRoot, "build.mjs"), "utf8"),
  ]);

  assert.match(html, /Sign enrollment challenge/);
  assert.match(html, /Nox encrypted sponsor slot/);
  assert.match(html, /Every transaction waits for explicit approval/);
  assert.match(html, /src="\.\/enroll\.js/);
  assert.match(build, /enroll\.html/);
  assert.match(build, /enrollment\/main\.ts/);
});
