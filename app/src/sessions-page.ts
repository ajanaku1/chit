/**
 * Sessions page: a session account of your own, funded from your wallet, and
 * the keys you hand out with their rules. Everything here is a transaction
 * from the connected wallet straight to the contracts, and every figure is
 * read from the chain; there is no Chit service in this page at all.
 *
 * The keys you granted are remembered in this browser (localStorage, by
 * account) so the list can be rebuilt; the chain is the truth for each one.
 */

import { createPublicClient, formatUnits, getAddress, http, isAddress, parseAbi, parseAbiItem, parseUnits, type Hex } from "viem";

import {
  ANY_FUNCTION,
  accountSalt,
  SESSION_ACCOUNT_ABI,
  SESSION_FACTORY_ABI,
  decodeSessionView,
  encodeCreateAccount,
  encodeGrant,
  encodePause,
  encodeResume,
  encodeRevoke,
  encodeSetSellAllowed,
  encodeWithdraw,
  encodeWithdrawToken,
  sessionState,
  type SessionView,
} from "../../src/fleet/session-keys.js";
import {
  ROBINHOOD_TESTNET,
  chainTarget,
  loadChainTarget,
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
/** Which of the wallet's accounts the page shows, and how many exist; the one after the last is a new one not yet created. */
let index = 0;
let count = 0;
const pickStorage = (w: Hex): string => `chit-session-account:${w.toLowerCase()}`;
const storedPick = (w: Hex): number | undefined => {
  try { const v = Number(localStorage.getItem(pickStorage(w))); return Number.isInteger(v) && v >= 0 ? v : undefined; } catch { return undefined; }
};
const storePick = (w: Hex, n: number): void => { try { localStorage.setItem(pickStorage(w), String(n)); } catch { /* a convenience only */ } };

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
  // The chain first: the session target is only this host's if it names the same chain.
  await loadChainTarget();
  try {
    const target = (await (await fetch("./session-target.json")).json()) as Target;
    // A factory answers only on the chain it was deployed on: a target naming
    // another chain is not this host's, and using it would put a testnet
    // address in front of a trader on mainnet (T081).
    const ours = target.chainId === chainTarget.chainId;
    if (!ours) console.warn(`session target names chain ${target.chainId}, this host is ${chainTarget.chainId}; ignored`);
    factory = ours && target.sessionFactory && isAddress(target.sessionFactory) ? (target.sessionFactory as Hex) : undefined;
  } catch {
    factory = undefined;
  }
};

const refreshAccount = async (): Promise<void> => {
  wallet = getConnectedWallet();
  if (!wallet) {
    el("account-note").textContent = "Connect your wallet to see your account.";
    for (const id of ["account-create", "fund-submit", "withdraw-submit", "wtoken-submit", "grant-submit"]) button(id).disabled = true;
    return;
  }
  if (!factory) {
    el("account-note").textContent = "The session account factory is not deployed on this network yet.";
    el("account-state").textContent = "not available";
    return;
  }
  // Every account the wallet has made, in order: the contract never grants a key twice on one, so a new one is how a
  // spent bot key is let back in. The first is at the address accounts always had (accountSalt(0) is the old salt).
  const addressOf = (n: number) => publicClient.readContract({ address: factory!, abi: SESSION_FACTORY_ABI, functionName: "accountOf", args: [wallet!, accountSalt(n)] });
  const exists = async (a: Hex) => { const c = await publicClient.getCode({ address: a }); return !!c && c !== "0x"; };
  const made: Hex[] = [];
  for (let n = 0; n < 20; n++) { const a = await addressOf(n); if (!(await exists(a))) break; made.push(a); }
  count = made.length;
  const stored = storedPick(wallet);
  index = stored !== undefined && stored <= count ? stored : Math.max(count - 1, 0);
  account = made[index] ?? (await addressOf(index));
  deployed = index < count;
  const pick = el("account-pick") as HTMLSelectElement;
  pick.replaceChildren(...made.map((a, n) => new Option(`Account ${n + 1} · ${a.slice(0, 6)}…${a.slice(-4)}`, String(n), false, n === index)));
  if (!deployed) pick.append(new Option(`Account ${index + 1} · new, not created yet`, String(index), false, true));
  pick.hidden = made.length === 0 && index === 0;
  button("account-new").disabled = !deployed;
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
  button("wtoken-submit").disabled = !deployed;
  button("grant-submit").disabled = !deployed;
  input("grant-target").value ||= UNIVERSAL_ROUTER;
  input("grant-selector").value ||= UNIVERSAL_ROUTER_EXECUTE;
  await renderSessions();
  void renderTokens();
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
    // An account deployed before the flag existed has no `sellAllowed` (nor `setSellAllowed`): the read reverts, and with it,
    // unguarded, the whole list and its Pause, Resume and Revoke would go. Such an account has no sell to allow; the box says so.
    const sells = await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "sellAllowed", args: [key] }).then((v) => v as boolean, () => undefined);
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
      ${state === "revoked" || state === "expired" ? `<p class="fineprint">This key can't be granted on this account again: the contract never grants a key twice. Start a new account to let it back in.</p>` : ""}
      <label class="fineprint sell-toggle"><input type="checkbox" data-act="sell" ${sells ? "checked" : ""} ${state === "revoked" || sells === undefined ? "disabled" : ""} /> ${sells === undefined
        ? "let it sell: not on this account. it was created before the flag existed, so no key can sell from it; a key here does only what its rules name."
        : "let it sell: the key may sell tokens the account holds, through its router, with the ETH landing here and nothing approved afterwards; the pool and the floor are the key's, so this trusts it with the position, not only the caps"}</label>
      <div class="wnav">
        <button type="button" class="ghost" data-act="pause" ${state === "active" ? "" : "disabled"}>Pause</button>
        <button type="button" class="ghost" data-act="resume" ${state === "paused" ? "" : "disabled"}>Resume</button>
        <button type="button" class="primary" data-act="revoke" ${state === "revoked" ? "disabled" : ""}>Revoke</button>
      </div>`;
    card.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) => {
      b.addEventListener("click", () => void act(b.dataset["act"] as "pause" | "resume" | "revoke", key));
    });
    card.querySelector<HTMLInputElement>("input[data-act=sell]")?.addEventListener("change", (event) => {
      void setSell(key, (event.target as HTMLInputElement).checked);
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

/** The sell flag, from the wallet; the list is re-read from the chain either way so the box shows what the contract says. */
const setSell = async (key: Hex, allowed: boolean): Promise<void> => {
  if (!account) return;
  await transact(allowed ? "Let it sell" : "Stop selling", account, encodeSetSellAllowed(key, allowed));
  await renderSessions();
};

(el("account-pick") as HTMLSelectElement).addEventListener("change", (event) => {
  if (!wallet) return;
  storePick(wallet, Number((event.target as HTMLSelectElement).value));
  void refreshAccount();
});
button("account-new").addEventListener("click", () => {
  if (!wallet) return;
  storePick(wallet, count);
  void refreshAccount();
});

button("account-create").addEventListener("click", () => {
  if (!wallet || !factory) return;
  void transact("Create account", factory, encodeCreateAccount(wallet, accountSalt(index))).then((ok) => { if (ok) void refreshAccount(); });
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

// ---- a token back to the wallet ----
// Tokens the bot bought sit in the account; the owner takes them out with withdrawToken, the one way out that needs no key.
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const tokenHeld = async (token: Hex): Promise<{ units: bigint; decimals: number; symbol: string }> => {
  const [units, decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [account!] }),
    publicClient.readContract({ address: token, abi: ERC20, functionName: "decimals" }),
    publicClient.readContract({ address: token, abi: ERC20, functionName: "symbol" }).catch(() => "tokens"),
  ]);
  return { units, decimals, symbol };
};
/**
 * Every token the chain shows reaching the account (Transfer logs to it, the whole chain in pieces the public RPC
 * takes) that it still holds, so the owner withdraws without looking up an address. The contract moves one token a
 * call, so "all" is one withdrawToken per token, sent in a row.
 */
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
let held: { token: Hex; units: bigint; decimals: number; symbol: string }[] = [];
/**
 * The public mainnet RPC answers a Transfer search without a token filter for 30 000 blocks at most (about an hour
 * here, at ten blocks a second), so the search starts at the account's creation, found from the factory's own event
 * (which can be filtered, 10 000 000 blocks a query), and this browser remembers how far it got and what it found, so a
 * later visit reads only the blocks since. Cleared, it simply reads again from the creation.
 */
const SPAN = 30_000n;
const ACCOUNT_CREATED = parseAbiItem("event AccountCreated(address indexed owner, address indexed account, bytes32 salt)");
const scanStorage = (acct: Hex) => `chit-tokens:${acct.toLowerCase()}`;
const createdAt = async (acct: Hex, head: bigint): Promise<bigint> => {
  for (let to = head; to >= 0n; to -= 10_000_000n) {
    const from = to >= 9_999_999n ? to - 9_999_999n : 0n;
    const [made] = await publicClient.getLogs({ address: factory!, event: ACCOUNT_CREATED, args: { account: acct }, fromBlock: from, toBlock: to });
    if (made) return made.blockNumber;
  }
  return 0n;
};
const tokensIn = async (acct: Hex, progress: (done: number, of: number) => void): Promise<Hex[]> => {
  const head = await publicClient.getBlockNumber();
  let saved: { to: string; tokens: string[] } | undefined;
  try { saved = JSON.parse(localStorage.getItem(scanStorage(acct)) ?? "null") ?? undefined; } catch { saved = undefined; }
  const seen = new Set<string>(saved?.tokens ?? []);
  const start = saved ? BigInt(saved.to) + 1n : await createdAt(acct, head);
  const pieces: [bigint, bigint][] = [];
  for (let from = start; from <= head; from += SPAN) pieces.push([from, from + SPAN - 1n < head ? from + SPAN - 1n : head]);
  let done = 0;
  // A few at a time: the public RPC turns a burst away.
  for (let i = 0; i < pieces.length; i += 4) {
    await Promise.all(pieces.slice(i, i + 4).map(async ([from, to]) => {
      for (const l of await publicClient.getLogs({ event: TRANSFER, args: { to: acct }, fromBlock: from, toBlock: to })) seen.add(l.address.toLowerCase());
      progress(++done, pieces.length);
    }));
  }
  try { localStorage.setItem(scanStorage(acct), JSON.stringify({ to: head.toString(), tokens: [...seen] })); } catch { /* read again next time */ }
  return [...seen] as Hex[];
};
const renderTokens = async (): Promise<void> => {
  const list = el("wtoken-list");
  held = [];
  button("wtoken-all").disabled = true;
  if (!account || !deployed) { list.textContent = ""; return; }
  list.textContent = "Looking for tokens in this account…";
  try {
    const found = await Promise.all((await tokensIn(account, (done, of) => { if (of > 4) list.textContent = `Reading this account's history… ${Math.round((done / of) * 100)}%`; })).map(async (token) => ({ token, ...(await tokenHeld(token).catch(() => ({ units: 0n, decimals: 18, symbol: "" }))) })));
    held = found.filter((t) => t.units > 0n);
  } catch { list.textContent = "Could not read the account's tokens right now. Refresh, or use a token's address below."; return; }
  list.replaceChildren();
  if (held.length === 0) { list.textContent = "No tokens in this account."; return; }
  for (const t of held) {
    const row = document.createElement("p");
    row.textContent = `${formatUnits(t.units, t.decimals)} ${t.symbol} `;
    const one = document.createElement("button");
    one.type = "button"; one.className = "ghost"; one.textContent = "Withdraw";
    one.addEventListener("click", () => { if (account && wallet) void transact(`Withdraw ${t.symbol}`, account, encodeWithdrawToken(t.token, wallet, t.units)).then((ok) => { if (ok) void renderTokens(); }); });
    row.append(one);
    list.append(row);
  }
  button("wtoken-all").disabled = false;
};
button("wtoken-all").addEventListener("click", () => {
  if (!account || !wallet || held.length === 0) return;
  const owner = wallet, from = account;
  void (async () => {
    for (const [n, t] of held.entries()) {
      el("wtoken-list").textContent = `${n + 1} of ${held.length}: withdrawing ${t.symbol}…`;
      if (!(await transact(`Withdraw ${t.symbol} (${n + 1} of ${held.length})`, from, encodeWithdrawToken(t.token, owner, t.units)))) break;
    }
    void renderTokens();
  })();
});

input("wtoken-address").addEventListener("change", () => {
  const token = input("wtoken-address").value.trim();
  const note = el("wtoken-note");
  if (!account || !deployed || !isAddress(token)) return;
  void tokenHeld(token as Hex).then(
    (h) => { note.textContent = `This account holds ${formatUnits(h.units, h.decimals)} ${h.symbol}.`; },
    () => { note.textContent = "That address does not answer as a token on this network."; },
  );
});
el("wtoken-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const note = el("wtoken-note");
  const token = input("wtoken-address").value.trim();
  if (!account || !wallet) return;
  if (!isAddress(token)) { note.textContent = "The token has to be an address."; return; }
  const owner = wallet, from = account;
  void (async () => {
    let h: Awaited<ReturnType<typeof tokenHeld>>;
    try { h = await tokenHeld(token as Hex); } catch { note.textContent = "That address does not answer as a token on this network."; return; }
    const typed = input("wtoken-amount").value.trim();
    let units: bigint;
    try { units = typed === "" ? h.units : parseUnits(typed, h.decimals); } catch { note.textContent = "Enter an amount like 100, or leave it blank for all."; return; }
    if (units <= 0n) { note.textContent = `This account holds no ${h.symbol}.`; return; }
    if (units > h.units) { note.textContent = `This account holds ${formatUnits(h.units, h.decimals)} ${h.symbol}; that is more.`; return; }
    if (await transact(`Withdraw ${h.symbol}`, from, encodeWithdrawToken(token as Hex, owner, units))) {
      note.textContent = `Sent ${formatUnits(units, h.decimals)} ${h.symbol} to your wallet.`;
      void refreshAccount();
    }
  })();
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
  const days = Number(input("grant-days").value);
  if (!Number.isFinite(days) || days <= 0 || days > 365) { note.textContent = "Days between 1 and 365, like 30."; return; }
  const expiry = Math.floor(Date.now() / 1000) + Math.floor(days * 86_400);
  note.textContent = "";
  const data = encodeGrant(key as Hex, [{ target: target as Hex, selector: selector as Hex }], perCall, cap, expiry);
  const acct = account;
  void (async () => {
    // The contract never grants a key twice on one account; asked first, so the refusal is words and not a failed transaction.
    const [had] = await publicClient.readContract({ address: acct, abi: SESSION_ACCOUNT_ABI, functionName: "sessionOf", args: [key as Hex] });
    if (had) { note.textContent = "That key already had a session on this account, and the contract never grants a key twice. Start a new account to let it back in."; return; }
    if (!(await transact("Grant", acct, data))) return;
    rememberKey(acct, key as Hex);
    void renderSessions();
  })();
});

// ---- the bot's link ----
// `?link=<nonce>&key=<signer>` comes from Chit Bot's Connect button. The nonce is the bot's; the key is the
// bot's signer, filled into the grant form with the beta's caps. Linking is a signature, not a transaction.

const linkParams = new URLSearchParams(location.search);
const linkNonce = linkParams.get("link");
const linkKey = linkParams.get("key");
const LINK_API = "/api/bot/link";
const BETA_GRANT = { perCall: "0.05", cap: "0.5", days: "30" };

const linkMessage = (chainId: number, acct: Hex, nonce: string): string => `chit-bot-link|${chainId}|${acct}|${nonce}`;

const initLink = async (): Promise<void> => {
  if (!linkNonce || !/^[0-9a-f]{32}$/.test(linkNonce)) return;
  el("link-section").hidden = false;
  if (linkKey && isAddress(linkKey)) {
    el("link-key").textContent = linkKey;
    input("grant-key").value ||= linkKey;
    input("grant-per-call").value = BETA_GRANT.perCall;
    input("grant-cap").value = BETA_GRANT.cap;
    input("grant-days").value = BETA_GRANT.days;
  } else {
    el("link-key").textContent = "not in the link; paste it from the bot's card";
  }
  const note = el("link-note");
  try {
    const r = await (await fetch(`${LINK_API}?nonce=${linkNonce}`)).json() as { ok: boolean; why?: string };
    if (!r.ok) { note.textContent = r.why === "used" ? "This link was already used. Ask the bot for a new one (/link)." : "This link expired. Ask the bot for a new one (/link)."; return; }
  } catch { note.textContent = "Could not reach the bot's link service right now."; return; }
  button("link-submit").disabled = false;
};

button("link-submit").addEventListener("click", async () => {
  const note = el("link-note");
  if (!linkNonce) return;
  if (!wallet || !account) { note.textContent = "Connect your wallet first."; return; }
  if (!deployed) { note.textContent = "Create your account first (step 1)."; return; }
  const eth = ethereum();
  if (!(await ensureRobinhoodTestnet(eth))) { note.textContent = "Switch your wallet to Robinhood Chain first."; return; }
  const message = linkMessage(Number(ROBINHOOD_TESTNET.chainId), account, linkNonce);
  note.textContent = "Sign the message in your wallet…";
  let signature: string;
  try {
    signature = (await eth.request({ method: "personal_sign", params: [message, wallet] })) as string;
  } catch (error) {
    note.textContent = (error as { message?: string }).message?.split("\n")[0] ?? "The wallet refused.";
    return;
  }
  button("link-submit").disabled = true;
  try {
    const r = await fetch(LINK_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: linkNonce, account, signature }) });
    const j = (await r.json()) as { ok?: boolean; error?: string; account?: string };
    if (!r.ok || !j.ok) { note.textContent = j.error ?? `The bot said ${r.status}.`; button("link-submit").disabled = true; return; }
    note.textContent = `Linked: the bot trades from ${j.account} within the session you granted. Go back to Telegram and press "I linked it".`;
    banner("Linked to the bot.", "ok");
  } catch {
    note.textContent = "Could not reach the bot's link service; try again.";
    button("link-submit").disabled = false;
  }
});

// ---- the bot's lead link ----
// `?lead=<nonce>&handle=<name>` comes from Chit Bot's "from my own wallet" choice under ⭐ Become a leader. The nonce is
// the bot's (the same store and fifteen minutes as the link's); the name is a hint the bot took from Telegram, without
// the @, filled in for the leader to keep or change. No account is needed here: the wallet that trades is the proof, and
// a signature over `chit-bot-lead|<chainId>|<wallet>|<nonce>` is all the bot gets. Nothing is sent to the chain.

const leadNonce = linkParams.get("lead");
const LEAD_API = "/api/bot/lead";

const leadMessage = (chainId: number, walletAddress: Hex, nonce: string): string => `chit-bot-lead|${chainId}|${getAddress(walletAddress)}|${nonce}`;

const initLead = async (): Promise<void> => {
  if (!leadNonce || !/^[0-9a-f]{32}$/.test(leadNonce)) return;
  el("lead-section").hidden = false;
  const hint = linkParams.get("handle");
  if (hint) input("lead-handle").value ||= hint.slice(0, 32);
  const note = el("lead-note");
  try {
    const r = await (await fetch(`${LEAD_API}?nonce=${leadNonce}`)).json() as { ok: boolean; why?: string };
    if (!r.ok) { note.textContent = r.why === "used" ? "This link was already used. Ask the bot for a new one (⭐ Become a leader, from my own wallet)." : "This link expired. Ask the bot for a new one (⭐ Become a leader, from my own wallet)."; return; }
  } catch { note.textContent = "Could not reach the bot's lead service right now."; return; }
  button("lead-submit").disabled = false;
};

el("lead-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const note = el("lead-note");
  if (!leadNonce) return;
  if (!wallet) { note.textContent = "Connect the wallet you trade from first."; return; }
  const handle = input("lead-handle").value.trim();
  if (!handle) { note.textContent = "Give followers a name to find you by."; return; }
  if (handle.startsWith("@")) { note.textContent = "No @ here: a name typed on a page cannot prove a Telegram username. Letters, digits, spaces, _ . - only."; return; }
  const eth = ethereum();
  if (!(await ensureRobinhoodTestnet(eth))) { note.textContent = "Switch your wallet to Robinhood Chain first."; return; }
  const message = leadMessage(Number(ROBINHOOD_TESTNET.chainId), wallet, leadNonce);
  note.textContent = "Sign the message in your wallet… it moves nothing.";
  let signature: string;
  try {
    signature = (await eth.request({ method: "personal_sign", params: [message, wallet] })) as string;
  } catch (error) {
    note.textContent = (error as { message?: string }).message?.split("\n")[0] ?? "The wallet refused.";
    return;
  }
  button("lead-submit").disabled = true;
  try {
    const r = await fetch(LEAD_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: leadNonce, wallet: getAddress(wallet), signature, handle }) });
    const j = (await r.json()) as { ok?: boolean; error?: string; wallet?: string; handle?: string };
    if (!r.ok || !j.ok) { note.textContent = j.error ?? `The bot said ${r.status}.`; button("lead-submit").disabled = r.status === 409 || r.status === 410; return; }
    note.textContent = `You lead as ${j.handle} from ${j.wallet}. Every ETH buy this wallet makes on the venue is now posted and mirrored. Go back to Telegram and press "I signed it".`;
    banner("Leading from this wallet.", "ok");
  } catch {
    note.textContent = "Could not reach the bot's lead service; try again.";
    button("lead-submit").disabled = false;
  }
});

el("account-refresh").addEventListener("click", () => {
  const typed = input("grant-key").value.trim();
  if (account && isAddress(typed)) rememberKey(account, typed as Hex);
  void refreshAccount();
});
window.addEventListener("chit-wallet-changed", () => void refreshAccount());

void loadTarget().then(() => refreshAccount()).then(() => initLink()).then(() => initLead());
