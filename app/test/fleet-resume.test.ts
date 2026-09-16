import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * A fleet is the service's record, not the tab's. The wizard may only offer
 * the backup confirmation once the service has the campaign, a launch that
 * failed is not "done", and a dashboard opened in a fresh tab finds the fleet
 * where the Trade page does: in the wallet's list.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (name: string): Promise<string> => readFile(join(appRoot, "src", name), "utf8");

test("the backup can be confirmed only after create() has answered", async () => {
  const wizard = await source("fleet-page.ts");
  const body = wizard.slice(wizard.indexOf("async #generateVault"), wizard.indexOf("async #confirm("));
  const created = body.indexOf("await this.#setup.create()");
  const enabled = body.indexOf('"confirm-vault"');
  assert.ok(created > 0 && enabled > 0, "generateVault no longer creates and enables");
  assert.ok(created < enabled, "confirm is enabled before the campaign exists, so a fast confirm never reaches the service");
});

test("a launch that failed stays on the launch step; only a launched fleet is done", async () => {
  const wizard = await source("fleet-page.ts");
  const body = wizard.slice(wizard.indexOf("async #launch"), wizard.indexOf("async #awaitFunding"));
  const done = body.match(/this\.#go\("done"\)/g) ?? [];
  assert.equal(done.length, 1, "launch reaches done on more than one path");
  assert.ok(body.indexOf("catch") > body.indexOf('this.#go("done")'), "done is reached after a failure");
  assert.doesNotMatch(body, /"Pending service"/, "a failed launch is saved as if it were a fleet");
});

test("the dashboard without a snapshot asks the service for the wallet's fleets", async () => {
  const dashboard = await source("fleet-dashboard.ts");
  assert.match(dashboard, /readSigned\(\s*wallet,\s*"list"/, "the dashboard only ever reads sessionStorage");
  assert.match(dashboard, /chit-wallet-changed/, "a wallet connected after load is not followed");
});
