import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { redactForLog } from "../../src/fleet/campaign-service.js";

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

const fleetSources = async (): Promise<{ path: string; text: string }[]> => {
  const roots = ["src/fleet", "api/fleet", "contracts/fleet", "app/src/fleet"];
  const files: { path: string; text: string }[] = [];
  for (const root of roots) {
    for (const entry of await readdir(join(repoRoot, root))) {
      const path = join(repoRoot, root, entry);
      files.push({ path: join(root, entry), text: await readFile(path, "utf8") });
    }
  }
  return files;
};

test("no fleet source claims fleet-wide unlinkability or anonymous trading (SC-009)", async () => {
  for (const file of await fleetSources()) {
    for (const overclaim of ["fleet-wide unlinkability", "anonymous trading", "untraceable"]) {
      assert.equal(file.text.toLowerCase().includes(overclaim), false, `${file.path} claims: ${overclaim}`);
    }
  }
});

test("the withheld fact is stated wherever the public facts are (FR-011)", async () => {
  const boundary = await readFile(join(repoRoot, "app/src/fleet/index.ts"), "utf8");
  assert.match(boundary, /operator knows/i, "the operator trust assumption is stated, not hidden");
  assert.match(boundary, /primary-wallet-to-fleet relationship/);
});

test("redaction survives adversarial nesting (regression net)", () => {
  const hostile = {
    level1: { level2: { level3: { privateKey: "0xdeadbeef", note: "fine" } } },
    list: [{ mapping: { primary: "0xabc", fleet: ["0xdef"] } }],
    weirdName_privateThing: "0x123",
    payloadCiphertext: "0xc1",
  };
  const serialized = JSON.stringify(redactForLog(hostile));
  for (const leaked of ["0xdeadbeef", "0xabc", "0xdef", "0x123", "0xc1"]) {
    assert.equal(serialized.includes(leaked), false, `leaked ${leaked}`);
  }
  assert.ok(serialized.includes("fine"), "redaction does not destroy benign fields");
});
