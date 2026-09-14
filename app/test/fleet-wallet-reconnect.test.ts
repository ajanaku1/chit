import assert from "node:assert/strict";
import test from "node:test";

/**
 * Coming back from the wallet app must not look like a first visit.
 *
 * A wallet grant lives in the wallet, not in the page: once the trader has
 * approved this origin, `eth_accounts` answers silently on every later load.
 * The page has to ask that question on load and remember the answer somewhere
 * the browser keeps across a reload and a tab switch. Remembering it only in a
 * tab's sessionStorage, and never asking the wallet, is what a trader
 * experiences as "connect again every time I switch apps".
 *
 * `eth_requestAccounts` is the prompt. Every provider below throws on it, so a
 * test that passes is a test where no prompt happened.
 */

type Call = { method: string; params?: unknown[] };

const ADDRESS = "0x1111111111111111111111111111111111111111";
const ROBINHOOD = "0xb626";

class MemoryStorage {
  #items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  clear(): void {
    this.#items.clear();
  }
}

const local = new MemoryStorage();
const session = new MemoryStorage();

/** A wallet that has already granted this origin and will refuse to prompt again. */
const grantedProvider = (accounts: string[]): { request(args: Call): Promise<unknown>; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async request({ method }: Call): Promise<unknown> {
      calls.push(method);
      if (method === "eth_accounts") return accounts;
      if (method === "eth_chainId") return ROBINHOOD;
      if (method === "eth_requestAccounts") throw new Error("prompted the trader for a wallet it already has");
      return null;
    },
  };
};

// One bus for the whole file: the module registers its EIP-6963 listener on the
// window present at import, so a later dispatch has to reach that same target.
const bus = new EventTarget();

const installGlobals = (provider: unknown): void => {
  const target = bus;
  Object.assign(globalThis, {
    localStorage: local,
    sessionStorage: session,
    window: {
      ethereum: provider,
      addEventListener: target.addEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
      matchMedia: () => ({ matches: false }),
    },
  });
};

installGlobals(grantedProvider([ADDRESS]));

const { connectWallet, disconnectWallet, getConnectedWallet, restoreWallet, walletEth } = await import(
  "../src/fleet/page-shared.js"
);

test.beforeEach(() => {
  local.clear();
  session.clear();
  disconnectWallet();
  local.clear();
  session.clear();
});

test("a wallet that already granted this origin comes back without a prompt", async () => {
  const provider = grantedProvider([ADDRESS]);
  installGlobals(provider);

  const restored = await restoreWallet();

  assert.equal(restored, ADDRESS);
  assert.equal(getConnectedWallet(), ADDRESS);
  assert.ok(provider.calls.includes("eth_accounts"), "the page never asked the wallet who is connected");
});

test("the wallet is remembered where a closed tab keeps it, not only for this tab", async () => {
  installGlobals(grantedProvider([ADDRESS]));
  await restoreWallet();

  // A new tab, or a tab iOS discarded while the wallet app was open, keeps
  // localStorage and loses sessionStorage.
  assert.equal(local.getItem("chit-fleet-wallet"), ADDRESS, "a reload or a new tab forgets the wallet");

  session.clear();
  assert.equal(await restoreWallet(), ADDRESS, "the wallet was forgotten when the tab was");
});

test("a wallet the trader revoked in the wallet app is forgotten silently", async () => {
  installGlobals(grantedProvider([ADDRESS]));
  await restoreWallet();
  assert.equal(getConnectedWallet(), ADDRESS);

  installGlobals(grantedProvider([]));
  const restored = await restoreWallet();

  assert.equal(restored, undefined);
  assert.equal(getConnectedWallet(), undefined, "the page still shows a wallet the trader revoked");
});

test("with no wallet in the browser, restoring neither throws nor invents one", async () => {
  installGlobals(undefined);
  assert.equal(await restoreWallet(), undefined);
});

test("connecting still goes through the prompt and records the wallet", async () => {
  const calls: string[] = [];
  installGlobals({
    async request({ method }: Call): Promise<unknown> {
      calls.push(method);
      if (method === "eth_requestAccounts") return [ADDRESS];
      if (method === "eth_chainId") return ROBINHOOD;
      return null;
    },
  });

  assert.equal(await connectWallet(), ADDRESS);
  assert.ok(calls.includes("eth_requestAccounts"), "connecting never asked the wallet");
  assert.equal(local.getItem("chit-fleet-wallet"), ADDRESS);
});

/**
 * The two fixes have to hold hands.
 *
 * Discovering wallets under EIP-6963 means the page must remember not just the
 * address but which wallet holds it. A wallet announcing after the page script
 * ran is taken up by `takeUpLateWallet`, which reads what was remembered — and
 * on the return from the wallet app, the only tab-surviving copy is the one in
 * localStorage. Remember the address there but the wallet only for the tab, and
 * the trader comes back to a page that knows who they are and has no way to
 * reach them.
 */
test("the wallet that was chosen is remembered as durably as the address", async () => {
  installGlobals(undefined);
  local.clear();
  session.clear();

  // What a discarded tab leaves behind: both keys, in the store that survives.
  local.setItem("chit-fleet-wallet", ADDRESS);
  local.setItem("chit-fleet-provider", "io.rabby");

  const calls = { other: [] as string[], rabby: [] as string[] };
  const announce = (name: string, rdns: string, log: string[]): void => {
    bus.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: { name, icon: "", rdns },
          provider: {
            request: async ({ method }: Call): Promise<unknown> => {
              log.push(method);
              if (method === "eth_accounts") return [ADDRESS];
              if (method === "eth_getBalance") return "0x1";
              if (method === "eth_requestAccounts") throw new Error("prompted for a wallet already granted");
              return null;
            },
          },
        },
      }),
    );
  };

  // Announcement order is not ours to choose. The wrong wallet announcing first
  // must not be handed an address it does not hold.
  announce("Other", "com.other", calls.other);
  announce("Rabby", "io.rabby", calls.rabby);

  assert.equal(getConnectedWallet(), ADDRESS, "the remembered wallet was not taken back up");

  await walletEth(ADDRESS);
  assert.ok(calls.rabby.includes("eth_getBalance"), "the call did not go to the wallet the trader chose");
  assert.deepEqual(calls.other, [], "a wallet the trader never chose was handed their address");
});
