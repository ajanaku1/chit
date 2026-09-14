/**
 * Balance page: deposit into the pool, withdraw to an address you choose, and
 * the self-serve exit. Deposits go straight from the wallet to the pool
 * contract, so Chit is not in the path of a trader's own money.
 */

import { encodeFunctionData, type Hex } from "viem";

import {
  balanceDelta,
  canAddFunds,
  capShare,
  depositOptions,
  exitView,
  loadCachedBalance,
  receiptOutcome,
  toEth,
  TRADER_CAP,
  withdrawIssue,
  type BalanceState,
} from "./fleet/balance.js";
import { invalidateBalance, readBalance } from "./fleet/balance-read.js";
import { renderLed } from "./fleet/led.js";
import { countTo } from "./fleet/motion.js";
import {
  ensureRobinhoodTestnet,
  getConnectedWallet,
  initHeaderWallet,
  initShell,
  parseEth,
  waitForReceipt,
  walletEth,
  walletProvider,
  type Eip1193,
} from "./fleet/page-shared.js";
import { RequestFailed, signedFleetApi } from "./fleet/signed-request.js";

initHeaderWallet();
initShell();

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node;
};

const banner = (message: string, tone: "pending" | "error" | "ok"): void => {
  const node = el("status-banner");
  node.textContent = message;
  node.dataset["tone"] = tone;
  node.hidden = false;
};

const POOL_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "requestExit", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "executeExit", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

let wallet: Hex | undefined;
let state: BalanceState | undefined;
/** The pool address the service reports, so the page never hardcodes it. */
let poolAddress: Hex | undefined;
/** The size the trader has picked, committed only when Add funds is pressed. */
let selectedSize: string | undefined;

const ethereum = (): Eip1193 => {
  const eth = walletProvider();
  if (!eth) throw new Error("wallet_unavailable");
  return eth;
};

const sendToPool = async (data: Hex, value?: bigint): Promise<Hex> => {
  if (!wallet) throw new Error("Connect your wallet first.");
  if (!poolAddress) throw new Error("The pool is not configured yet.");
  const eth = ethereum();
  // The pool exists only on 46630. A wallet moved to another network since it
  // connected would send this there, to an address with no pool behind it.
  if (!(await ensureRobinhoodTestnet(eth))) throw new Error("Switch your wallet to Robinhood testnet first.");
  return (await eth.request({
    method: "eth_sendTransaction",
    params: [{
      from: wallet,
      to: poolAddress,
      data,
      ...(value === undefined ? {} : { value: `0x${value.toString(16)}` }),
    }],
  })) as Hex;
};

let shownAvailable: string | undefined;

const renderFigures = (view: BalanceState): void => {
  const host = el("balance-available");
  const to = Number(toEth(view.available));
  const from = shownAvailable === undefined ? to : Number(toEth(shownAvailable));
  countTo((value) => renderLed(host, value.toFixed(4), "ETH"), from, to);
  const delta = balanceDelta(shownAvailable, view.available);
  const deltaNode = el("balance-delta");
  deltaNode.hidden = delta === undefined;
  if (delta) {
    deltaNode.textContent = `${delta.up ? "▲" : "▼"} ${delta.eth}`;
    deltaNode.dataset["up"] = String(delta.up);
  }
  shownAvailable = view.available;

  const used = capShare(view.headroom.perTraderRemaining, TRADER_CAP);
  el("headroom-fill").style.setProperty("--fill", String(used));
  el("headroom-meter").setAttribute("aria-valuenow", String(used));
  el("headroom-note").textContent = `${toEth((BigInt(TRADER_CAP) - BigInt(view.headroom.perTraderRemaining)).toString())} of 0.5 ETH held`;

  el("balance-draws").textContent = `${toEth(view.openDraws)} ETH`;
  el("balance-deposited").textContent = `${toEth(view.deposited)} ETH`;
  el("balance-spent").textContent = `${toEth(view.spent)} ETH`;
};

const renderDeposits = (view: BalanceState): void => {
  const host = el("deposit-sizes");
  const options = depositOptions(view);
  if (selectedSize && !canAddFunds(view, selectedSize)) selectedSize = undefined;

  host.replaceChildren();
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.disabled = option.disabled;
    button.setAttribute("aria-pressed", String(selectedSize === option.size));
    if (option.reason) button.title = option.reason;
    // Picking a size commits to nothing; Add funds is the decision.
    button.addEventListener("click", () => {
      selectedSize = option.size;
      renderDeposits(view);
    });
    host.appendChild(button);
  }

  (el("deposit-submit") as HTMLButtonElement).disabled = !canAddFunds(view, selectedSize);
  const blocked = options.find((option) => option.disabled);
  el("deposit-note").textContent = selectedSize
    ? `Adding ${toEth(selectedSize)} ETH to your Chit balance.`
    : (blocked?.reason ?? "Pick an amount to add.");
};

const renderExit = (view: BalanceState): void => {
  const exit = exitView(view, new Date());
  const execute = el("exit-execute") as HTMLButtonElement;
  const request = el("exit-request") as HTMLButtonElement;
  execute.disabled = exit.status !== "available";
  request.disabled = exit.status !== "none";
  el("exit-status").textContent =
    exit.status === "none"
      ? "No exit requested."
      : exit.status === "waiting"
        ? `Requested. You can claim ${toEth(exit.amount ?? "0")} ETH after ${exit.availableAt}.`
        : `Ready: claim ${toEth(exit.amount ?? "0")} ETH now.`;
};

const render = (view: BalanceState): void => {
  renderFigures(view);
  renderDeposits(view);
  renderExit(view);
};

/** The wallet's own ETH: the number a trader expects to see first. */
const renderWalletEth = async (): Promise<void> => {
  if (!wallet) return;
  try {
    el("wallet-eth").textContent = `${toEth(await walletEth(wallet))} ETH`;
  } catch {
    el("wallet-eth").textContent = "—";
  }
};

const load = async (force: boolean): Promise<void> => {
  if (!wallet) return;
  void renderWalletEth();
  el("balance").setAttribute("aria-busy", "true");
  try {
    state = await readBalance(wallet, { force });
  } finally {
    el("balance").removeAttribute("aria-busy");
  }
  poolAddress = (state.poolAddress as Hex | undefined) ?? poolAddress;
  render(state);
};

const refresh = (): Promise<void> => load(false);

/** Re-reads until the balance moves, so a confirmed deposit is never invisible. */
const settle = async (was: string, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 3_000));
    try {
      await forceRefresh();
      if (state && state.deposited !== was) {
        banner(`${what} confirmed.`, "ok");
        return;
      }
    } catch {
      // Keep waiting; the chain is the slow part, not the service.
    }
  }
  banner(`${what} sent. It has not confirmed yet; reload in a moment.`, "pending");
};

/** Sends to the pool and reports only what the chain confirms. */
const transact = async (what: string, data: Hex, value?: bigint): Promise<boolean> => {
  try {
    const hash = await sendToPool(data, value);
    banner(`${what} sent (${hash.slice(0, 10)}…). Waiting for the chain.`, "pending");
    const outcome = receiptOutcome(await waitForReceipt(hash));
    banner(`${what}: ${outcome.message}`, outcome.ok ? "ok" : "error");
    return outcome.ok;
  } catch (error) {
    banner(describe(error), "error");
    return false;
  }
};

const deposit = async (size: string): Promise<void> => {
  const was = state?.deposited ?? "0";
  if (wallet) invalidateBalance(wallet);
  const ok = await transact("Deposit", encodeFunctionData({ abi: POOL_ABI, functionName: "deposit" }), BigInt(size));
  if (ok) await settle(was, "Deposit");
};

const withdraw = async (event: Event): Promise<void> => {
  event.preventDefault();
  if (!wallet || !state) return;
  const amount = parseEth((el("withdraw-amount") as HTMLInputElement).value);
  const destination = (el("withdraw-destination") as HTMLInputElement).value.trim();

  const blocking = withdrawIssue(state, amount, destination, wallet, { blocking: true });
  if (blocking) {
    el("withdraw-note").textContent = blocking;
    return;
  }
  el("withdraw-note").textContent = withdrawIssue(state, amount, destination, wallet) ?? "";

  try {
    const result = await signedFleetApi(wallet, "withdraw", { amount, destination });
    invalidateBalance(wallet);
    banner(`Paid. Transaction ${String(result["payoutTx"]).slice(0, 10)}…`, "ok");
    await refresh();
  } catch (error) {
    banner(describe(error), "error");
  }
};

const describe = (error: unknown): string => {
  if (error instanceof RequestFailed) {
    const messages: Record<string, string> = {
      budget_exceeded: "That is more than your balance.",
      state_invalid: "The pool is paused right now.",
      dependency_evidence_invalid: "The pool is not configured yet.",
      challenge_invalid: "Your wallet signature did not match. Try again.",
    };
    return messages[error.code] ?? `Request failed (${error.code}).`;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
};

/**
 * Follows the wallet the shared header owns. Binding our own click to that
 * button would fire a second `eth_requestAccounts` alongside the header's, and
 * wallets refuse a concurrent request, so connecting would appear to fail.
 */
const onWalletChanged = async (): Promise<void> => {
  const address = getConnectedWallet();
  if (!address) {
    wallet = undefined;
    banner("Connect your wallet to see your balance.", "pending");
    return;
  }
  wallet = address;
  // Last known figures first, so nothing blanks while the fresh read waits on
  // a signature; then the live read replaces them.
  const cached = loadCachedBalance(sessionStorage, address);
  if (cached) {
    state = cached;
    poolAddress = (cached.poolAddress as Hex | undefined) ?? poolAddress;
    render(cached);
  }
  try {
    await refresh();
  } catch (error) {
    banner(describe(error), "error");
  }
};

/** A signed read on demand, whatever the cache says. */
const forceRefresh = async (): Promise<void> => {
  try {
    await load(true);
  } catch (error) {
    banner(describe(error), "error");
  }
};

window.addEventListener("chit-wallet-changed", () => void onWalletChanged());
el("balance-refresh").addEventListener("click", () => void forceRefresh());
el("deposit-submit").addEventListener("click", () => {
  if (selectedSize) void deposit(selectedSize);
});

el("withdraw-form").addEventListener("submit", (event) => void withdraw(event));
el("exit-request").addEventListener("click", () => {
  if (state && BigInt(state.deposited) === 0n) {
    banner("Nothing to exit: you have not deposited anything.", "pending");
    return;
  }
  void transact("Exit request", encodeFunctionData({ abi: POOL_ABI, functionName: "requestExit" })).then((ok) => {
    if (ok) void refresh();
  });
});
el("exit-execute").addEventListener("click", () => {
  void transact("Claim", encodeFunctionData({ abi: POOL_ABI, functionName: "executeExit" })).then((ok) => {
    if (ok) void refresh();
  });
});
if (getConnectedWallet()) void onWalletChanged();
else banner("Connect your wallet to see your balance.", "pending");
