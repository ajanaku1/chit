import assert from "node:assert/strict";
import test from "node:test";

/**
 * Only a connect that is still current may take effect. An abandoned attempt
 * approved later must not replace a newer one that connected. But a newer
 * attempt that failed, like the duplicate a wallet refuses with -32002 while its
 * first popup is still open, must not throw away the approval that follows.
 */

const FIRST = "0x1111111111111111111111111111111111111111";
const SECOND = "0x2222222222222222222222222222222222222222";

let answers: Array<() => Promise<unknown>> = [];
const wallet = {
  request: ({ method }: { method: string }): Promise<unknown> =>
    method === "eth_chainId" ? Promise.resolve("0xb626") : answers.shift()!(),
};

const deferred = (): { promise: Promise<unknown>; release: (accounts: string[]) => void } => {
  let release: (accounts: string[]) => void = () => undefined;
  const promise = new Promise<unknown>((resolve) => (release = resolve));
  return { promise, release };
};

const page = new EventTarget();
page.addEventListener("eip6963:requestProvider", () => {
  page.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: { info: { uuid: "w", name: "Wallet", icon: "", rdns: "io.wallet" }, provider: wallet },
    }),
  );
});
(globalThis as unknown as { window: EventTarget }).window = page;

test("an abandoned connect approved late does not replace the newer one", async () => {
  const shared = await import("../src/fleet/page-shared.js");
  const first = deferred();
  answers = [() => first.promise, () => Promise.resolve([SECOND])];
  const abandoned = shared.connectWallet();
  assert.equal(await shared.connectWallet(), SECOND);
  first.release([FIRST]);
  await abandoned;
  assert.equal(shared.getConnectedWallet(), SECOND);
});

test("a duplicate the wallet refuses does not throw away the approval that follows", async () => {
  const shared = await import("../src/fleet/page-shared.js");
  const first = deferred();
  answers = [
    () => first.promise,
    () => Promise.reject(Object.assign(new Error("Request already pending"), { code: -32002 })),
  ];
  const pending = shared.connectWallet();
  await assert.rejects(shared.connectWallet(), /already pending/);
  first.release([FIRST]);
  assert.equal(await pending, FIRST);
  assert.equal(shared.getConnectedWallet(), FIRST);
});
