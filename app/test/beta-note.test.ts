import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { betaFacts, chainTargetFromEnv, withBetaNote } from "../chain-target.mjs";
import { MAINNET_BETA_CAPS, TESTNET_CAPS } from "../../src/fleet/pool-caps.js";

/**
 * T054, T056, T057, T061: the chain target is computed at build time from the
 * environment, and on the beta every page carries FR-006's three facts in a
 * strip nothing closes, hides or scrolls past, with the same statement beside
 * the deposit amount (FR-007). Off the beta, none of it.
 */

const execute = promisify(execFile);
const appRoot = new URL("../", import.meta.url).pathname;
const PAGES = ["fleet.html", "fleet-dashboard.html", "balance.html", "fleet-privacy.html", "trade.html", "sessions.html"];
const eth = (wei: bigint) => (Number(wei) / 1e18).toString();

test("the target follows FLEET_CHAIN_ID, its caps are the published set the service knows, and only the beta carries the note", () => {
  const testnet = chainTargetFromEnv({ FLEET_CHAIN_ID: "46630" });
  assert.equal(testnet.chainId, 46630);
  assert.equal(testnet.beta, false);
  assert.equal(testnet.betaNote, "");
  assert.deepEqual(testnet.caps, { depositor: eth(TESTNET_CAPS.depositor), draw: eth(TESTNET_CAPS.draw), pool: eth(TESTNET_CAPS.pool) });

  const beta = chainTargetFromEnv({ FLEET_CHAIN_ID: "4663", CHIT_BUY_URL: "https://example.test/buy" });
  assert.equal(beta.chainName, "Robinhood Chain");
  assert.deepEqual(beta.caps, { depositor: eth(MAINNET_BETA_CAPS.depositor), draw: eth(MAINNET_BETA_CAPS.draw), pool: eth(MAINNET_BETA_CAPS.pool) });
  assert.equal(beta.buyChitUrl, "https://example.test/buy");
  assert.deepEqual(chainTargetFromEnv({}).chainId, 46630, "testnet by default");
  assert.throws(() => chainTargetFromEnv({ FLEET_CHAIN_ID: "1" }), /not a chain this app is built for/);
  assert.throws(() => chainTargetFromEnv({ FLEET_CHAIN_ID: "4663", FLEET_POOL_CAP_ETH: "one" }), /FLEET_POOL_CAP_ETH/);
});

test("FR-006's three facts, each its own sentence, in words no weaker than the specification's", () => {
  const facts = betaFacts("1");
  assert.equal(facts.length, 3);
  assert.match(facts[0]!, /^The pool is capped at 1 ETH\.$/);
  assert.match(facts[1]!, /^The contracts have not been audited by a firm\.$/);
  assert.match(facts[2]!, /^Chit's operator key can move what is in the pool, up to that cap\.$/);
  const note = chainTargetFromEnv({ FLEET_CHAIN_ID: "4663" }).betaNote;
  for (const fact of facts) assert.ok(note.includes(fact), `the note omits: ${fact}`);
});

test("on the beta the build puts the strip before the masthead of every page and the statement beside the deposit amount; on testnet it puts nothing", async () => {
  for (const [chainId, beta] of [["4663", true], ["46630", false]] as const) {
    const out = await mkdtemp(join(tmpdir(), `chit-beta-note-${chainId}-`));
    try {
      await execute(process.execPath, [join(appRoot, "build.mjs")], { env: { ...process.env, APP_OUTPUT: `${out}/`, FLEET_CHAIN_ID: chainId } });
      const target = JSON.parse(await readFile(join(out, "chain-target.json"), "utf8")) as { chainId: number; beta: boolean };
      assert.equal(target.chainId, Number(chainId));
      assert.equal(target.beta, beta);
      for (const page of PAGES) {
        const html = await readFile(join(out, page), "utf8");
        const strips = html.match(/<p id="beta-note" class="beta-note" role="note">/g) ?? [];
        assert.equal(strips.length, beta ? 1 : 0, `${page} on ${chainId}: ${strips.length} strip(s)`);
        if (!beta) continue;
        const strip = /<p id="beta-note"[^>]*>([\s\S]*?)<\/p>/.exec(html)![1]!;
        for (const fact of betaFacts("1")) assert.ok(strip.includes(fact), `${page}: the strip omits ${fact}`);
        assert.doesNotMatch(strip, /<button|<input|<a /, `${page}: the strip has a control in it`);
        assert.ok(html.indexOf('id="beta-note"') < html.indexOf('<header class="masthead">'), `${page}: the strip is not before the masthead`);
      }
      const balance = await readFile(join(out, "balance.html"), "utf8");
      const custody = /<p id="deposit-custody"([^>]*)>([^<]*)<\/p>/.exec(balance)!;
      if (beta) {
        assert.doesNotMatch(custody[1]!, /\bhidden\b/, "the statement beside the amount is hidden");
        for (const fact of betaFacts("1")) assert.ok(custody[2]!.includes(fact), `the deposit form omits ${fact}`);
        assert.ok(balance.indexOf('id="deposit-custody"') < balance.indexOf('id="deposit-sizes"'), "the statement is not beside the amount");
      } else {
        assert.match(custody[1]!, /\bhidden\b/, "off the beta the statement should stay hidden");
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }
});

test("the strip is sticky: it cannot be scrolled past", async () => {
  const css = await readFile(join(appRoot, "src/styles/components.css"), "utf8");
  const rule = /\.beta-note \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /position:\s*sticky/);
  assert.match(rule, /top:\s*0/);
});
