import assert from "node:assert/strict";
import test from "node:test";

/**
 * Only the latest connect may take effect. A trader who abandons one attempt
 * and connects again must not be switched back when the abandoned wallet
 * popup is approved later.
 */

const FIRST = "0x1111111111111111111111111111111111111111";
const SECOND = "0x2222222222222222222222222222222222222222";

let releaseFirst: (accounts: string[]) => void = () => undefined;
let asked = 0;
const wallet = {
  request: ({ method }: { method: string }): Promise<unknown> => {
    if (method === "eth_chainId") return Promise.resolve("0xb626");
    asked += 1;
    if (asked === 1) return new Promise((resolve) => (releaseFirst = resolve));
    return Promise.resolve([SECOND]);
  },
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
  const abandoned = shared.connectWallet();
  assert.equal(await shared.connectWallet(), SECOND);
  releaseFirst([FIRST]);
  await abandoned;
  assert.equal(shared.getConnectedWallet(), SECOND);
});
