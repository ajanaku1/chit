import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The brake page. It exists because the explorer's write tab cannot sign on either
 * Robinhood chain — no wallet connector is configured — so a guardian's only route
 * was pasting calldata from memory at whatever hour the pause is needed.
 *
 * The page grants nothing: the contract refuses pause() from anyone but the
 * guardian, the operator and the admin, and setPaused and setGuardian from anyone
 * but the admin. What the page must do is never show a button that would revert,
 * and never imply the pause is more than it is.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path: string): Promise<string> => readFile(join(appRoot, path), "utf8");

test("every act names the key it needs, and starts disabled", async () => {
  const html = await read("control.html");
  for (const id of ["pause", "resume", "set-guardian"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*disabled`), `${id} must start disabled: the page reads the chain before it offers anything`);
  }
  const page = await read("src/control-page.ts");
  assert.match(page, /const mayPause = isGuardian \|\| isOperator \|\| isAdmin;/, "pause is offered to exactly the three the contract allows");
  assert.match(page, /disabled = !isAdmin \|\| !roles\.paused/, "resume is the admin's, and only when it is paused");
  assert.match(page, /disabled = !isAdmin/, "setting the guardian is the admin's");
});

test("a wallet that is none of the three is told so, rather than shown a button that would revert", async () => {
  const page = await read("src/control-page.ts");
  assert.match(page, /none of the guardian, the operator or the admin, so the contract would refuse it/);
});

test("the page says what a pause does and does not do, where the person pressing it will read it", async () => {
  const html = await read("control.html");
  assert.match(html, /Exits keep working/i, "the one thing that must not be misunderstood in a pause");
  assert.match(html, /Only the admin can resume/i);
  assert.doesNotMatch(html, /freez|lock(ed)? (your|the) funds/i, "a pause is not a freeze and must not read like one");
});

test("it reads the pool from the build's own chain target, not from the service", async () => {
  const page = await read("src/control-page.ts");
  assert.match(page, /chain-target\.json/, "the pool comes from the build");
  assert.match(page, /target\.chainId !== chainTarget\.chainId/, "a target naming another chain is not this host's");
  assert.doesNotMatch(page, /fleetApi|\/api\/fleet/, "the service being unreachable is a reason to pull the brake, so the brake must not need it");
});

test("the build emits the page and the chain target carries the pool", async () => {
  const build = await read("build.mjs");
  assert.match(build, /page\("\.\/control\.html"\)/);
  assert.match(build, /"control-page":/);
  const target = await read("chain-target.mjs");
  assert.match(target, /pool: env\.FLEET_POOL_ADDRESS/);
});
