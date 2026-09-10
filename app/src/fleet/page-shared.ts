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
  if (!["quote", "challenge", "read", "balance"].includes(action)) {
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

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/**
 * Switches the wallet to Robinhood Chain testnet, offering to add it first if
 * the wallet doesn't know it (EIP-3085/3326). Returns true when the wallet is
 * on 46630 afterwards.
 */
export const ensureRobinhoodTestnet = async (eth: Eip1193): Promise<boolean> => {
  const current = (await eth.request({ method: "eth_chainId" })) as string;
  if (current.toLowerCase() === ROBINHOOD_TESTNET.chainId) return true;
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ROBINHOOD_TESTNET.chainId }],
    });
    return true;
  } catch (error) {
    // 4902: the chain isn't in the wallet yet — add, which usually switches too.
    if ((error as { code?: number }).code !== 4902) return false;
    try {
      await eth.request({ method: "wallet_addEthereumChain", params: [ROBINHOOD_TESTNET] });
      const after = (await eth.request({ method: "eth_chainId" })) as string;
      return after.toLowerCase() === ROBINHOOD_TESTNET.chainId;
    } catch {
      return false;
    }
  }
};

// ---- Shared wallet connection (header + wizard stay in sync) ----

type Hex = `0x${string}`;

const ethereum = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;
const WALLET_KEY = "chit-fleet-wallet";
let connected: Hex | undefined;

const readStoredWallet = (): Hex | undefined => {
  try {
    const v = sessionStorage.getItem(WALLET_KEY);
    return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v.toLowerCase() as Hex) : undefined;
  } catch {
    return undefined;
  }
};

export const getConnectedWallet = (): Hex | undefined => connected ?? readStoredWallet();

const shortWallet = (address: Hex): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

const setConnected = (address: Hex | undefined): void => {
  connected = address;
  try {
    if (address) sessionStorage.setItem(WALLET_KEY, address);
    else sessionStorage.removeItem(WALLET_KEY);
  } catch {
    // Non-persistent; in-memory value still drives this tab.
  }
  window.dispatchEvent(new CustomEvent("chit-wallet-changed", { detail: { address } }));
};

/** Connects the wallet and moves it onto Robinhood testnet. Returns the address. */
export const connectWallet = async (): Promise<Hex | undefined> => {
  const eth = ethereum();
  if (!eth) {
    window.dispatchEvent(new CustomEvent("chit-wallet-error", { detail: { reason: "no_wallet" } }));
    return undefined;
  }
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const first = accounts[0];
  if (!first) return undefined;
  const address = first.toLowerCase() as Hex;
  const onTestnet = await ensureRobinhoodTestnet(eth);
  if (!onTestnet) {
    window.dispatchEvent(new CustomEvent("chit-wallet-error", { detail: { reason: "wrong_network" } }));
    return undefined;
  }
  setConnected(address);
  return address;
};

export const disconnectWallet = (): void => setConnected(undefined);

/** The wallet's own ETH on the current chain, as wei. */
export const walletEth = async (wallet: Hex): Promise<string> => {
  const eth = ethereum();
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
  const eth = ethereum();
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

  button.addEventListener("click", () => {
    if (getConnectedWallet()) disconnectWallet();
    else void connectWallet().catch(() => undefined);
  });
  window.addEventListener("chit-wallet-changed", render);

  const eth = ethereum();
  if (eth && "on" in (eth as object)) {
    const provider = eth as unknown as { on(event: string, handler: (...args: unknown[]) => void): void };
    provider.on("accountsChanged", (accounts) => {
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
  render();
};
