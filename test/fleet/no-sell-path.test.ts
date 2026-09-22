import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * T087: no sell path is reachable through the pool's service. The routes and
 * the pooled buy never import the sell encoder, and a request naming a sell
 * action is refused as unknown, not routed anywhere.
 */

const source = (path: string): Promise<string> => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

test("the campaign routes and the pooled buy do not import the sell encoder", async () => {
  for (const path of ["src/fleet/campaign-routes.ts", "src/fleet/pool-buy.ts", "src/fleet/service-runtime.ts"]) {
    const text = await source(path);
    assert.doesNotMatch(text, /encodeV4TokenSell|sellApprovals/, `${path} reaches the sell encoder`);
  }
});

test("no route action is a sell: every action the dispatcher names is a buy-side or control action", async () => {
  const routes = await source("src/fleet/campaign-routes.ts");
  const named = new Set([...routes.matchAll(/action === "(\w+)"|case "(\w+)":/g)].map((m) => m[1] ?? m[2]));
  assert.ok(named.has("trade") && named.has("create"), "the dispatcher's actions were read");
  for (const action of named) assert.doesNotMatch(action!, /sell/i, `route action ${action} is a sell`);
  assert.match(routes, /unknown_action:\$\{String\(action\)\}/, "an action the dispatcher does not name is refused as unknown");
});

/**
 * The other half of T087, beside the Sessions page's guarded toggle
 * (`app/test/no-sell.test.ts`): the four pages a depositor uses for the pool
 * carry no sell control at all. A sell button added to any of them would be
 * a sell path through Chit, which FR-022 keeps out of the beta, and neither
 * the import check above nor the Sessions guard would see it.
 */
test("the depositor's pool pages carry no sell control", async () => {
  const appRoot = new URL("../../../app/", import.meta.url);
  for (const page of ["balance.html", "fleet.html", "fleet-dashboard.html", "trade.html"]) {
    const html = (await readFile(new URL(page, appRoot), "utf8")).replace(/<!--[\s\S]*?-->/g, "");
    const controls = [...html.matchAll(/<(button|a|input|select|option)\b[^>]*>[^<]*/gi)].map((m) => m[0].toLowerCase());
    assert.deepEqual(controls.filter((c) => /\bsell\b|sell-|"sell/.test(c)), [], `${page}: no button, link or field sells`);
    assert.doesNotMatch(html, /id="sell|name="sell|data-act(ion)?="sell/i, `${page}: nothing is wired as a sell`);
  }
});
