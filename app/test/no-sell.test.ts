import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * T087: no sell path is reachable in the mainnet build. The Sessions page is
 * the one page with a sell control (the key's "let it sell" flag); on the beta
 * it is not drawn, so nothing on the page can grant a sale.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path: string): Promise<string> => readFile(join(appRoot, path), "utf8");

test("the sell toggle is drawn only off the beta: the whole label sits behind chainTarget.beta", async () => {
  const page = await read("src/sessions-page.ts");
  assert.match(page, /\$\{chainTarget\.beta \? "" : `<label class="fineprint sell-toggle">/, "the label is not written on the beta");
  const open = page.indexOf('${chainTarget.beta ? "" : `<label class="fineprint sell-toggle">');
  const close = page.indexOf("</label>`}", open);
  assert.ok(open > 0 && close > open, "the guard closes after the label, so no part of the toggle escapes it");
  assert.equal((page.match(/data-act="sell"/g) ?? []).length, 1, "there is one sell control on the page, and it is the guarded one");
  assert.match(page, /chainTarget,\n/, "chainTarget is read from page-shared, the same value every page reads its chain from");
});
