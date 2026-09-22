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
