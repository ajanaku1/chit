import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { chainTargetFromEnv, sessionTargetFromEnv } from "../chain-target.mjs";

/**
 * T081, FR-019: the beta and the free playground are two deploys of this app,
 * one per chain, and each must name the chain it is on and never offer the
 * other's funds. The two builds are made here from the same source with
 * nothing but FLEET_CHAIN_ID between them, and held apart:
 *
 *   - each build's chain-target.json names its own chain, its own RPC and its
 *     own caps, and only the beta carries the note;
 *   - the mainnet build never ships a testnet RPC, a testnet chain id or the
 *     testnet's session factory; the testnet build never ships the mainnet
 *     RPC or chain id. The one crossing allowed is the link the holders gate
 *     points at (FR-004, "where the free testnet alternative is"), which is
 *     an address the deploy is given, never a chain it talks to.
 *   - the session factory is the chain's own or none: a factory answers only
 *     on the chain it was deployed on, and 4663 has none until the beta
 *     deploys one.
 *
 * The build is the real one (app/build.mjs), so this fails if a later change
 * copies a file that should be written per chain, which is the mistake it was
 * written to catch.
 */

const run = promisify(execFile);
const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const MAINNET_RPC = "rpc.mainnet.chain.robinhood.com";
const TESTNET_RPC = "rpc.testnet.chain.robinhood.com";
const TESTNET_FACTORY = "0xe6abb3aba7625c215f805ddc762e1148860796be";

const buildFor = async (chainId: string, env: Record<string, string> = {}): Promise<string> => {
  const out = await mkdtemp(join(tmpdir(), `chit-app-${chainId}-`));
  await run(process.execPath, [join(appRoot, "build.mjs")], {
    cwd: appRoot,
    env: { ...process.env, APP_OUTPUT: out, FLEET_CHAIN_ID: chainId, ...env },
  });
  return out;
};

/**
 * Everything the deploy runs, as one string: pages, bundles, json. Source
 * maps are left out: they carry this repository's comments, which name both
 * chains as prose, and a comment is not a chain the host talks to.
 */
const served = async (dir: string): Promise<string> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = entries.filter((e) => e.isFile() && !e.name.endsWith(".map")).map((e) => join(e.parentPath ?? dir, e.name));
  return (await Promise.all(files.map((f) => readFile(f, "utf8").catch(() => "")))).join("\n");
};

test("the two hosts are one source and one variable, and each names its own chain", { timeout: 180_000 }, async (t) => {
  const testnet = await buildFor("46630");
  const mainnet = await buildFor("4663", { FLEET_TESTNET_URL: "https://testnet.chit.tools" });
  t.after(() => Promise.all([rm(testnet, { recursive: true, force: true }), rm(mainnet, { recursive: true, force: true })]));

  const targetOf = async (dir: string) => JSON.parse(await readFile(join(dir, "chain-target.json"), "utf8"));
  const play = await targetOf(testnet), beta = await targetOf(mainnet);

  assert.equal(play.chainId, 46630);
  assert.equal(beta.chainId, 4663);
  assert.match(play.chainName, /Testnet/i, "the playground says testnet in its own name");
  assert.doesNotMatch(beta.chainName, /Testnet/i);
  assert.deepEqual(play.rpcUrls, [`https://${TESTNET_RPC}`]);
  assert.deepEqual(beta.rpcUrls, [`https://${MAINNET_RPC}`]);
  assert.equal(play.beta, false, "the playground carries no beta note");
  assert.equal(play.betaNote, "");
  assert.equal(beta.beta, true);
  assert.match(beta.betaNote, /capped at 1 ETH/, "the beta's note carries the cap");
  assert.notDeepEqual(play.caps, beta.caps, "the caps differ: the beta's are the capped set");
});

test("neither host talks to the other's chain", { timeout: 180_000 }, async (t) => {
  const testnet = await buildFor("46630");
  const mainnet = await buildFor("4663", { FLEET_TESTNET_URL: "https://testnet.chit.tools" });
  t.after(() => Promise.all([rm(testnet, { recursive: true, force: true }), rm(mainnet, { recursive: true, force: true })]));

  const playServed = await served(testnet), betaServed = await served(mainnet);

  /*
   * What a page starts from, before chain-target.json is read, is the chain
   * its bundle was built for: build.mjs defines it, so the wallet is asked
   * for this host's chain even when the file cannot be read. The literal the
   * define replaces is still in both bundles, unreachable, as the fallback a
   * test importing the module directly uses, so what is asserted here is the
   * effective default and not the absence of a string.
   */
  const defaultOf = (servedText: string, chainId: number, rpc: string) =>
    new RegExp(`chainId:\\s*${chainId}\\s*,\\s*chainName:\\s*"[^"]+"\\s*,\\s*rpcUrls:\\s*\\["https://${rpc.replace(/\./g, "\\.")}"\\]`).test(servedText);
  assert.ok(defaultOf(betaServed, 4663, MAINNET_RPC), "the beta's bundles start on mainnet");
  assert.ok(defaultOf(playServed, 46630, TESTNET_RPC), "the playground's bundles start on testnet");
  assert.ok(!playServed.includes(MAINNET_RPC), "the playground names the mainnet RPC nowhere at all");

  // What each host actually serves as its chain: whole numbers, since 4663 is a substring of 46630.
  const chainTargetOf = async (dir: string) => readFile(join(dir, "chain-target.json"), "utf8");
  assert.doesNotMatch(await chainTargetOf(mainnet), /\b46630\b/, "the beta's target names one chain");
  assert.doesNotMatch(await chainTargetOf(testnet), /\b4663\b/, "the playground's target names one chain");

  // The one crossing FR-004 asks for: a link to the free testnet, an address, not a chain.
  assert.ok(betaServed.includes("https://testnet.chit.tools"), "the beta links to the playground for a wallet below the threshold");
  assert.ok(!playServed.includes("chit.tools/app"), "the playground does not send anyone to the beta");
});

test("a session factory belongs to its chain: the beta ships none until one is deployed, and never the testnet's", { timeout: 180_000 }, async (t) => {
  const testnet = await buildFor("46630");
  const mainnet = await buildFor("4663");
  t.after(() => Promise.all([rm(testnet, { recursive: true, force: true }), rm(mainnet, { recursive: true, force: true })]));

  const sessionOf = async (dir: string) => JSON.parse(await readFile(join(dir, "session-target.json"), "utf8"));
  assert.deepEqual(await sessionOf(testnet), { chainId: 46630, sessionFactory: TESTNET_FACTORY });
  assert.deepEqual(await sessionOf(mainnet), { chainId: 4663, sessionFactory: "" }, "no factory on 4663 yet: the page says so rather than call an address that answers wrongly");
  assert.ok(!(await served(mainnet)).includes(TESTNET_FACTORY), "the testnet factory is nowhere in the beta's deploy");

  // The deploy that brings a mainnet factory says so in its own environment.
  const deployed = "0x1234567890abcdef1234567890abcdef12345678";
  assert.deepEqual(sessionTargetFromEnv({ FLEET_CHAIN_ID: "4663", FLEET_SESSION_FACTORY: deployed }), { chainId: 4663, sessionFactory: deployed });
  assert.throws(() => sessionTargetFromEnv({ FLEET_CHAIN_ID: "4663", FLEET_SESSION_FACTORY: "0xnope" }), /must be an address/);
  assert.throws(() => sessionTargetFromEnv({ FLEET_CHAIN_ID: "1" }), /not a chain this app is built for/);
});

test("the sessions page uses a session target only when it names the page's own chain", async () => {
  const page = await readFile(join(appRoot, "src/sessions-page.ts"), "utf8");
  assert.match(page, /await loadChainTarget\(\);/, "the chain is known before the session target is judged");
  assert.match(page, /const ours = target\.chainId === chainTarget\.chainId;/, "a target naming another chain is not this host's");
  assert.match(page, /factory = ours &&/, "and its factory is not used");
});

test("the build's own inputs agree with the target: one variable decides both", () => {
  for (const chainId of ["46630", "4663"]) {
    const chain = chainTargetFromEnv({ FLEET_CHAIN_ID: chainId });
    const session = sessionTargetFromEnv({ FLEET_CHAIN_ID: chainId });
    assert.equal(chain.chainId, session.chainId, `chain ${chainId}: the session target follows the same variable`);
  }
});
