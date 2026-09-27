import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * T087, as FR-022 reads since 2026-09-27: selling goes only through the
 * operator's sale flow (docs/design-sell.md), never through a fleet account's
 * sponsored path. Until that day these tests said no sell path existed at
 * all; the founder amended FR-022 before the beta opened, and they now pin
 * where the one sell path is and that nothing else sells (IMPLEMENTATION.md).
 */

const source = (path: string): Promise<string> => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

test("the sponsored path never sells: only sell.ts reaches the sell encoder, and the pooled buy does not", async () => {
  for (const path of ["src/fleet/campaign-routes.ts", "src/fleet/pool-buy.ts", "src/fleet/service-runtime.ts", "src/fleet/sell-chain.ts"]) {
    const text = await source(path);
    assert.doesNotMatch(text, /encodeV4TokenSell|sellApprovals/, `${path} reaches the sell encoder`);
  }
  assert.match(await source("src/fleet/sell.ts"), /encodeV4TokenSell/, "the one sale flow is where selling is encoded");
});

test("the only sell actions are the sale flow's, and they go to sell.ts", async () => {
  const routes = await source("src/fleet/campaign-routes.ts");
  const named = new Set([...routes.matchAll(/action === "(\w+)"|case "(\w+)":/g)].map((m) => m[1] ?? m[2]));
  assert.ok(named.has("trade") && named.has("create"), "the dispatcher's actions were read");
  assert.deepEqual([...named].filter((action) => /sell/i.test(action!)).sort(), ["sell", "sellGas"], "no other action sells");
  assert.match(routes, /import \{[^}]*openSale[^}]*\} from "\.\/sell\.js"/, "a sale is opened by the sale flow and nowhere else");
  assert.match(routes, /unknown_action:\$\{String\(action\)\}/, "an action the dispatcher does not name is refused as unknown");
});

/**
 * The other half of T087, beside the Sessions page's guarded toggle
 * (`app/test/no-sell.test.ts`): of the four pages a depositor uses for the
 * pool, only Trade may carry a sell control, because the sale flow lives there
 * (FR-022 since 2026-09-27). A sell button on Balance, Fleet or the dashboard
 * would be a second way in that the sale flow does not guard.
 */
test("the depositor's pool pages carry no sell control, except Trade, where the sale flow lives", async () => {
  const appRoot = new URL("../../../app/", import.meta.url);
  for (const page of ["balance.html", "fleet.html", "fleet-dashboard.html"]) {
    const html = (await readFile(new URL(page, appRoot), "utf8")).replace(/<!--[\s\S]*?-->/g, "");
    const controls = [...html.matchAll(/<(button|a|input|select|option)\b[^>]*>[^<]*/gi)].map((m) => m[0].toLowerCase());
    assert.deepEqual(controls.filter((c) => /\bsell\b|sell-|"sell/.test(c)), [], `${page}: no button, link or field sells`);
    assert.doesNotMatch(html, /id="sell|name="sell|data-act(ion)?="sell/i, `${page}: nothing is wired as a sell`);
  }
});
