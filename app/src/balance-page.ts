/**
 * Balance page: deposit into the pool, withdraw to an address you choose, and
 * the self-serve exit. Deposits go straight from the wallet to the pool
 * contract, so Chit is not in the path of a trader's own money.
 */

import { encodeFunctionData, type Hex } from "viem";

import {
  depositOptions,
  exitView,
  toEth,
  withdrawIssue,
  type BalanceState,
} from "./fleet/balance.js";
import {
  connectWallet,
  ensureRobinhoodTestnet,
  getConnectedWallet,
  initHeaderWallet,
  initTheme,
  parseEth,
} from "./fleet/page-shared.js";
import { RequestFailed, signedFleetApi } from "./fleet/signed-request.js";

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

initTheme();
initHeaderWallet();

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

const ethereum = (): Eip1193 => {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error("wallet_unavailable");
  return eth;
};

const sendToPool = async (data: Hex, value?: bigint): Promise<void> => {
  if (!wallet || !poolAddress) throw new Error("not_connected");
  await ethereum().request({
    method: "eth_sendTransaction",
    params: [{
      from: wallet,
      to: poolAddress,
      data,
      ...(value === undefined ? {} : { value: `0x${value.toString(16)}` }),
    }],
  });
};

const renderFigures = (view: BalanceState): void => {
  el("balance-available").textContent = `${toEth(view.available)} ETH`;
  el("balance-draws").textContent = `${toEth(view.openDraws)} ETH`;
  el("balance-deposited").textContent = `${toEth(view.deposited)} ETH`;
  el("balance-spent").textContent = `${toEth(view.spent)} ETH`;
};

const renderDeposits = (view: BalanceState): void => {
  const host = el("deposit-sizes");
  host.replaceChildren();
  for (const option of depositOptions(view)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.disabled = option.disabled;
    if (option.reason) button.title = option.reason;
    button.addEventListener("click", () => void deposit(option.size));
    host.appendChild(button);
  }
  const blocked = depositOptions(view).find((option) => option.disabled);
  el("deposit-note").textContent = blocked?.reason ?? "";
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

const refresh = async (): Promise<void> => {
  if (!wallet) return;
  const body = await signedFleetApi(wallet, "balance", {});
  state = body as unknown as BalanceState;
  poolAddress = (body["poolAddress"] as Hex | undefined) ?? poolAddress;
  renderFigures(state);
  renderDeposits(state);
  renderExit(state);
};

const deposit = async (size: string): Promise<void> => {
  try {
    await sendToPool(encodeFunctionData({ abi: POOL_ABI, functionName: "deposit" }), BigInt(size));
    banner("Deposit sent. Your balance updates once it confirms.", "pending");
  } catch (error) {
    banner(describe(error), "error");
  }
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

const connect = async (): Promise<void> => {
  const address = (await connectWallet()) ?? getConnectedWallet();
  if (!address) {
    banner("Connect your wallet to see your balance.", "pending");
    return;
  }
  wallet = address;
  await ensureRobinhoodTestnet(ethereum());
  await refresh();
};

el("withdraw-form").addEventListener("submit", (event) => void withdraw(event));
el("exit-request").addEventListener("click", () => {
  void sendToPool(encodeFunctionData({ abi: POOL_ABI, functionName: "requestExit" }))
    .then(() => banner("Exit requested. You can claim your ETH in 24 hours.", "pending"))
    .catch((error: unknown) => banner(describe(error), "error"));
});
el("exit-execute").addEventListener("click", () => {
  void sendToPool(encodeFunctionData({ abi: POOL_ABI, functionName: "executeExit" }))
    .then(() => banner("Claimed.", "ok"))
    .catch((error: unknown) => banner(describe(error), "error"));
});
el("hdr-wallet").addEventListener("click", () => void connect());

if (getConnectedWallet()) void connect();
