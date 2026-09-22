import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** T071, T068 on the page: the picker is bound to the registry's list, the quote shows the least received, and the order carries the accepted fill. */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("the Trade page asks for the registry's tokens and offers only those; without a list the free entry stays", async () => {
  const script = await readFile(join(appRoot, "src/trade-page.ts"), "utf8");
  assert.match(script, /fleetApi\("tokens", \{ action: "tokens", body: \{\} \}\)/);
  assert.match(script, /if \(listed\.length === 0\) return;/, "no list, no picker: the testnet's free entry");
  assert.match(script, /select\.id = "o-token"/, "the picker keeps the field's id, so the form and the tests find it");
  assert.match(script, /for \(const entry of listed\)/);
  assert.doesNotMatch(script, /hasPool \? `\$\{quote\.symbol\} · pool found · about[^`]*`\s*:/, "the quote line is not the estimate alone any more");
  assert.match(script, /at least \$\{toEth\(quote\.minOut\)\} \$\{quote\.symbol\}/, "the least the fleet will receive is shown beside the estimate");
  assert.match(script, /acceptedOut: quote\.estimatedOut/, "the order carries the fill the depositor accepted");
});
