import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The CI gate, read from the workflow files (specs/003-mainnet-beta, T002–T005):
 * the no-network set runs on every push and pull request to main; the fork
 * suites run on a clock and by hand, never as a required check; and no
 * workflow commits to main. YAML is read as text on purpose: the facts here
 * are lines, and a parser would be a dependency.
 */

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const workflows = join(repoRoot, ".github", "workflows");
const workflow = (name: string): Promise<string> => readFile(join(workflows, name), "utf8");

test("verify.yml runs the no-network set on every push and pull request to main, read-only", async () => {
  const text = await workflow("verify.yml");
  assert.match(text, /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n    branches: \[main\]/m);
  assert.match(text, /^permissions:\n  contents: read$/m);
  for (const step of ["npx hardhat compile", "npm run test:fleet", "npm --prefix app run verify", "npm --prefix landing run verify", "npx hardhat test solidity", "node scripts/progress.mjs --check"]) {
    assert.match(text, new RegExp(`^\\s+run: ${step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), `verify.yml does not run: ${step}`);
  }
});

test("verify-full.yml runs the fork suites nightly and by hand, never on a push, and reads the RPCs from secrets", async () => {
  const text = await workflow("verify-full.yml");
  assert.match(text, /^on:\n  schedule:\n(?:\s+#.*\n)*\s+- cron: '[^']+'\n  workflow_dispatch:$/m);
  assert.doesNotMatch(text, /^\s+push:|^\s+pull_request:/m, "the fork suites would run on a push");
  assert.match(text, /^permissions:\n  contents: read$/m);
  assert.match(text, /ROBINHOOD_TESTNET_RPC_URL: \$\{\{ secrets\.ROBINHOOD_TESTNET_RPC_URL \}\}/);
  assert.match(text, /ROBINHOOD_MAINNET_RPC_URL: \$\{\{ secrets\.ROBINHOOD_MAINNET_RPC_URL \}\}/);
  assert.match(text, /dist\/test\/fork\/\*\.test\.js/, "the fork suites are not the ones run");
});

/**
 * T049's first half: the sweep that runs on a clock says so when it did not
 * run. The service reports its own failures (campaign-routes.ts), but a
 * function that is unreachable runs nothing at all, so this workflow is the
 * only witness. The chat is the operator's; the group is never told.
 */
test("sweep.yml reports its own failure to the operator chat, and never to the group", async () => {
  const text = await workflow("sweep.yml");
  assert.match(text, /^\s+if: failure\(\)$/m, "a failed sweep passes in silence");
  assert.match(text, /MONITOR_CHAT_ID: \$\{\{ secrets\.MONITOR_CHAT_ID \}\}/);
  assert.doesNotMatch(text, /TELEGRAM_CHAT_ID/, "that is the public group's chat id");
  assert.match(text, /api\.telegram\.org/);
});

test("no workflow commits to main: none holds contents: write or pushes, and the progress bot is gone", async () => {
  const names = (await readdir(workflows)).filter((name) => name.endsWith(".yml"));
  assert.ok(!names.includes("progress.yml"), "progress.yml still exists; the build computes progress.json now");
  for (const name of names) {
    const text = await workflow(name);
    assert.doesNotMatch(text, /contents: write/, `${name} may write to the repository`);
    assert.doesNotMatch(text, /^\s+git push\b/m, `${name} pushes`);
  }
});
