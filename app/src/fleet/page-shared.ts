/**
 * Shared helpers for the Fleet pages: ETH/wei conversion, the API caller, and
 * the cross-page snapshot.
 *
 * The snapshot carries PUBLIC data only — campaign handle, state, budget
 * numbers, and wallet addresses (which the chain publishes anyway). Private
 * keys and the backup never touch storage; sessionStorage clears with the tab.
 */

import { SetupError } from "./campaign-setup.js";

const SNAPSHOT_KEY = "chit-fleet-snapshot";
const ETH_DECIMAL = /^\d+(\.\d{1,18})?$/;

export type FleetSnapshot = {
  campaign: string;
  state: string;
  budget: { funded: string; reserved: string; spent: string; unused: string };
  accounts: string[];
};

/** "0.001" ETH → "1000000000000000" wei. Rejects anything that isn't a plain decimal. */
export const parseEth = (value: string): string => {
  const trimmed = value.trim();
  if (!ETH_DECIMAL.test(trimmed)) throw new SetupError("invalid_eth_amount");
  const [whole = "0", frac = ""] = trimmed.split(".");
  return (BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"))).toString();
};

/** Wei string → short ETH string for display. */
export const toEth = (wei: string): string => {
  if (!/^\d+$/.test(wei)) return wei;
  const padded = wei.padStart(19, "0");
  const whole = padded.slice(0, -18).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(-18).replace(/0+$/, "").slice(0, 6);
  return frac ? `${whole}.${frac}` : whole;
};

/** Calls a Fleet API route; the route is derived from the action. */
export const fleetApi = async (
  action: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const route = ["pause", "resume", "revoke", "close"].includes(action)
    ? "control"
    : ["balance", "withdraw"].includes(action)
      ? "balance"
      : action === "buy"
        ? "buy"
        : "campaign";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!["quote", "challenge", "read", "balance", "status"].includes(action)) {
    headers["idempotency-key"] = `fleet-${action}${Date.now()}`.padEnd(22, "0").slice(0, 40);
  }
  const response = await fetch(`/api/fleet/${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
};

export const saveFleetSnapshot = (snapshot: FleetSnapshot): void => {
  try {
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage may be unavailable (private mode); the dashboard then shows "no fleet".
  }
};

/** Forgets the saved fleet, for a campaign the service can no longer serve. */
export const clearFleetSnapshot = (): void => {
  try {
    sessionStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // Nothing to forget if storage is unavailable.
  }
};

export const loadFleetSnapshot = (): FleetSnapshot | undefined => {
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as FleetSnapshot;
    if (typeof parsed.campaign !== "string" || !Array.isArray(parsed.accounts)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};

const THEME_KEY = "chit-fleet-theme";

/** Applies the saved theme and wires the header toggle. System preference is the default. */
export const initTheme = (): void => {
  const root = document.documentElement;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // Storage unavailable; fall back to system preference.
  }
  if (saved === "dark" || saved === "light") root.dataset["theme"] = saved;

  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;
  const dark = (): boolean =>
    root.dataset["theme"] === "dark" ||
    (root.dataset["theme"] !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const paint = (): void => {
    toggle.textContent = dark() ? "☀" : "☾";
    toggle.setAttribute("aria-pressed", String(dark()));
  };
  toggle.addEventListener("click", () => {
    const next = dark() ? "light" : "dark";
    root.dataset["theme"] = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Preference simply won't persist.
    }
    paint();
  });
  paint();
};

/** Robinhood Chain testnet, as verified live by eth_chainId (0xb626 = 46630). */
export const ROBINHOOD_TESTNET = {
  chainId: "0xb626",
  chainName: "Robinhood Chain Testnet",
  rpcUrls: ["https://rpc.testnet.chain.robinhood.com"],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
} as const;

export type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/** The wallet's chain id as lowercase hex. EIP-695 says a hex string; Flow Wallet answers with a number. */
const chainIdOf = async (eth: Eip1193): Promise<string> => {
  const id = await eth.request({ method: "eth_chainId" });
  try {
    return `0x${BigInt(id as string | number).toString(16)}`;
  } catch {
    return String(id).toLowerCase();
  }
};

/**
 * Switches the wallet to Robinhood Chain testnet, offering to add it first if
 * the wallet doesn't know it (EIP-3085/3326). Returns true when the wallet is
 * on 46630 afterwards.
 */
export const ensureRobinhoodTestnet = async (eth: Eip1193): Promise<boolean> => {
  if ((await chainIdOf(eth)) === ROBINHOOD_TESTNET.chainId) return true;
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ROBINHOOD_TESTNET.chainId }],
    });
    return (await chainIdOf(eth)) === ROBINHOOD_TESTNET.chainId;
  } catch (error) {
    // 4902: the chain isn't in the wallet yet — add, which usually switches too.
    if ((error as { code?: number }).code !== 4902) return false;
    try {
      await eth.request({ method: "wallet_addEthereumChain", params: [ROBINHOOD_TESTNET] });
      return (await chainIdOf(eth)) === ROBINHOOD_TESTNET.chainId;
    } catch {
      return false;
    }
  }
};

// ---- Shared wallet connection (header + wizard stay in sync) ----

type Hex = `0x${string}`;

const WALLET_KEY = "chit-fleet-wallet";
const WALLET_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PROVIDER_KEY = "chit-fleet-provider";
let connected: Hex | undefined;

/** A wallet as it announces itself under EIP-6963. */
export type InstalledWallet = { name: string; icon: string; rdns: string; provider: Eip1193 };

// Only one wallet can own window.ethereum, and with several installed it need
// not be the trader's: Rabby without an account holds it and answers every
// request with 4001. Each wallet announces its own provider instead. Keyed by
// rdns, which is stable across loads; the announced uuid is not.
const installed = new Map<string, InstalledWallet>();
let chosen: InstalledWallet | undefined;
if (typeof window !== "undefined") {
  let loading = true;
  window.addEventListener("eip6963:announceProvider", (event) => {
    const { info, provider } =
      (event as CustomEvent<{ info?: Partial<InstalledWallet>; provider?: Eip1193 }>).detail ?? {};
    if (typeof info?.rdns !== "string" || typeof provider?.request !== "function") return;
    const known = installed.has(info.rdns);
    installed.set(info.rdns, { name: String(info.name ?? info.rdns), icon: String(info.icon ?? ""), rdns: info.rdns, provider });
    if (!loading && !known) takeUpLateWallet(provider);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  loading = false;
}

/**
 * What the page remembers about the wallet, kept where the trip into the wallet
 * app cannot lose it.
 *
 * The wallet's own grant outlives the tab, so the page's memory of it has to as
 * well. iOS discards a backgrounded tab, and sessionStorage goes with it: the
 * trader came back to a page that had forgotten both the address and which
 * wallet held it, and asked them to connect again. localStorage survives that;
 * sessionStorage is still read, second, to carry over a session that began
 * before this move.
 */
const remember = (key: string, value: string | undefined): void => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Non-persistent; the in-memory value still drives this tab.
  }
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing carried over to clear.
  }
};

const recall = (key: string): string | null => {
  const reads = [(): string | null => localStorage.getItem(key), (): string | null => sessionStorage.getItem(key)];
  for (const read of reads) {
    try {
      const value = read();
      if (value) return value;
    } catch {
      // Storage unavailable (private mode); try the next one.
    }
  }
  return null;
};

const legacyProvider = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;

/**
 * The provider every wallet call goes through: the wallet that connected (or
 * was remembered for this tab), else the only one installed. With several
 * installed and none chosen there is no answer until the trader picks one.
 * Wallets too old for EIP-6963 announce nothing and fall back to window.ethereum.
 */
export const walletProvider = (): Eip1193 | undefined => {
  if (chosen) return chosen.provider;
  const rdns = recall(PROVIDER_KEY);
  const remembered = rdns ? installed.get(rdns) : undefined;
  if (remembered) return remembered.provider;
  // The remembered wallet is gone. Never hand its calls to another wallet,
  // which would be asked to sign for an address it does not hold.
  if (rdns) return undefined;
  if (installed.size === 1) return [...installed.values()][0]!.provider;
  return installed.size === 0 ? legacyProvider() : undefined;
};

/** The remembered address, but only while its wallet can still be reached. */
const readStoredWallet = (): Hex | undefined => {
  if (!walletProvider()) return undefined;
  const v = recall(WALLET_KEY);
  return v && WALLET_ADDRESS.test(v) ? (v.toLowerCase() as Hex) : undefined;
};

export const getConnectedWallet = (): Hex | undefined => connected ?? readStoredWallet();

const shortWallet = (address: Hex): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

const setConnected = (address: Hex | undefined): void => {
  connected = address;
  remember(WALLET_KEY, address);
  window.dispatchEvent(new CustomEvent("chit-wallet-changed", { detail: { address } }));
};

const WALLET_ERROR_TEXT: Record<string, string> = {
  no_wallet: "No wallet found — install one to connect",
  wrong_network: "Switch to Robinhood testnet to connect",
};

/** Asks one wallet for its account and moves it onto Robinhood testnet. */
const connectWith = async (eth: Eip1193): Promise<Hex> => {
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const first = accounts[0];
  if (!first) throw new Error("The wallet shared no account");
  if (!(await ensureRobinhoodTestnet(eth))) throw new Error(WALLET_ERROR_TEXT["wrong_network"]);
  return first.toLowerCase() as Hex;
};

type Chosen = { wallet: InstalledWallet; address: Hex };

/**
 * Lets the trader pick which installed wallet to connect. The dialog stays open
 * through the attempt, so a wallet that refuses says why right there and the
 * trader can pick another. Resolves undefined if they close it.
 */
const chooseWallet = (
  wallets: InstalledWallet[],
  attempt: (wallet: InstalledWallet) => Promise<Hex>,
): Promise<Chosen | undefined> =>
  new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "wallet-chooser";
    dialog.setAttribute("aria-label", "Choose a wallet");
    const heading = document.createElement("h2");
    heading.textContent = "Choose a wallet";
    const list = document.createElement("div");
    list.className = "wallet-chooser-list";
    const status = document.createElement("p");
    status.className = "wallet-chooser-status";
    status.setAttribute("role", "status");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "wallet-chooser-cancel";
    cancel.textContent = "Cancel";

    let settled = false;
    // An attempt outlives the dialog: if the trader closes it and then
    // approves in the wallet popup, the connect still lands.
    let inFlight: Promise<Chosen | undefined> | undefined;
    const finish = (result?: Chosen | Promise<Chosen | undefined>): void => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    const setBusy = (busy: boolean): void => {
      for (const option of list.querySelectorAll("button")) option.disabled = busy;
    };

    for (const wallet of wallets) {
      const option = document.createElement("button");
      option.type = "button";
      if (/^data:image\//.test(wallet.icon)) {
        const icon = document.createElement("img");
        icon.src = wallet.icon;
        icon.alt = "";
        option.append(icon);
      }
      option.append(document.createTextNode(wallet.name));
      option.addEventListener("click", () => {
        status.textContent = `Waiting for ${wallet.name}…`;
        setBusy(true);
        const pending = attempt(wallet).then((address) => ({ wallet, address }));
        inFlight = pending.catch(() => undefined);
        pending.then(finish, (error: unknown) => {
          inFlight = undefined;
          status.textContent = `${wallet.name}: ${(error as Error)?.message || "didn't connect"}`;
          setBusy(false);
        });
      });
      list.append(option);
    }
    const close = (): void => finish(inFlight);
    cancel.addEventListener("click", close);
    dialog.addEventListener("close", close);
    dialog.append(heading, list, status, cancel);
    document.body.append(dialog);
    dialog.showModal();
  });

const adopt = (wallet: InstalledWallet | undefined, address: Hex): void => {
  chosen = wallet;
  remember(PROVIDER_KEY, wallet?.rdns);
  watchAccounts(walletProvider());
  setConnected(address);
};

// A connect that lands after a newer one already connected was abandoned and
// must not replace it. A newer attempt that failed supersedes nothing: wallets
// refuse a duplicate request with -32002 while the first popup is still open,
// and approving that popup must still connect.
let connectCalls = 0;
let lastAdopted = 0;

/**
 * Connects a wallet and moves it onto Robinhood testnet. With more than one
 * installed, the trader chooses which. Returns the address.
 */
export const connectWallet = async (): Promise<Hex | undefined> => {
  const call = ++connectCalls;
  const wallets = [...installed.values()];
  if (wallets.length > 1) {
    const picked = await chooseWallet(wallets, (wallet) => connectWith(wallet.provider));
    if (!picked || call < lastAdopted) return undefined;
    lastAdopted = call;
    adopt(picked.wallet, picked.address);
    return picked.address;
  }
  const only = wallets[0];
  const eth = only?.provider ?? legacyProvider();
  if (!eth) {
    window.dispatchEvent(new CustomEvent("chit-wallet-error", { detail: { reason: "no_wallet" } }));
    return undefined;
  }
  const address = await connectWith(eth);
  if (call < lastAdopted) return undefined;
  lastAdopted = call;
  adopt(only, address);
  return address;
};

export const disconnectWallet = (): void => {
  chosen = undefined;
  remember(PROVIDER_KEY, undefined);
  setConnected(undefined);
};

/**
 * Takes up a wallet that already granted this origin, without prompting.
 *
 * `eth_accounts` is the silent question: the wallet answers from the grant it
 * already holds, so a trader returning from the wallet app is simply in. Only a
 * wallet that answers with no accounts has really been revoked, and only then is
 * the remembered address dropped. With no reachable provider — no wallet yet
 * announced, or the chosen one gone — nothing can be said either way, so what is
 * remembered is left alone for takeUpLateWallet to claim.
 */
export const restoreWallet = async (): Promise<Hex | undefined> => {
  const eth = walletProvider();
  if (!eth) return undefined;
  let accounts: string[];
  try {
    accounts = (await eth.request({ method: "eth_accounts" })) as string[];
  } catch {
    return getConnectedWallet();
  }
  const first = accounts[0];
  if (!first || !WALLET_ADDRESS.test(first)) {
    if (getConnectedWallet()) setConnected(undefined);
    return undefined;
  }
  const address = first.toLowerCase() as Hex;
  watchAccounts(eth);
  // Only a change is announced. This runs on every return to the tab, and
  // re-announcing the same wallet would make every listening page reload.
  if (address === getConnectedWallet()) connected = address;
  else setConnected(address);
  return address;
};

/** The wallet's own ETH on the current chain, as wei. */
export const walletEth = async (wallet: Hex): Promise<string> => {
  const eth = walletProvider();
  if (!eth) return "0";
  const hex = (await eth.request({ method: "eth_getBalance", params: [wallet, "latest"] })) as string;
  return BigInt(hex).toString();
};

/**
 * Polls the wallet's provider for a receipt. A hash means the wallet sent it;
 * only the receipt says whether the chain took it.
 */
export const waitForReceipt = async (
  hash: Hex,
  attempts = 30,
  delayMs = 2_000,
): Promise<{ status?: string } | null> => {
  const eth = walletProvider();
  if (!eth) return null;
  for (let i = 0; i < attempts; i += 1) {
    const receipt = (await eth.request({ method: "eth_getTransactionReceipt", params: [hash] })) as
      | { status?: string }
      | null;
    if (receipt) return receipt;
    await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
  }
  return null;
};

/**
 * A remembered wallet that announces after the page script ran. Taken up now,
 * or the header says Connect while a click on it would disconnect.
 */
function takeUpLateWallet(provider: Eip1193): void {
  if (walletProvider() !== provider) return;
  const address = readStoredWallet();
  if (!address) return;
  watchAccounts(provider);
  setConnected(address);
}

const watched = new WeakSet<object>();

/** Follows account changes on the connected wallet only. */
function watchAccounts(eth: Eip1193 | undefined): void {
  if (!eth || !("on" in eth) || watched.has(eth)) return;
  watched.add(eth);
  const provider = eth as unknown as { on(event: string, handler: (...args: unknown[]) => void): void };
  provider.on("accountsChanged", (accounts) => {
    if (eth !== walletProvider()) return;
    const list = accounts as string[];
    if (list[0]) {
      setConnected(list[0].toLowerCase() as Hex);
      return;
    }
    // Some wallets emit an empty list while a page is still loading. Only a
    // confirmed empty eth_accounts means the trader really disconnected.
    void eth
      .request({ method: "eth_accounts" })
      .then((live) => {
        if (!(live as string[])[0]) setConnected(undefined);
      })
      .catch(() => undefined);
  });
}

/**
 * Wires the header Connect/Disconnect control and keeps it in sync with wallet
 * events. This is a soft in-app disconnect: EIP-1193 has no revoke, so it forgets
 * the address for this session.
 */
export const initHeaderWallet = (): void => {
  const button = document.getElementById("hdr-wallet") as HTMLButtonElement | null;
  if (!button) return;
  connected = readStoredWallet();

  const render = (): void => {
    const address = getConnectedWallet();
    if (address) {
      button.textContent = shortWallet(address);
      button.dataset["state"] = "connected";
      button.setAttribute("aria-label", `${shortWallet(address)} — click to disconnect`);
      button.title = "Disconnect wallet";
    } else {
      button.textContent = "Connect";
      button.dataset["state"] = "disconnected";
      button.setAttribute("aria-label", "Connect wallet");
      button.title = "Connect wallet";
    }
  };

  const showError = (message: string): void => {
    button.textContent = "Try again";
    button.dataset["state"] = "error";
    button.title = message;
    button.setAttribute("aria-label", message);
    window.setTimeout(() => {
      if (button.dataset["state"] === "error") render();
    }, 8_000);
  };

  button.addEventListener("click", () => {
    if (getConnectedWallet()) disconnectWallet();
    else
      void connectWallet().catch((error: unknown) => {
        window.dispatchEvent(
          new CustomEvent("chit-wallet-error", {
            detail: { reason: "rejected", message: (error as Error)?.message },
          }),
        );
      });
  });
  window.addEventListener("chit-wallet-changed", render);
  window.addEventListener("chit-wallet-error", ((event: Event) => {
    const detail = (event as CustomEvent<{ reason: string; message?: string }>).detail;
    showError(WALLET_ERROR_TEXT[detail.reason] ?? detail.message ?? "Couldn't connect");
  }) as EventListener);

  watchAccounts(walletProvider());
  render();

  // On load, and again whenever the tab comes back from the wallet app, ask the
  // wallet silently rather than asking the trader.
  void restoreWallet().catch(() => undefined);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void restoreWallet().catch(() => undefined);
  });
};
