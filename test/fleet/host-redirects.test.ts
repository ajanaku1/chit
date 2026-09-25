import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * Where a host's front door leads (FR-019, T081).
 *
 * One repository is deployed as two hosts now, and both read this file. The
 * root redirect was written when there was one: `/` sends a visitor to
 * https://chit.tools, which was right for a deployment URL and is wrong for
 * the playground, whose own root then sends people to the beta. Today both
 * hosts serve 46630 and nobody notices; the moment chit.tools flips to 4663 it
 * becomes a door from the free playground into the host holding real money.
 *
 * The rule: a redirect that names the beta by its URL must say which host it
 * applies to, and the playground's root must stay on the playground.
 */

type Redirect = { source: string; destination: string; has?: { type: string; key?: string; value?: string }[] };

const PLAYGROUND = "testnet.chit.tools";
const BETA = "https://chit.tools";

describe("the front door of each host", () => {
  it("the rule that sends a root to the beta never gets the playground's root first", async () => {
    const config = JSON.parse(await readFile(join(process.cwd(), "vercel.json"), "utf8")) as { redirects?: Redirect[] };
    const roots = (config.redirects ?? []).filter((r) => r.source === "/");
    const toBeta = roots.findIndex((r) => r.destination.startsWith(BETA));
    if (toBeta === -1) return; // no rule leads there at all, which is also fine
    const playground = roots.findIndex((r) => (r.has ?? []).some((h) => h.type === "host" && h.value === PLAYGROUND));
    // Vercel takes the first rule that matches, so order is the whole safeguard.
    assert.ok(playground !== -1 && playground < toBeta, "the playground's root falls through to the beta's rule");
  });

  it("the playground's root stays on the playground, and it is the first rule that matches", async () => {
    const config = JSON.parse(await readFile(join(process.cwd(), "vercel.json"), "utf8")) as { redirects?: Redirect[] };
    const roots = (config.redirects ?? []).filter((r) => r.source === "/");
    const first = roots[0];
    assert.ok(first, "nothing answers the root");
    assert.ok((first.has ?? []).some((h) => h.type === "host" && h.value === PLAYGROUND), `the first root rule is not the playground's: ${JSON.stringify(first)}`);
    assert.ok(first.destination.startsWith("/"), `the playground's root leaves its own host: ${first.destination}`);
  });
});
