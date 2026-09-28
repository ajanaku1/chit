import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * T087, as FR-022 reads since 2026-09-28: a session account sells only
 * through a key its owner has let sell, on the Sessions page. Until that day
 * this test kept the "let it sell" switch off the beta altogether; the founder
 * amended FR-022 so the bot can sell through sessions on 4663, and the test now
 * pins what makes that safe (IMPLEMENTATION.md): one switch, off unless the
 * contract says the key may sell, closed once the key is revoked or the
 * account predates the flag, and changed only by the owner's own wallet.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path: string): Promise<string> => readFile(join(appRoot, path), "utf8");

test("the Sessions page has one sell control: the key's own let-it-sell switch", async () => {
  const page = await read("src/sessions-page.ts");
  assert.equal((page.match(/data-act="sell"/g) ?? []).length, 1, "there is one sell control on the page");
  assert.match(page, /<label class="fineprint sell-toggle"><input type="checkbox" data-act="sell"/, "and it is the switch beside the key");
});

test("the switch is off unless the contract says the key may sell, and closed when it cannot matter", async () => {
  const page = await read("src/sessions-page.ts");
  assert.match(page, /data-act="sell" \$\{sells \? "checked" : ""\}/, "checked only when the chain says the key may sell");
  assert.match(page, /\$\{state === "revoked" \|\| sells === undefined \? "disabled" : ""\}/, "disabled once the key is revoked, and on an account that predates the flag");
});

test("only the owner's wallet changes it, and the page then reads back what the contract says", async () => {
  const page = await read("src/sessions-page.ts");
  const setSell = /const setSell = async[\s\S]*?\n\};/.exec(page);
  assert.ok(setSell, "no setSell");
  assert.match(setSell[0], /transact\([^)]*account, encodeSetSellAllowed\(key, allowed\)\)/, "a transaction to the account from the connected wallet; the contract takes it from the owner only");
  assert.match(setSell[0], /await renderSessions\(\)/, "the switch shows the chain's answer, not the click");
});
