import assert from "node:assert/strict";
import test from "node:test";

/**
 * With several wallets installed only one can own window.ethereum, and it need
 * not be the trader's. Rabby without an account answers every request, even
 * eth_chainId, with 4001, so a page that talks to window.ethereum never reaches
 * the MetaMask installed next to it. Wallets announce their own providers under
 * EIP-6963; connecting and every later wallet call must use those.
 */

type Request = { method: string; params?: unknown[] };
const TRADER = "0xAbC0000000000000000000000000000000000001";

const rabby = {
  isRabby: true,
  isMetaMask: true,
  request: async (): Promise<unknown> => {
    throw Object.assign(new Error("wallet must has at least one account"), { code: 4001 });
  },
};

const calls: string[] = [];
const metamask = {
  request: async ({ method }: Request): Promise<unknown> => {
    calls.push(method);
    if (method === "eth_requestAccounts") return [TRADER];
    if (method === "eth_chainId") return "0xb626";
    return null;
  },
};

const page = Object.assign(new EventTarget(), { ethereum: rabby });
page.addEventListener("eip6963:requestProvider", () => {
  page.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: { info: { uuid: "mm", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: metamask },
    }),
  );
});
(globalThis as unknown as { window: EventTarget }).window = page;

test("connecting reaches the announced wallet, not the one holding window.ethereum", async () => {
  const shared = await import("../src/fleet/page-shared.js");
  assert.equal(await shared.connectWallet(), TRADER.toLowerCase());
  assert.deepEqual(calls, ["eth_requestAccounts", "eth_chainId"]);
});

test("every later wallet call goes to the wallet that connected", async () => {
  const shared = await import("../src/fleet/page-shared.js");
  assert.equal(shared.walletProvider(), metamask);
});

// EIP-695 says eth_chainId is a hex string. Flow Wallet answers with a number,
// and calling .toLowerCase() on it killed the connect before it could finish.
test("a wallet that answers eth_chainId with a number is still read correctly", async () => {
  const { ensureRobinhoodTestnet } = await import("../src/fleet/page-shared.js");
  const numeric = { request: async ({ method }: Request) => (method === "eth_chainId" ? 46630 : null) };
  assert.equal(await ensureRobinhoodTestnet(numeric), true);
});

// A remembered address is only a connection if its wallet can still be
// reached. Otherwise the header shows it while every signature fails, or a
// different wallet is asked to sign for an address it does not hold.
test("a remembered wallet that is no longer installed is neither shown nor swapped", async () => {
  const shared = await import("../src/fleet/page-shared.js");
  shared.disconnectWallet();
  const store = new Map([
    ["chit-fleet-wallet", TRADER],
    ["chit-fleet-provider", "io.rabby"],
  ]);
  (globalThis as unknown as { sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).sessionStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
  assert.equal(shared.walletProvider(), undefined, "another wallet was handed the remembered one's calls");
  assert.equal(shared.getConnectedWallet(), undefined, "an unreachable wallet still shows as connected");
});

// A remembered wallet can announce after the page script ran. Unless the page
// takes it up then, the header says Connect while getConnectedWallet() already
// returns the address, and the first click on "Connect" disconnects.
test("a remembered wallet that announces after load is taken up and watched", async () => {
  const shared = await import("../src/fleet/page-shared.js");
  shared.disconnectWallet();
  const store = new Map([
    ["chit-fleet-wallet", TRADER],
    ["chit-fleet-provider", "io.late"],
  ]);
  (globalThis as unknown as { sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).sessionStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
  const seen: unknown[] = [];
  page.addEventListener("chit-wallet-changed", (event) => seen.push((event as CustomEvent).detail.address));
  const watched: string[] = [];
  const late = { request: async (): Promise<unknown> => null, on: (event: string) => void watched.push(event) };
  page.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: { info: { uuid: "late", name: "Late Wallet", icon: "", rdns: "io.late" }, provider: late },
    }),
  );
  assert.equal(shared.walletProvider(), late);
  assert.deepEqual(seen, [TRADER.toLowerCase()], "pages were never told the remembered wallet arrived");
  assert.deepEqual(watched, ["accountsChanged"], "account changes on the late wallet are never followed");
});

// A switch request that resolves is not proof: the deposit guard must see 46630.
test("a wallet that accepts the switch but stays on another chain is not treated as switched", async () => {
  const { ensureRobinhoodTestnet } = await import("../src/fleet/page-shared.js");
  const stubborn = { request: async ({ method }: Request) => (method === "eth_chainId" ? "0x1" : null) };
  assert.equal(await ensureRobinhoodTestnet(stubborn), false);
});
