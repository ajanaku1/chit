import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { POOL_PRIVACY_CLAIM, POOL_PRIVATE_FACT, POOL_PUBLIC_FACTS } from "../src/fleet/index.js";

/**
 * What the product is allowed to say once the pool is live (FR-015, SC-009).
 *
 * Honesty is the differentiator here, so the claim is a tested constant rather
 * than prose someone can drift. "Anonymous" and "untraceable" are never claimed;
 * the only place the word may appear is in denying it.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(appRoot);

/** Phrases that are only ever an overclaim, however they are worded. */
const NEVER = ["untraceable", "unlinkab", "no trail"];

/**
 * Words that are fine when the sentence denies them ("not anonymous", "not
 * mainnet") and an overclaim otherwise. The check is per line so a denial
 * cannot launder a claim three paragraphs away.
 */
const ONLY_WHEN_DENIED = ["anonymous", "hidden trade", "mainnet"];
const DENIAL = /\b(not|never|no|without|cannot|isn't|won't|will not|do not|does not|excludes?)\b/i;

const overclaims = (text: string): string[] =>
  text
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => ONLY_WHEN_DENIED.some((word) => new RegExp(word, "i").test(line)) && !DENIAL.test(line));

test("the pool claim says what is hidden, what is not, and who can still see", () => {
  assert.match(POOL_PRIVACY_CLAIM, /operator knows/i, "the operator's view is disclosed, not buried");
  assert.match(POOL_PRIVACY_CLAIM, /no transaction links/i);
  assert.match(POOL_PRIVACY_CLAIM, /amounts and timing/i, "the residual is disclosed");
  for (const overclaim of [...NEVER, ...ONLY_WHEN_DENIED]) {
    assert.equal(
      POOL_PRIVACY_CLAIM.toLowerCase().includes(overclaim),
      false,
      `the claim must not promise: ${overclaim}`,
    );
  }
});

test("the public facts include the deposit and the funding, because both are visible", () => {
  assert.ok(POOL_PUBLIC_FACTS.some((fact) => /deposit/i.test(fact)));
  assert.ok(POOL_PUBLIC_FACTS.some((fact) => /funded/i.test(fact)));
  assert.match(POOL_PRIVATE_FACT, /no transaction/i);
});

test("no page claims anonymity or an absent trail", async () => {
  // The claim constants are checked above; these are the surfaces a reader
  // actually meets.
  const files = [
    join(appRoot, "fleet.html"),
    join(appRoot, "fleet-privacy.html"),
    join(appRoot, "balance.html"),
    join(appRoot, "fleet-dashboard.html"),
    join(repoRoot, "landing/public/index.html"),
  ];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const overclaim of NEVER) {
      assert.equal(text.toLowerCase().includes(overclaim), false, `${file} claims "${overclaim}"`);
    }
    assert.deepEqual(overclaims(text), [], `${file} uses a word it has not earned`);
  }
});

test("the privacy page carries the pool claim itself, not a paraphrase", async () => {
  const html = await readFile(join(appRoot, "fleet-privacy.html"), "utf8");
  assert.match(html, /id="pool-claim"/, "the claim has one home the tests can hold");
  assert.match(html, /shared pool/i);
  assert.match(html, /not anonymous/i, "the honest framing is on the page, not just in the docs");
});
