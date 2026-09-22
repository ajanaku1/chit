/**
 * Shared helpers for the Fleet pages: ETH/wei conversion, the API caller, and
 * the cross-page snapshot.
 *
 * The snapshot carries PUBLIC data only — campaign handle, state, budget
 * numbers, and wallet addresses (which the chain publishes anyway). Private
 * keys and the backup never touch storage; sessionStorage clears with the tab.
 */

import { freshPoolStatus, loadCachedBalance, poolStatus, setChainLabel, showableBalance } from "./balance.js";
import { initHoldersGate } from "./holders-gate.js";
import { SetupError } from "./campaign-setup.js";
import { hydrateLed } from "./led.js";
import { revealOnEnter } from "./motion.js";
import { icon, walletMark, type IconName } from "./wallet-menu.js";

const SNAPSHOT_KEY = "chit-fleet-snapshot";
const ETH_DECIMAL = /^\d+(\.\d{1,18})?$/;

export type FleetSnapshot = {
  campaign: string;
  state: string;
  budget: { funded: string; reserved: string; spent: string; unused: string };
  accounts: string[];
};

/** "0.001" ETH → "1000000000000000" wei. Rejects anything that isn't a plain decimal. */
/**
 * The page's one status line. Fixed to the viewport, so it is read where the
 * action happened rather than back at the top of the page; "ok" fades after a
 * while, an error or a pending state stays until the next message replaces it.
 */
let bannerTimer: ReturnType<typeof setTimeout> | undefined;
export const banner = (message: string, tone: "pending" | "error" | "ok"): void => {
  const node = document.getElementById("status-banner");
  if (!node) return;
  clearTimeout(bannerTimer);
  node.textContent = message;
  node.dataset["tone"] = tone;
  node.hidden = false;
  node.dataset["shown"] = "";
  // Re-trigger the entrance for a message that replaces another.
  void node.offsetWidth;
  node.dataset["shown"] = "true";
  if (tone === "ok") bannerTimer = setTimeout(() => { node.hidden = true; delete node.dataset["shown"]; }, 7000);
};

export const SIGN_IS_FREE = "Signing is free and sends no transaction.";

let openAsk: HTMLElement | undefined;

/**
 * Resolves once the trader asks for what needs a signature. A page never opens
 * the wallet while it loads: a popup nobody clicked for reads as a bug. Shown
 * only when there is no recent answer to show instead.
 */
export const askBeforeSigning = (
  anchor: HTMLElement,
  lead: string,
  label: string,
  where: "inside" | "after" = "inside",
): Promise<void> =>
  new Promise((resolve) => {
    dropSigningAsk();
    const gate = document.createElement("div");
    gate.className = "wallet-gate";
    const text = document.createElement("p");
    text.textContent = `${lead} ${SIGN_IS_FREE}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary";
    button.textContent = label;
    button.addEventListener("click", () => {
      dropSigningAsk();
      resolve();
    });
    gate.append(text, button);
    if (where === "after") anchor.after(gate);
    else anchor.append(gate);
    openAsk = gate;
  });

/** Takes down the page's pending ask; its wallet is gone or another ask replaces it. */
export const dropSigningAsk = (): void => {
  openAsk?.remove();
  openAsk = undefined;
};

const openPrompts: string[] = [];

/**
 * Says what the wallet is about to ask before it asks, and takes the note down
 * once it answers. A prompt nobody explained reads as the app asking for the
 * same thing again.
 */
export const withWalletPrompt = async <T>(message: string, ask: () => Promise<T>): Promise<T> => {
  openPrompts.push(message);
  banner(message, "pending");
  try {
    return await ask();
  } finally {
    openPrompts.splice(openPrompts.indexOf(message), 1);
    const node = document.getElementById("status-banner");
    // Only our own note is taken down; a message the page set since then stays.
    if (node && !node.hidden && node.textContent === message) {
      const waiting = openPrompts.at(-1);
      if (waiting) banner(waiting, "pending");
      else {
        node.hidden = true;
        delete node.dataset["shown"];
      }
    }
  }
};

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
        : action === "trade"
          ? "trade"
          : "campaign";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!["quote", "challenge", "read", "balance", "status", "tokenQuote", "order", "list", "holdings"].includes(action)) {
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

/** Robinhood Chain testnet, as verified live by eth_chainId (0xb626 = 46630). */
/**
 * The chain the app is on. Testnet by default; `chain-target.json`, written
 * by the deploy scripts, overrides it (mainnet beta: 4663, with a note the
 * shell shows on every page). Loaded once, before any wallet call, and
 * mutated in place so every module that imported it sees the same object.
 */
/**
 * The chain this bundle was built for, injected by app/build.mjs from the
 * same target it writes to chain-target.json (T081). The file is still read
 * at runtime, and still wins, but the default a page starts from is its own
 * host's chain: a build for the beta that cannot read the file must not fall
 * back to the playground's chain and ask a wallet to switch to testnet on the
 * real-money host. The fallback here is only for a bundle built without the
 * define, which is a test importing this module directly.
 */
declare const __CHAIN_TARGET__: { chainId: number; chainName: string; rpcUrls: string[] } | undefined;
// Imported directly (a test, not a bundle) the define is absent and the
// playground is the fallback, as it always was. In a deploy the define is
// always there, so the fallback is dead code in both bundles and neither
// host can start on the other's chain.
const BUILT_FOR = (typeof __CHAIN_TARGET__ === "undefined" ? undefined : __CHAIN_TARGET__)
  ?? { chainId: 46630, chainName: "Robinhood Chain Testnet", rpcUrls: ["https://rpc.testnet.chain.robinhood.com"] };

/** What the pool's status line calls the chain: the playground says testnet and its id, the beta its own name and id. */
const chainLabelFor = (chainId: number, chainName: string): string =>
  chainName.toLowerCase().includes("testnet") ? `testnet ${chainId}` : `${chainName} ${chainId}`;

/** The chain a wallet is asked to add or switch to: this host's, from the build, replaced by chain-target.json when it loads. */
export const ROBINHOOD_TESTNET = {
  chainId: `0x${BUILT_FOR.chainId.toString(16)}`,
  chainName: BUILT_FOR.chainName,
  rpcUrls: [...BUILT_FOR.rpcUrls],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};
export const CHAIN = ROBINHOOD_TESTNET;
export type ChainTarget = { chainId: number; chainName: string; rpcUrls: string[]; beta?: boolean; betaNote?: string; buyChitUrl?: string; testnetUrl?: string };
if (BUILT_FOR.chainId) setChainLabel(chainLabelFor(BUILT_FOR.chainId, BUILT_FOR.chainName));

export let chainTarget: ChainTarget = { chainId: BUILT_FOR.chainId, chainName: ROBINHOOD_TESTNET.chainName, rpcUrls: [...ROBINHOOD_TESTNET.rpcUrls] };
/** The chain id as the wizard signs it and the service checks it. */
export const chainIdDecimal = (): string => String(chainTarget.chainId);

let chainLoaded: Promise<void> | undefined;
export const loadChainTarget = (): Promise<void> => {
  chainLoaded ??= (async () => {
    try {
      const target = (await (await fetch("./chain-target.json")).json()) as Partial<ChainTarget>;
      if (typeof target.chainId === "number" && target.chainId > 0) {
        chainTarget = { chainId: target.chainId, chainName: target.chainName ?? `chain ${target.chainId}`, rpcUrls: target.rpcUrls?.length ? target.rpcUrls : ROBINHOOD_TESTNET.rpcUrls, ...(target.beta ? { beta: true, betaNote: target.betaNote ?? "", buyChitUrl: target.buyChitUrl ?? "", testnetUrl: target.testnetUrl ?? "" } : {}) };
        ROBINHOOD_TESTNET.chainId = `0x${target.chainId.toString(16)}`;
        ROBINHOOD_TESTNET.chainName = chainTarget.chainName;
        ROBINHOOD_TESTNET.rpcUrls = chainTarget.rpcUrls;
        setChainLabel(chainLabelFor(target.chainId, chainTarget.chainName));
      }
    } catch {
      // no target file: testnet, as built
    }
  })();
  return chainLoaded;
};

/** The beta note, on every page, from the target and nowhere else: a page never claims a chain of its own. */
const showBetaNote = (): void => {
  if (!chainTarget.beta || document.getElementById("beta-note")) return;
  const note = document.createElement("p");
  note.id = "beta-note";
  note.className = "callout";
  note.setAttribute("role", "note");
  note.textContent = chainTarget.betaNote || `Beta on ${chainTarget.chainName}: capped, not audited by a firm yet.`;
  document.querySelector(".masthead")?.insertAdjacentElement("afterend", note);
};

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
  await loadChainTarget();
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
      // As in restoreWallet: re-announcing an unchanged account makes every page re-read.
      const address = list[0].toLowerCase() as Hex;
      if (address === getConnectedWallet()) connected = address;
      else setConnected(address);
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

/** The wallet app holding the connection, when the page can tell which one. */
const connectedWalletApp = (): InstalledWallet | undefined => {
  if (chosen) return chosen;
  const rdns = recall(PROVIDER_KEY);
  if (rdns) return installed.get(rdns);
  return installed.size === 1 ? [...installed.values()][0] : undefined;
};

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const menuRow = (name: IconName, label: string, className?: string): { row: HTMLButtonElement; label: HTMLSpanElement } => {
  const row = make("button", className);
  row.type = "button";
  const text = make("span", undefined, label);
  row.append(icon(name), text);
  return { row, label: text };
};

/**
 * Wires the header wallet control and keeps it in sync with wallet events.
 * Disconnected, a click connects. Connected, a click opens the wallet menu:
 * which wallet and network this is, what it holds, and the actions (copy,
 * switch wallet, disconnect), so reaching for the address never drops the
 * wallet. Nothing in the menu signs: the wallet's ETH and its network are
 * silent reads, and the Chit balance shows only from a recent read.
 * Disconnect is soft: EIP-1193 has no revoke, so it forgets the address for
 * this session.
 */
export const initHeaderWallet = (): void => {
  const button = document.getElementById("hdr-wallet") as HTMLButtonElement | null;
  if (!button) return;
  connected = readStoredWallet();

  const menu = make("div", "wallet-menu");
  menu.id = "hdr-wallet-menu";
  menu.hidden = true;

  const who = make("div", "wallet-menu__who");
  const shortLine = make("p", "wallet-menu__short");
  const via = make("p", "wallet-menu__via");
  const fullAddress = make("p", "wallet-menu__address");

  const network = make("div", "wallet-menu__net");
  const networkText = make("span");
  const switchNetwork = make("button", undefined, "Switch network");
  switchNetwork.type = "button";
  switchNetwork.hidden = true;
  network.append(networkText, switchNetwork);

  const figures = make("dl", "wallet-menu__figures");
  const walletFigure = make("dd");
  const chitFigure = make("dd");
  for (const [term, value] of [["In your wallet", walletFigure], ["At Chit", chitFigure]] as const) {
    const row = make("div");
    row.append(make("dt", undefined, term), value);
    figures.append(row);
  }

  const actions = make("div", "wallet-menu__actions");
  const { row: copy, label: copyLabel } = menuRow("copy", "Copy address");
  const { row: switchWallet } = menuRow("swap", "Switch wallet");
  const { row: disconnect } = menuRow("leave", "Disconnect", "danger");
  actions.append(copy, switchWallet, disconnect);

  const copyStatus = make("span", "sr-only");
  copyStatus.setAttribute("role", "status");
  copyStatus.setAttribute("aria-live", "polite");
  menu.append(who, fullAddress, network, figures, actions, copyStatus);
  button.after(menu);

  const stillShowing = (address: Hex): boolean => !menu.hidden && getConnectedWallet() === address;

  const showNetwork = async (address: Hex): Promise<boolean | undefined> => {
    const eth = walletProvider();
    let onChain: boolean | undefined;
    try {
      onChain = eth ? (await chainIdOf(eth)) === ROBINHOOD_TESTNET.chainId : undefined;
    } catch {
      onChain = undefined;
    }
    if (!stillShowing(address)) return onChain;
    network.dataset["state"] = onChain === undefined ? "unknown" : onChain ? "ok" : "wrong";
    network.dataset["live"] = String(onChain === true);
    networkText.textContent =
      onChain === undefined ? "Network not known" : onChain ? ROBINHOOD_TESTNET.chainName : "Your wallet is on another network.";
    switchNetwork.hidden = onChain !== false;
    return onChain;
  };

  /**
   * The network, then the wallet's ETH on it. Only a balance on Robinhood
   * testnet is the one Chit uses; with no provider or another network,
   * walletEth would report a zero or another chain's ETH.
   */
  const showChainAndEth = async (address: Hex): Promise<void> => {
    walletFigure.textContent = "…";
    const text = await showNetwork(address)
      .then((onChain) => (onChain ? walletEth(address).then((wei) => `${toEth(wei)} ETH`) : "—"))
      .catch(() => "—");
    if (stillShowing(address)) walletFigure.textContent = text;
  };

  /** Everything the menu says, read fresh each time it opens. */
  const fillMenu = (address: Hex): void => {
    who.replaceChildren(walletMark(address), shortLine, via);
    shortLine.textContent = shortWallet(address);
    const app = connectedWalletApp();
    via.replaceChildren();
    if (app && /^data:image\//.test(app.icon)) {
      const logo = make("img");
      logo.src = app.icon;
      logo.alt = "";
      via.append(logo);
    }
    via.append(app ? app.name : "Connected wallet");
    fullAddress.textContent = address;
    switchWallet.hidden = installed.size < 2;

    network.dataset["state"] = "unknown";
    network.dataset["live"] = "false";
    networkText.textContent = "Checking network…";
    switchNetwork.hidden = true;
    void showChainAndEth(address);

    // A recent read only: opening the menu never opens the wallet.
    const cached = showableBalance(sessionStorage, address);
    if (cached) {
      chitFigure.textContent = `${toEth(cached.available)} ETH`;
    } else {
      const link = make("a", undefined, "See balance");
      link.href = "./balance.html";
      chitFigure.replaceChildren(link);
    }
  };

  const openMenu = (): void => {
    const address = getConnectedWallet();
    if (!address) return;
    menu.hidden = false;
    fillMenu(address);
    button.setAttribute("aria-expanded", "true");
    copy.focus();
  };
  const closeMenu = (returnFocus: boolean): void => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (returnFocus) button.focus();
  };

  const render = (): void => {
    const address = getConnectedWallet();
    if (address) {
      button.replaceChildren(walletMark(address), make("span", undefined, shortWallet(address)), icon("chevron", "wallet-btn__chevron"));
      button.dataset["state"] = "connected";
      button.setAttribute("aria-label", `Wallet ${shortWallet(address)}`);
      button.setAttribute("aria-controls", menu.id);
      button.setAttribute("aria-expanded", String(!menu.hidden));
      button.title = "Wallet details";
      if (!menu.hidden) fillMenu(address);
    } else {
      closeMenu(false);
      button.textContent = "Connect wallet";
      button.dataset["state"] = "disconnected";
      button.setAttribute("aria-label", "Connect wallet");
      button.removeAttribute("aria-controls");
      button.removeAttribute("aria-expanded");
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
    if (getConnectedWallet()) {
      if (menu.hidden) openMenu();
      else closeMenu(false);
      return;
    }
    void connectWallet().catch((error: unknown) => {
      window.dispatchEvent(
        new CustomEvent("chit-wallet-error", {
          detail: { reason: "rejected", message: (error as Error)?.message },
        }),
      );
    });
  });

  let copyReset: number | undefined;
  copy.addEventListener("click", () => {
    const address = getConnectedWallet();
    if (!address) return;
    // A page served without a secure context has no clipboard; that is a failed copy, not a crash.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(address))
      .then(() => {
        copy.replaceChildren(icon("check"), copyLabel);
        copyLabel.textContent = "Copied";
        copyStatus.textContent = "Wallet address copied.";
      })
      .catch(() => {
        copy.replaceChildren(icon("copy"), copyLabel);
        copyLabel.textContent = "Copy failed";
        copyStatus.textContent = "Copy failed. Try again.";
      })
      .finally(() => {
        window.clearTimeout(copyReset);
        copyReset = window.setTimeout(() => {
          copy.replaceChildren(icon("copy"), copyLabel);
          copyLabel.textContent = "Copy address";
        }, 1600);
      });
  });
  switchNetwork.addEventListener("click", () => {
    const eth = walletProvider();
    const address = getConnectedWallet();
    if (!eth || !address) return;
    void withWalletPrompt("Check your wallet: approve the switch to Robinhood Chain testnet.", () => ensureRobinhoodTestnet(eth))
      .catch(() => false)
      .then(() => showChainAndEth(address));
  });
  switchWallet.addEventListener("click", () => {
    closeMenu(false);
    void connectWallet().catch((error: unknown) => {
      window.dispatchEvent(new CustomEvent("chit-wallet-error", { detail: { reason: "rejected", message: (error as Error)?.message } }));
    });
  });
  disconnect.addEventListener("click", () => {
    closeMenu(false);
    disconnectWallet();
    button.focus();
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Node;
    if (!menu.contains(target) && !button.contains(target)) closeMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) closeMenu(true);
  });
  menu.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    if (next && !menu.contains(next) && next !== button) closeMenu(false);
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

/** The phone menu: the burger opens the nav sheet it controls; Escape or a link closes it. */
export const initMenu = (): void => {
  const burger = document.querySelector<HTMLButtonElement>(".burger");
  const nav = document.getElementById("fleet-nav");
  if (!burger || !nav) return;
  const set = (open: boolean): void => {
    burger.setAttribute("aria-expanded", String(open));
    nav.dataset["open"] = String(open);
  };
  burger.addEventListener("click", () => {
    const open = burger.getAttribute("aria-expanded") !== "true";
    set(open);
    // The links come before the burger in the page, so opening moves focus into them.
    if (open) nav.querySelector<HTMLElement>("a")?.focus();
  });
  nav.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("a")) set(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && burger.getAttribute("aria-expanded") === "true") {
      set(false);
      burger.focus();
    }
  });
};

/**
 * The masthead's CHIT token row, copied as on the landing. The address shows
 * shortened, but its text is whole, so this copies all of it.
 */
export const initContractCopy = (): void => {
  const address = document.getElementById("contract-address");
  const button = document.getElementById("copy-contract-address");
  const status = document.getElementById("copy-contract-status");
  const label = button?.querySelector(".contract-row__action");
  if (!address || !button || !status || !label) return;
  let reset: number | undefined;
  button.addEventListener("click", () => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(address.textContent ?? ""))
      .then(() => {
        button.classList.remove("error");
        button.dataset["state"] = "copied";
        label.textContent = "Copied";
        status.textContent = "CHIT token address copied.";
      })
      .catch(() => {
        button.classList.add("error");
        delete button.dataset["state"];
        label.textContent = "Copy failed. Try again.";
        status.textContent = "Copy failed. Try again.";
      })
      .finally(() => {
        window.clearTimeout(reset);
        reset = window.setTimeout(() => {
          button.classList.remove("error");
          delete button.dataset["state"];
          label.textContent = "Copy";
        }, 1600);
      });
  });
};

/** The status pill under the masthead: the pool's state as of the last balance read, hidden until there is one. */
export const initPoolStatus = (): void => {
  const pill = document.getElementById("pool-status");
  if (!pill) return;
  const render = (): void => {
    const wallet = getConnectedWallet();
    let status: ReturnType<typeof poolStatus>;
    try {
      status = freshPoolStatus(wallet ? loadCachedBalance(sessionStorage, wallet) : undefined, new Date());
    } catch {
      status = undefined;
    }
    pill.hidden = status === undefined;
    if (!status) return;
    pill.dataset["live"] = String(status.live);
    const text = pill.querySelector(".pill__text");
    if (text) text.textContent = status.text;
  };
  window.addEventListener("chit-balance-read", render);
  window.addEventListener("chit-wallet-changed", render);
  document.addEventListener("visibilitychange", render);
  globalThis.setInterval(render, 60_000);
  render();
};

/** A glass dialog for a decision that cannot be undone. Resolves true only on the explicit confirm button. */
export const confirmDialog = (copy: { title: string; body: string; confirm: string }): Promise<boolean> =>
  new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    const heading = document.createElement("h2");
    heading.textContent = copy.title;
    heading.id = "confirm-dialog-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const body = document.createElement("p");
    body.textContent = copy.body;
    const actions = document.createElement("div");
    actions.className = "wnav";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "ghost";
    keep.textContent = "Keep it";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "primary";
    confirm.textContent = copy.confirm;
    let answered = false;
    const finish = (yes: boolean): void => {
      if (answered) return;
      answered = true;
      dialog.close();
      dialog.remove();
      resolve(yes);
    };
    keep.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    dialog.addEventListener("close", () => finish(false));
    actions.append(keep, confirm);
    dialog.append(heading, body, actions);
    document.body.append(dialog);
    dialog.showModal();
    keep.focus();
  });

/** Every app page's shared chrome. The Boundary page reads no balance, so it passes `pill: false`. */
export const initShell = ({ pill = true }: { pill?: boolean } = {}): void => {
  initMenu();
  initContractCopy();
  if (pill) initPoolStatus();
  hydrateLed();
  revealOnEnter();
  void loadChainTarget().then(() => {
    showBetaNote();
    // The holders gate, on the beta only (FR-003): checked after the wallet connects, through the quote the service already gives.
    if (chainTarget.beta) {
      initHoldersGate(
        { chainName: chainTarget.chainName, buyChitUrl: chainTarget.buyChitUrl ?? "", testnetUrl: chainTarget.testnetUrl ?? "" },
        async () => {
          const wallet = getConnectedWallet();
          if (!wallet) throw new Error("no wallet");
          return fleetApi("quote", { action: "quote", body: { primaryWallet: wallet } });
        },
      );
      const current = getConnectedWallet();
      if (current) window.dispatchEvent(new CustomEvent("chit-wallet-changed", { detail: { address: current } }));
    }
  });
};
