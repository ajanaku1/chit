/**
 * The brake, with a button on it.
 *
 * The guardian's route to `pause()` was meant to be the explorer's write tab, and
 * that tab cannot sign: neither Robinhood explorer has a wallet connector, so the
 * button is dead however well the contract is verified. What was left was pasting
 * calldata into a wallet from memory, at whatever hour the pause is needed, which
 * is how a guardian fumbles the one thing they are for.
 *
 * So: connect, see what this wallet may do, press it. The page grants nothing —
 * the contract refuses `pause()` from anyone but the guardian, the operator and
 * the admin, and `setPaused` and `setGuardian` from anyone but the admin. Showing
 * a button to a wallet that cannot use it would only teach someone to send a
 * transaction that reverts, so each one says which key it wants and stays
 * disabled until that key is connected.
 */

import { createPublicClient, encodeFunctionData, getAddress, http, isAddress, parseAbi, type Address, type Hex } from "viem";

import {
  ROBINHOOD_TESTNET,
  chainTarget,
  confirmDialog,
  ensureRobinhoodTestnet,
  getConnectedWallet,
  initHeaderWallet,
  initShell,
  loadChainTarget,
  waitForReceipt,
  walletProvider,
  type Eip1193,
} from "./fleet/page-shared.js";

initHeaderWallet();
initShell({ pill: false });

const POOL_ABI = parseAbi([
  "function paused() view returns (bool)",
  "function guardian() view returns (address)",
  "function operator() view returns (address)",
  "function owner() view returns (address)",
  "function pause()",
  "function setPaused(bool paused_)",
  "function setGuardian(address guardian_)",
]);

const el = (id: string): HTMLElement => document.getElementById(id)!;
const ethereum = (): Eip1193 => {
  const provider = walletProvider();
  if (!provider) throw new Error("no wallet");
  return provider;
};

type Roles = { paused: boolean; guardian: Address; operator: Address; owner: Address };
let pool: Address | undefined;
let roles: Roles | undefined;

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

const banner = (message: string, tone: "pending" | "error" | "ok"): void => {
  const note = el("act-note");
  note.textContent = message;
  note.dataset["tone"] = tone;
};

/** The pool this build points at, from the same file every other page reads. */
const poolAddress = async (): Promise<Address | undefined> => {
  try {
    const target = (await (await fetch("./chain-target.json")).json()) as { pool?: string; chainId?: number };
    if (target.chainId !== chainTarget.chainId) return undefined;
    return target.pool && isAddress(target.pool) ? getAddress(target.pool) : undefined;
  } catch {
    return undefined;
  }
};

const client = () => createPublicClient({ transport: http(ROBINHOOD_TESTNET.rpcUrls[0]) });

const read = async (): Promise<void> => {
  if (!pool) {
    el("pool-line").textContent = "this build names no pool, so there is nothing to stop here";
    return;
  }
  const c = client();
  const call = <T,>(functionName: "paused" | "guardian" | "operator" | "owner") =>
    c.readContract({ address: pool!, abi: POOL_ABI, functionName }) as Promise<T>;
  const [paused, guardian, operator, owner] = await Promise.all([
    call<boolean>("paused"), call<Address>("guardian"), call<Address>("operator"), call<Address>("owner"),
  ]);
  roles = { paused, guardian, operator, owner };
  el("pool-line").innerHTML = `<code>${short(pool)}</code> on ${chainTarget.chainName} · <strong>${paused ? "PAUSED" : "running"}</strong>`;
  paint();
};

/**
 * What the connected wallet may do, said before it presses anything. A wallet
 * that is none of the three is told so plainly rather than shown a button that
 * would revert.
 */
const paint = (): void => {
  const wallet = getConnectedWallet();
  const acts = el("acts");
  const adminActs = el("admin-acts");
  if (!wallet || !roles) {
    acts.hidden = true;
    adminActs.hidden = true;
    el("role-line").textContent = "connect the wallet that holds the key";
    return;
  }
  const is = (a: Address): boolean => a.toLowerCase() === wallet.toLowerCase();
  const isGuardian = is(roles.guardian);
  const isOperator = is(roles.operator);
  const isAdmin = is(roles.owner);
  const mayPause = isGuardian || isOperator || isAdmin;

  el("role-line").textContent = isAdmin
    ? "this wallet is the admin: it can pause, and it is the only key that can resume"
    : isGuardian
      ? "this wallet is the guardian: it can pause, and nothing else"
      : isOperator
        ? "this wallet is the operator: it can pause"
        : "this wallet is none of the guardian, the operator or the admin, so the contract would refuse it";

  acts.hidden = false;
  adminActs.hidden = !isAdmin;
  (el("pause") as HTMLButtonElement).disabled = !mayPause || roles.paused;
  (el("resume") as HTMLButtonElement).disabled = !isAdmin || !roles.paused;
  (el("set-guardian") as HTMLButtonElement).disabled = !isAdmin;
  if (roles.paused && mayPause) banner("the pool is already paused; exits still work", "ok");
};

const send = async (label: string, data: Hex): Promise<void> => {
  const wallet = getConnectedWallet();
  if (!wallet || !pool) return;
  const eth = ethereum();
  if (!(await ensureRobinhoodTestnet(eth))) { banner("switch your wallet to this build's chain first", "error"); return; }
  banner(`${label}: confirm in your wallet…`, "pending");
  try {
    const hash = (await eth.request({ method: "eth_sendTransaction", params: [{ from: wallet, to: pool, data }] })) as Hex;
    banner(`${label}: sent, waiting for the receipt… ${short(hash)}`, "pending");
    const ok = await waitForReceipt(hash);
    banner(ok ? `${label}: done in ${short(hash)}` : `${label}: the transaction reverted (${short(hash)})`, ok ? "ok" : "error");
  } catch (error) {
    banner(`${label}: ${(error as { message?: string }).message ?? "refused"}`, "error");
  }
  await read();
};


el("pause").addEventListener("click", () => {
  void (async () => {
    const ok = await confirmDialog({
      title: "Pause the pool?",
      body: "Deposits and draws stop at once. Exits keep working, so anyone leaving can still take their money out. Only the admin can resume.",
      confirm: "Pause it",
    });
    if (!ok) return;
    await send("pause", encodeFunctionData({ abi: POOL_ABI, functionName: "pause" }));
  })();
});

el("resume").addEventListener("click", () => {
  void (async () => {
    const ok = await confirmDialog({
      title: "Resume the pool?",
      body: "Only do this once the resume gate passes and an account of what happened is published. Pausing is cheap and reversible; resuming is neither.",
      confirm: "Resume it",
    });
    if (!ok) return;
    await send("resume", encodeFunctionData({ abi: POOL_ABI, functionName: "setPaused", args: [false] }));
  })();
});

el("set-guardian").addEventListener("click", () => {
  void (async () => {
    const raw = (el("new-guardian") as HTMLInputElement).value.trim();
    if (!isAddress(raw)) { banner("that is not an address", "error"); return; }
    await send("set guardian", encodeFunctionData({ abi: POOL_ABI, functionName: "setGuardian", args: [getAddress(raw)] }));
  })();
});

// page-shared announces a connect, a disconnect and an account switch with this.
window.addEventListener("chit-wallet-changed", () => paint());

void (async () => {
  await loadChainTarget();
  pool = await poolAddress();
  await read();
})();
