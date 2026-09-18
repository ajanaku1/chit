import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Opening chit.tools and pressing "Open the app" put a signature request in
 * front of the trader before they had touched anything: the setup page read
 * the balance as it loaded, and so did every other page. A wallet popup nobody
 * clicked for reads as a bug. Pages now show a recent answer when they have
 * one, read what is public without signing, and ask before they sign.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (name: string): Promise<string> => readFile(join(appRoot, "src", name), "utf8");
const method = (text: string, head: RegExp): string => {
  const match = new RegExp(`${head.source}[\\s\\S]*?\\n  \\}\\n`).exec(text);
  assert.ok(match, `no ${head} to inspect`);
  return match[0];
};

class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | undefined;
  textContent = "";
  className = "";
  type = "";
  #listeners: Array<() => void> = [];
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  after(node: FakeNode): void {
    const siblings = this.parent!.children;
    node.parent = this.parent;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
  addEventListener(_type: string, listener: () => void): void {
    this.#listeners.push(listener);
  }
  click(): void {
    for (const listener of this.#listeners) listener();
  }
  find(className: string): FakeNode | undefined {
    for (const child of this.children) {
      if (child.className === className) return child;
      const deeper = child.find(className);
      if (deeper) return deeper;
    }
    return undefined;
  }
}

Object.assign(globalThis, {
  document: { createElement: () => new FakeNode(), getElementById: () => null },
});
const { askBeforeSigning, dropSigningAsk } = await import("../src/fleet/page-shared.js");

test("asking before signing waits for the click, says why, and replaces an older ask", async () => {
  const card = new FakeNode();
  let answered = false;
  const first = askBeforeSigning(card as unknown as HTMLElement, "Your fleets are private to your wallet.", "Show my fleets");
  void first.then(() => (answered = true));
  await Promise.resolve();
  assert.equal(answered, false, "the ask resolved before anyone clicked");
  const gate = card.find("wallet-gate");
  assert.ok(gate, "nothing on the page says a signature is needed");
  assert.match(gate.children[0]!.textContent, /private to your wallet\. Signing is free and sends no transaction\./);
  assert.equal(gate.children[1]!.textContent, "Show my fleets");

  void askBeforeSigning(card as unknown as HTMLElement, "Again.", "Show");
  assert.equal(card.children.filter((child) => child.className === "wallet-gate").length, 1, "two asks on one page");

  const second = card.find("wallet-gate")!;
  const clicked = askBeforeSigning(card as unknown as HTMLElement, "Third.", "Go");
  card.find("wallet-gate")!.children[1]!.click();
  await clicked;
  assert.equal(card.find("wallet-gate"), undefined, "the ask stays up after the click");
  assert.equal(second.parent, undefined);
});

test("an ask can sit right after an element, and dropping it takes it down", () => {
  const page = new FakeNode();
  const note = new FakeNode();
  const later = new FakeNode();
  page.append(note, later);
  void askBeforeSigning(note as unknown as HTMLElement, "Private.", "Show them", "after");
  assert.equal(page.children[1]!.className, "wallet-gate");
  dropSigningAsk();
  assert.deepEqual(page.children, [note, later]);
});

test("setup never signs while it takes up a remembered wallet", async () => {
  const page = await source("fleet-page.ts");
  const adopt = method(page, /async #adopt\(/);
  assert.doesNotMatch(adopt, /#fetchBalance\(|readBalance\(|signedFleetApi\(|#loadBalance\(/, "opening setup signs for the balance");
  assert.match(adopt, /recentBalance\(address\)/, "a recent balance is not shown on arrival");
  assert.match(adopt, /#warnIfNothingDeposited\(address\)/, "an empty balance is no longer caught before anything is created");
  const warn = method(page, /async #warnIfNothingDeposited\(/);
  assert.match(warn, /method: "eth_call"/);
  assert.doesNotMatch(warn, /personal_sign|signedFleetApi|readBalance/);
  assert.match(page, /if \(typeof body\["poolAddress"\] === "string"\) this\.#poolAddress/, "the unsigned quote's pool is not used");
  const go = method(page, /#go\(step: Step\)/);
  assert.match(go, /step === "launch"[\s\S]*#loadBalance\(false\)/, "the launch step, reached by a click, does not read the balance");
  assert.match(method(page, /#renderLaunch\(\): void/), /this\.#balanceKnown\s*\?/, "an unread balance is shown as zero");
});

test("the Balance page asks before it signs when it has nothing recent to show", async () => {
  const page = await source("balance-page.ts");
  const onWallet = /const onWalletChanged = async[\s\S]*?\n\};/.exec(page)?.[0] ?? "";
  const ask = onWallet.indexOf("askBeforeSigning(");
  assert.ok(ask > 0 && onWallet.indexOf("const recent = recentBalance(address);") < ask, "no ask guarded by a recent read");
  assert.ok(ask < onWallet.indexOf("await refresh()"), "the page signs before it asks");
  assert.match(onWallet, /renderWalletEth\(\)/, "the wallet's own ETH, which needs no signature, waits for the ask");
  // Figures on screen above a button offering to reveal them is the gate
  // contradicting itself: either the read is recent enough to show, or it is not.
  assert.doesNotMatch(onWallet, /loadCachedBalance\(/, "a read too old to show without signing is rendered anyway");
  assert.match(onWallet, /if \(recent\) \{[\s\S]*\} else \{[\s\S]*askBeforeSigning\(/, "the figures and the ask are not exclusive branches");
});

/**
 * Put to us as: why is it hidden on some pages and not on another page? The
 * Control Room gated the balance behind a signature while the header menu had
 * it on show, because each surface decided for itself what "recent" meant.
 */
test("only the shared freshness rule decides a Chit balance may show without signing", async () => {
  for (const name of ["balance-page.ts", "fleet-dashboard.ts", "fleet-page.ts", "trade-page.ts"]) {
    assert.doesNotMatch(await source(name), /loadCachedBalance\(/, `${name} reaches around the freshness rule`);
  }
  assert.match(await source("fleet/balance-read.ts"), /showableBalance\(sessionStorage, wallet, now\)/, "recentBalance keeps its own copy of the rule");
  assert.match(await source("fleet/page-shared.ts"), /showableBalance\(sessionStorage, address\)/, "the wallet menu keeps its own copy of the rule");
});

test("the Control Room asks only for the figures it is actually hiding", async () => {
  const page = await source("fleet-dashboard.ts");
  const refresh = method(page, /async #refresh\(asked = false\)/);
  assert.match(refresh, /const ask = recent\b/, "the wording ignores what is already on screen");
  assert.match(refresh, /"Show holdings"/, "a balance already showing is re-gated along with the holdings");
  assert.match(refresh, /"Show my balance"/, "holdings already read are re-gated along with the balance");
  assert.match(refresh, /askBeforeSigning\(anchor, ask\.lead, ask\.label, "after"\)/, "the ask does not follow what is missing");
});

/**
 * The same complaint, from the other side: the strip kept a balance it had
 * read once, so after the read aged out, or a top up cleared it, the figure
 * stayed on screen above "Your balance ... is private. Show them".
 */
test("the Control Room never keeps a balance on screen while it asks for it", async () => {
  const page = await source("fleet-dashboard.ts");
  const refresh = method(page, /async #refresh\(asked = false\)/);
  assert.match(refresh, /if \(recent\) this\.#showBalance\(recent\);\s*else this\.#availableKnown = false;/, "a balance read before the window closed stays up beside the ask for it");
  assert.match(refresh, /const anchor = recent\s*\?\s*el\("wallets-note"\)/, "the ask for holdings sits under the balance, which it does not unlock");
});

test("the Trade page asks before it signs for fleets or holdings, and its polls never open the wallet alone", async () => {
  const page = await source("trade-page.ts");
  const onWallet = method(page, /async #onWallet\(\)/);
  const ask = onWallet.indexOf("askBeforeSigning(");
  assert.ok(ask > 0 && ask < onWallet.indexOf('readSigned(wallet, "list"'), "the fleet list signs before the page asks");
  assert.ok(onWallet.indexOf("this.#schedule()") < ask, "running orders wait for the list read");
  const holdings = method(page, /async #holdings\(asked: boolean\)/);
  assert.ok(holdings.indexOf("if (!asked)") < holdings.indexOf("#readHoldings("), "holdings sign on load without a click");
  const poll = method(page, /async #pollOnce\(sign: boolean\)/);
  assert.match(poll, /orderTrade\([\s\S]*?\{ sign \}\)/, "a poll may sign without the trader's click");
  assert.match(poll, /error instanceof SignatureMissing[\s\S]*markUnsent\(/, "a poll that could not sign is counted as an attempt");
  assert.match(method(page, /#schedule\(\): void/), /!record\.needsSignature/, "an order waiting for a signature is polled on a timer");
  assert.match(page, /"Sign to continue"[\s\S]*this\.#poll\(true\)/, "an order waiting for a signature has no way to continue");
  assert.match(page, /window\.setTimeout\(\(\) => void this\.#poll\(\), /, "the timer's poll may sign");
});

test("the Control Room asks before it signs, and its funding poll never signs", async () => {
  const page = await source("fleet-dashboard.ts");
  const refresh = method(page, /async #refresh\(asked = false\)/);
  const ask = refresh.indexOf("askBeforeSigning(");
  assert.ok(ask > 0 && ask < refresh.indexOf("await readBalance(wallet)"), "the balance signs before the page asks");
  assert.match(refresh, /if \(!asked && \(!recent \|\| !recentHoldings\)\)/);
  assert.match(refresh, /setTimeout\(\(\) => void this\.#refresh\(\), delay\)/, "the funding poll is allowed to sign");
  const resume = /const resumeFromService = async[\s\S]*?\n\};/.exec(page)?.[0] ?? "";
  assert.ok(resume.indexOf("askBeforeSigning(") > 0 && resume.indexOf("askBeforeSigning(") < resume.indexOf('readSigned(wallet, "list"'), "finding a fleet from another tab signs on load");
});
