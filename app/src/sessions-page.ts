/**
 * Sessions page: a session account of your own, funded from your wallet, and
 * the keys you hand out with their rules. Everything here is a transaction
 * from the connected wallet straight to the contracts, and every figure is
 * read from the chain; there is no Chit service in this page at all.
 *
 * The keys you granted are remembered in this browser (localStorage, by
 * account) so the list can be rebuilt; the chain is the truth for each one.
 */

import { createPublicClient, http, isAddress, type Hex } from "viem";

import {
  ANY_FUNCTION,
  DEFAULT_SALT,
  SESSION_ACCOUNT_ABI,
  SESSION_FACTORY_ABI,
  decodeSessionView,
  encodeCreateAccount,
  encodeGrant,
  encodePause,
  encodeResume,
  encodeRevoke,
  encodeWithdraw,
  sessionState,
  type SessionView,
} from "../../src/fleet/session-keys.js";
import {
  ROBINHOOD_TESTNET,
  confirmDialog,
  ensureRobinhoodTestnet,
  getConnectedWallet,
  initHeaderWallet,
  initShell,
  parseEth,
  toEth,
  waitForReceipt,
  walletProvider,
  type Eip1193,
} from "./fleet/page-shared.js";

initHeaderWallet();
initShell({ pill: false });

/** Robinhood Chain testnet's Universal Router; the default target, since trading is what most bots do. */
const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const UNIVERSAL_ROUTER_EXECUTE = "0x3593564c";

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node;
};
const input = (id: string): HTMLInputElement => el(id) as HTMLInputElement;
const button = (id: string): HTMLButtonElement => el(id) as HTMLButtonElement;

const banner = (message: string, tone: "pending" | "error" | "ok"): void => {
  const node = el("status-banner");
  node.textContent = message;
  node.dataset["tone"] = tone;
  node.hidden = false;
};

const publicClient = createPublicClient({ transport: http(ROBINHOOD_TESTNET.rpcUrls[0]) });

type Target = { chainId: number; sessionFactory?: string };
let factory: Hex | undefined;
let wallet: Hex | undefined;
let account: Hex | undefined;
let deployed = false;

const keysStorage = (acct: Hex) => `chit-sessions:${acct.toLowerCase()}`;
const rememberedKeys = (acct: Hex): Hex[] => {
  try {
    const raw = localStorage.getItem(keysStorage(acct));
    return raw ? (JSON.parse(raw) as Hex[]) : [];
  } catch {
    return [];
  }
};
const rememberKey = (acct: Hex, key: Hex): void => {
  const keys = rememberedKeys(acct);
  if (!keys.some((k) => k.toLowerCase() === key.toLowerCase())) {
    keys.push(key);
    try { localStorage.setItem(keysStorage(acct), JSON.stringify(keys)); } catch { /* the chain remembers */ }
  }
};

const ethereum = (): Eip1193 => {
  const eth = walletProvider();
  if (!eth) throw new Error("wallet_unavailable");
  return eth;
};

/** One transaction from the wallet, with the receipt awaited and the banner kept honest. */
const transact = async (label: string, to: Hex, data: Hex, value?: bigint): Promise<boolean> => {
  if (!wallet) { banner("Connect your wallet first.", "error"); return false; }
  const eth = ethereum();
  if (!(await ensureRobinhoodTestnet(eth))) { banner("Switch your wallet to Robinhood testnet first.", "error"); return false; }
  banner(`${label}: confirm in your wallet…`, "pending");
  let hash: Hex;
  try {
    hash = (await eth.request({
      method: "eth_sendTransaction",
      params: [{ from: wallet, to, data, ...(value === undefined ? {} : { value: `0x${value.toString(16)}` }) }],
    })) as Hex;
  } catch (error) {
    banner(`${label}: ${(error as { message?: string }).message?.split("\n")[0] ?? "the wallet refused"}`, "error");
    return false;
  }
  banner(`${label}: sent, waiting for the chain…`, "pending");
  const receipt = await waitForReceipt(hash);
  if (!receipt) { banner(`${label}: still pending after a minute. Refresh in a moment.`, "pending"); return false; }
  if (receipt.status !== "0x1") { banner(`${label}: reverted on chain.`, "error"); return false; }
  banner(`${label}: done.`, "ok");
  return true;
};

// ---- reading ----

const loadTarget = async (): Promise<void> => {
  try {
    const target = (await (await fetch("./session-target.json")).json()) as Target;
    factory = target.sessionFactory && isAddress(target.sessionFactory) ? (target.sessionFactory as Hex) : undefined;
  } catch {
    factory = undefined;
  }
};

const refreshAccount = async (): Promise<void> => {
  wallet = getConnectedWallet();
  if (!wallet) {
    el("account-note").textContent = "Connect your wallet to see your account.";
    for (const id of ["account-create", "fund-submit", "withdraw-submit", "grant-submit"]) button(id).disabled = true;
    return;
  }
  if (!factory) {
    el("account-note").textContent = "The session account factory is not deployed on this network yet.";
    el("account-state").textContent = "not available";
    return;
  }
  account = await publicClient.readContract({ address: factory, abi: SESSION_FACTORY_ABI, functionName: "accountOf", args: [wallet, DEFAULT_SALT] });
  const code = await publicClient.getCode({ address: account });
  deployed = !!code && code !== "0x";
  el("account-address").textContent = account;
  const eth = await publicClient.getBalance({ address: account });
  el("account-eth").textContent = `${toEth(eth.toString())} ETH`;
  el("account-state").textContent = deployed ? "ready" : "not created yet";
  el("account-note").textContent = deployed
    ? "Your account. Only you can fund it, grant sessions on it, and take from it."
    : "Your account's address is known before it exists. Create it once; the address never changes.";
  button("account-create").disabled = deployed;
  button("fund-submit").disabled = !deployed;
  button("withdraw-submit").disabled = !deployed;
  button("grant-submit").disabled = !deployed;
  input("grant-target").value ||= UNIVERSAL_ROUTER;
  input("grant-selector").value ||= UNIVERSAL_ROUTER_EXECUTE;
  await renderSessions();
};

const readSession = async (key: Hex): Promise<SessionView> =>
  decodeSessionView((await publicClient.readContract({ address: account!, abi: SESSION_ACCOUNT_ABI, functionName: "sessionOf", args: [key] })) as never);

const renderSessions = async (): Promise<void> => {
  const list = el("session-list");
  list.replaceChildren();
  if (!account || !deployed) { el("list-empty").hidden = false; return; }
  const keys = rememberedKeys(account);
  const now = Math.floor(Date.now() / 1000);
  const rows = await Promise.all(keys.map(async (key) => ({ key, view: await readSession(key) })));
  const known = rows.filter((r) => r.view.exists);
  el("list-empty").hidden = known.length > 0;
  for (const { key, view } of known) {
    const state = sessionState(view, now);
    const rules = (await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "rulesOf", args: [key] })) as ReadonlyArray<{ target: Hex; selector: Hex }>;
    const card = document.createElement("article");
    card.className = "dash-card";
    card.dataset["state"] = state;
    const spent = `${toEth(view.spentValue)} of ${toEth(view.totalValueCap)} ETH spent · ${view.calls} call${view.calls === 1 ? "" : "s"} · up to ${toEth(view.maxValuePerCall)} ETH a call`;
    const until = new Date(view.expiry * 1000).toUTCString().replace(" GMT", " UTC");
    card.innerHTML = `
      <p class="cardlabel">Key <code>${key}</code></p>
      <p class="state-chip" data-state="${state}">${state}</p>
      <p class="lead small">${spent}</p>
      <p class="fineprint">${rules.map((r) => `${r.target}${r.selector === ANY_FUNCTION ? " · any function" : ` · ${r.selector}`}`).join("<br>")}</p>
      <p class="fineprint">until ${until}</p>
      <div class="wnav">
        <button type="button" class="ghost" data-act="pause" ${state === "active" ? "" : "disabled"}>Pause</button>
        <button type="button" class="ghost" data-act="resume" ${state === "paused" ? "" : "disabled"}>Resume</button>
        <button type="button" class="primary" data-act="revoke" ${state === "revoked" ? "disabled" : ""}>Revoke</button>
      </div>`;
    card.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) => {
      b.addEventListener("click", () => void act(b.dataset["act"] as "pause" | "resume" | "revoke", key));
    });
    list.append(card);
  }
};

// ---- acting ----

const act = async (what: "pause" | "resume" | "revoke", key: Hex): Promise<void> => {
  if (!account) return;
  if (what === "revoke" && !(await confirmDialog({
    title: "Revoke this key for good?",
    body: "The key stops now and can never be granted again. To let the same bot back in, grant it a new key.",
    confirm: "Revoke",
  }))) return;
  const data = what === "pause" ? encodePause(key) : what === "resume" ? encodeResume(key) : encodeRevoke(key);
  if (await transact(what === "pause" ? "Pause" : what === "resume" ? "Resume" : "Revoke", account, data)) await renderSessions();
};

button("account-create").addEventListener("click", () => {
  if (!wallet || !factory) return;
  void transact("Create account", factory, encodeCreateAccount(wallet)).then((ok) => { if (ok) void refreshAccount(); });
});

el("fund-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!account) return;
  let wei: bigint;
  try { wei = BigInt(parseEth(input("fund-amount").value)); } catch { el("fund-note").textContent = "Enter an amount like 0.01."; return; }
  if (wei === 0n) { el("fund-note").textContent = "Enter an amount above zero."; return; }
  void transact("Fund", account, "0x", wei).then((ok) => { if (ok) void refreshAccount(); });
});

el("withdraw-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!account || !wallet) return;
  let wei: bigint;
  try { wei = BigInt(parseEth(input("withdraw-amount").value)); } catch { el("withdraw-note").textContent = "Enter an amount like 0.01."; return; }
  void transact("Withdraw", account, encodeWithdraw(wallet, wei)).then((ok) => { if (ok) void refreshAccount(); });
});

el("grant-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!account) return;
  const note = el("grant-note");
  const key = input("grant-key").value.trim();
  const target = input("grant-target").value.trim();
  const selectorRaw = input("grant-selector").value.trim();
  if (!isAddress(key)) { note.textContent = "The bot's key has to be an address."; return; }
  if (wallet && key.toLowerCase() === wallet.toLowerCase()) { note.textContent = "Not your own wallet: the point is a different key."; return; }
  if (!isAddress(target)) { note.textContent = "The contract has to be an address."; return; }
  const selector = selectorRaw === "" ? ANY_FUNCTION : selectorRaw.toLowerCase();
  if (!/^0x[0-9a-f]{8}$/.test(selector)) { note.textContent = "A selector is 0x plus eight hex characters, or blank for any."; return; }
  let perCall: bigint, cap: bigint;
  try { perCall = BigInt(parseEth(input("grant-per-call").value)); cap = BigInt(parseEth(input("grant-cap").value)); } catch { note.textContent = "Amounts like 0.001."; return; }
  if (perCall > cap) { note.textContent = "Per call cannot be above the total."; return; }
  const hours = Number(input("grant-hours").value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) { note.textContent = "Hours between 1 and 8760."; return; }
  const expiry = Math.floor(Date.now() / 1000) + Math.floor(hours * 3600);
  note.textContent = "";
  const data = encodeGrant(key as Hex, [{ target: target as Hex, selector: selector as Hex }], perCall, cap, expiry);
  void transact("Grant", account, data).then((ok) => {
    if (!ok || !account) return;
    rememberKey(account, key as Hex);
    void renderSessions();
  });
});

el("account-refresh").addEventListener("click", () => {
  const typed = input("grant-key").value.trim();
  if (account && isAddress(typed)) rememberKey(account, typed as Hex);
  void refreshAccount();
});
window.addEventListener("chit-wallet-changed", () => void refreshAccount());

void loadTarget().then(() => refreshAccount());
