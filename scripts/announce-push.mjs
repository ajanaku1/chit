/**
 * Tells the Telegram group what just landed on main, in up to three messages.
 *
 *   the push        who shipped, how many commits, grouped as new / fixed /
 *                   tests / housekeeping from the conventional prefixes this
 *                   repo already uses, each subject linked to its commit
 *   the diary       any new `## ` entry the push added to IMPLEMENTATION.md,
 *                   title and first paragraph, in the dev's own words. That
 *                   file is where the story of the build is written; the
 *                   group gets it the moment it is written.
 *   the chain       any new address or transaction hash the push recorded in
 *                   deployments/fleet-46630.json. A contract going live is
 *                   the kind of moment people follow a project for, and it
 *                   used to pass in silence. Written for the group, not for
 *                   the dev: grouped by what the contracts are (the pool, the
 *                   venue, the stage 1 set), each with one line on what it
 *                   does, every address and transaction a link to the
 *                   explorer, a replaced contract named as replaced.
 *
 * Nothing is reworded or summarised by a model. Every line is either a commit
 * subject, a paragraph the dev wrote, or a value from the deployment record
 * under a label this file gives it. The repository is private, so nothing
 * here links to it; the explorer is where a reader can check.
 *
 * Runs from .github/workflows/announce-push.yml with a full checkout, so the
 * diary and chain diffs can read the tree before and after the push. Needs
 * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; without them it prints what it
 * would send and exits 0, so a fork or a missing secret never turns a push red.
 */

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const eventPath = process.env.GITHUB_EVENT_PATH;

const REPO_NAME = "chit fleet";
const DIARY = "IMPLEMENTATION.md";
const DEPLOYMENTS = "deployments/fleet-46630.json";
const MAX_LINES = 12;

/** Telegram's HTML mode needs exactly these three escaped. */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const subject = (message) => String(message).split("\n")[0].trim();
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

/* ---------- the push ---------- */

const GROUPS = [
  { key: "new", label: "new", match: /^feat(\(|:|!)/ },
  { key: "fixed", label: "fixed", match: /^fix(\(|:|!)/ },
  { key: "tests", label: "tests", match: /^test(\(|:|!)/ },
  { key: "docs", label: "docs", match: /^docs(\(|:|!)/ },
  { key: "other", label: "housekeeping", match: /./ },
];

/** Drops the conventional prefix for reading; the group does not need `feat(app):`. */
const plain = (s) => s.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "");

function pushMessage(event, commits) {
  const branch = String(event.ref ?? "").replace(/^refs\/heads\//, "");
  const pusher = event.pusher?.name ?? event.sender?.login ?? "someone";
  const compare = event.compare ?? "";

  const grouped = new Map(GROUPS.map((g) => [g.key, []]));
  for (const c of commits) {
    const s = subject(c.message);
    const g = GROUPS.find((x) => x.match.test(s)) ?? GROUPS[GROUPS.length - 1];
    grouped.get(g.key).push({ short: String(c.id).slice(0, 7), url: c.url, text: plain(s) });
  }

  const counts = GROUPS.filter((g) => grouped.get(g.key).length).map((g) => `${grouped.get(g.key).length} ${g.label}`).join(", ");
  const lines = [`🚀 <b>${esc(REPO_NAME)}</b>: ${commits.length} change${commits.length === 1 ? "" : "s"} shipped by ${esc(pusher)}`, esc(counts), ""];
  void branch; void compare;

  // The repository is private: a commit link would be a dead end for the group, so each change is its subject and nothing else.
  let shown = 0;
  for (const g of GROUPS) {
    const items = grouped.get(g.key);
    if (!items.length) continue;
    lines.push(`<b>${g.label}</b>`);
    for (const it of items) {
      if (shown >= MAX_LINES) break;
      lines.push(`· ${esc(it.text)}`);
      shown += 1;
    }
    if (shown >= MAX_LINES) break;
  }
  if (commits.length > shown) lines.push(`… and ${commits.length - shown} more`);
  return lines.join("\n");
}

/* ---------- the diary ---------- */

/** New `## ` entries between two commits: the heading and the paragraph under it. */
function diaryEntries(before, after) {
  let diff;
  try { diff = git("diff", `${before}..${after}`, "--", DIARY); } catch { return []; }
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  const entries = [];
  for (let i = 0; i < added.length; i += 1) {
    const line = added[i];
    if (!line.startsWith("## ")) continue;
    const title = line.slice(3).trim();
    const para = [];
    for (let j = i + 1; j < added.length; j += 1) {
      const l = added[j];
      if (l.startsWith("## ")) break;
      if (l.trim() === "") { if (para.length) break; continue; }
      if (l.startsWith("#") || l.startsWith("```")) continue;
      para.push(l.trim());
    }
    entries.push({ title, para: para.join(" ") });
  }
  return entries;
}

/** A paragraph the group can read on a phone: cut at a sentence end past this length. */
const DIARY_MAX = 700;
const trimPara = (text) => {
  if (text.length <= DIARY_MAX) return text;
  const cut = text.slice(0, DIARY_MAX);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return `${end > DIARY_MAX / 2 ? cut.slice(0, end + 1) : cut.trimEnd()} …`;
};
const diaryMessage = (e) => `📓 <b>dev diary</b>: ${esc(e.title)}\n\n${esc(trimPara(e.para))}\n\n<i>the dev's own notes, as written</i>`;

/* ---------- the chain ---------- */

const flatten = (o, prefix = "", out = {}) => {
  if (o && typeof o === "object" && !Array.isArray(o)) for (const k of Object.keys(o)) flatten(o[k], prefix ? `${prefix}.${k}` : k, out);
  else if (Array.isArray(o)) o.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else out[prefix] = o;
  return out;
};

const looksOnChain = (v) => typeof v === "string" && (/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x[0-9a-fA-F]{64}$/.test(v));
const ZERO = /^0x0{40}$/;

const EXPLORERS = { 46630: "https://explorer.testnet.chain.robinhood.com", 4663: "https://robinhoodchain.blockscout.com" };
const CHAIN_NAMES = { 46630: "Robinhood Chain testnet", 4663: "Robinhood Chain" };

/** What each part of the record is, for people: an emoji, a name, one line on what it does. Unknown parts get their key. */
const PARTS = {
  "": { emoji: "🔧", label: "the stage 1 set", what: "the contracts behind sponsored fleets: what a fleet account may do, who makes the accounts, where a campaign's budget sits, who pays its gas" },
  pool: { emoji: "🏦", label: "the funding pool", what: "deposits go in, fleets are funded from it after a random wait" },
  venue: { emoji: "🧪", label: "the testnet venue", what: "a test token and its ETH pool on uniswap v4, where the demo buys happen" },
  firstBuy: { emoji: "🛒", label: "the first sponsored buy", what: "one fleet account bought through the router with the pool paying" },
  pooledJourney: { emoji: "🚀", label: "a full fleet journey", what: "deposit, fleet, funding, buy, close, all of it on chain" },
  buyback: { emoji: "🔥", label: "buyback and burn", what: "ETH in, CHIT bought on the pool and burned" },
  superseded: { emoji: "🗄", label: "retired contracts", what: "the earlier set, kept on record; nothing runs on it any more" },
  previous: { emoji: "🗄", label: "retired contracts", what: "the earlier set, kept on record; nothing runs on it any more" },
};
/** The order the group reads them in: what moves money first, the retired set last. */
const PART_ORDER = ["pool", "buyback", "venue", "firstBuy", "pooledJourney", "", "superseded", "previous"];
const RETIRED = new Set(["superseded", "previous"]);
const CONTRACT_LEAVES = /(^|\.)(address|sessionPolicy|accountFactory|campaignEscrow|paymaster|token|seeder)$/;
const FIELDS = {
  operator: "operator key", admin: "admin (the cold key)", entryPoint: "ERC-4337 entry point", router: "uniswap v4 router",
  sessionPolicy: "session policy", accountFactory: "account factory", campaignEscrow: "campaign escrow", paymaster: "paymaster",
  address: "contract", deployTx: "deployed in", token: "test token", seeder: "seeder", poolManager: "uniswap v4 pool manager",
  seedTx: "seeded in", tokenTx: "token deployed in", seederTx: "seeder deployed in", seedEth: "seeded with",
  buyTx: "the buy", fundTx: "funded in", principalTx: "principal sent in", account: "the account", owner: "owner wallet",
  key: "campaign key", campaign: "campaign id", setSettlerTx: "settler set in", adminHandoverTx: "admin handed over in",
  perDepositor: "cap per depositor", perDraw: "cap per draw", pool: "pool cap", gasHeadroom: "gas headroom per account",
  funded: "budget funded", spent: "budget spent", unused: "budget unused", reserved: "budget reserved",
};
/** Only these plain numbers are worth a line; everything else that is not an address or a hash stays in the file. */
const NUMBER_FIELDS = /^(pool\.caps\.|venue\.seedEth$|firstBuy\.budget\.funded$|buyback\.)/;
const SKIP = /(^|\.)(currency0|hooks|api|network|chainId|deployedAt|seededAt|at|tickLower|tickUpper|sqrtPriceX96|fee|tickSpacing)$/;

const spaced = (k) => k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
const PREFIX = { pool: "pool", caps: "", budget: "", venue: "venue" };
const fieldLabel = (leaf) => {
  if (leaf.includes(".")) {
    const parts = leaf.split(".");
    const head = parts.slice(0, -1).map((x) => PREFIX[x] ?? spaced(x)).filter(Boolean).join(" ");
    return `${head ? `${head} ` : ""}${fieldLabel(parts[parts.length - 1])}`;
  }
  const m = /^(.*)\[(\d+)\]$/.exec(leaf);
  if (m) return `${FIELDS[m[1]] ?? spaced(m[1])} ${Number(m[2]) + 1}`;
  if (FIELDS[leaf]) return FIELDS[leaf];
  if (/Tx$/.test(leaf)) return `${FIELDS[leaf.slice(0, -2)] ?? spaced(leaf.slice(0, -2))} deployed in`;
  return spaced(leaf);
};
const short = (v) => `${v.slice(0, 6)}…${v.slice(-4)}`;
const eth = (wei) => {
  const s = (Number(BigInt(wei)) / 1e18).toString();
  return `${s.length > 8 ? Number(s).toPrecision(3) : s} ETH`;
};
const renderValue = (key, value, explorer) => {
  const leaf = key.split(".").pop();
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return `<a href="${explorer}/address/${value}">${short(value)}</a>`;
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) {
    return /Tx$|^tx$|hash$/i.test(leaf) ? `<a href="${explorer}/tx/${value}">tx ${short(value)}</a>` : `<code>${short(value)}</code>`;
  }
  if (typeof value === "string" && /^\d{10,}$/.test(value)) return eth(value);
  if (typeof value === "number" && value >= 1e12) return eth(BigInt(value));
  return esc(String(value));
};

/** The record's leaves that changed between two commits, grouped by their top-level part, replaced values remembered. */
function chainEntries(before, after) {
  const read = (ref) => { try { return JSON.parse(git("show", `${ref}:${DEPLOYMENTS}`)); } catch { return null; } };
  const prevDoc = read(before), nextDoc = read(after);
  if (!nextDoc) return { chainId: 46630, groups: [] };
  const prev = prevDoc ? flatten(prevDoc) : {};
  const next = flatten(nextDoc);
  const byPart = new Map();
  for (const [key, value] of Object.entries(next)) {
    if (SKIP.test(key)) continue;
    const worth = looksOnChain(value) ? !ZERO.test(String(value)) : NUMBER_FIELDS.test(key);
    if (!worth || prev[key] === value) continue;
    const part = key.includes(".") ? key.split(".")[0] : "";
    // The retired set: the contracts only, no keys or transactions from the past.
    if (RETIRED.has(part) && !CONTRACT_LEAVES.test(key)) continue;
    if (!byPart.has(part)) byPart.set(part, []);
    byPart.get(part).push({ key, leaf: key.slice(part ? part.length + 1 : 0), value, was: prev[key] });
  }
  const rank = (part) => { const i = PART_ORDER.indexOf(part); return i === -1 ? PART_ORDER.length - 3 : i; };
  return { chainId: Number(nextDoc.chainId ?? 46630), groups: [...byPart].map(([part, items]) => ({ part, items })).sort((a, b) => rank(a.part) - rank(b.part)) };
}

const MAX_PER_PART = 6;

function chainMessage({ chainId, groups }) {
  const explorer = EXPLORERS[chainId] ?? EXPLORERS[46630];
  const chainName = CHAIN_NAMES[chainId] ?? `chain ${chainId}`;
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const lines = [`⛓ <b>on chain</b>: ${total} new record${total === 1 ? "" : "s"} on ${esc(chainName)}`, ""];
  for (const g of groups) {
    const part = PARTS[g.part] ?? { emoji: "📄", label: spaced(g.part), what: "" };
    lines.push(`${part.emoji} <b>${esc(part.label)}</b>${part.what ? ` · <i>${esc(part.what)}</i>` : ""}`);
    for (const it of g.items.slice(0, MAX_PER_PART)) {
      const replaced = it.was && looksOnChain(it.was) && /^0x[0-9a-fA-F]{40}$/.test(String(it.value)) ? ` (replaces ${short(String(it.was))})` : "";
      lines.push(`· ${esc(fieldLabel(it.leaf))}: ${renderValue(it.key, it.value, explorer)}${replaced}`);
    }
    if (g.items.length > MAX_PER_PART) lines.push(`· … and ${g.items.length - MAX_PER_PART} more in the record`);
    lines.push("");
  }
  lines.push(`<i>every address and transaction opens in the explorer; the record is the deployment file the service reads</i>`);
  return lines.join("\n");
}

/* ---------- send ---------- */

async function send(text) {
  if (!token || !chat) { console.log("would send:\n" + text + "\n"); return; }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`telegram answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

const event = eventPath ? JSON.parse(await readFile(eventPath, "utf8")) : null;

/* Run by hand from the Actions tab, there is no push to report; say hello
   instead, so the wiring can be checked the moment the secrets are set. */
let handRange = null;
if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && process.env.ANNOUNCE_BEFORE && process.env.ANNOUNCE_AFTER) {
  /* A range announced by hand: for a push the bot missed. */
  const range = { ref: "refs/heads/main", before: git("rev-parse", process.env.ANNOUNCE_BEFORE).trim(), after: git("rev-parse", process.env.ANNOUNCE_AFTER).trim(), pusher: { name: process.env.GITHUB_ACTOR ?? "the dev" }, commits: [] };
  handRange = range;
} else if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
  await send(`🔌 <b>${esc(REPO_NAME)}</b> announcer connected. from now on every push to <code>main</code> lands here: what shipped, the dev's notes, new contracts on chain.`);
  console.log("said hello");
  process.exit(0);
}

const pushEvent = handRange ?? event;
if (!pushEvent || !Array.isArray(pushEvent.commits)) { console.log("no push event to announce"); process.exit(0); }

/* What is new to main is what git says is new to main: `before..after`. The
   payload's own list is capped at twenty and flags a commit as not distinct
   when it already sits on any other branch, so a branch and main pushed
   together read as "nothing new". The payload is the fallback for a push
   whose `before` is unknown here (a new branch, or a force). */
function commitsFromGit(before, after) {
  if (!before || !after || /^0+$/.test(before)) return null;
  try {
    const out = git("log", "--no-merges", "--format=%H%x1f%s%x1f%an", `${before}..${after}`);
    if (!out.trim()) return [];
    const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY ?? ""}`;
    return out.trim().split("\n").map((line) => {
      const [id, message, name] = line.split("\x1f");
      return { id, message, author: { name }, url: `${repoUrl}/commit/${id}` };
    });
  } catch {
    return null;
  }
}

const fromGit = commitsFromGit(pushEvent.before, pushEvent.after);
const commits = fromGit ?? pushEvent.commits.filter((c) => c && typeof c.id === "string" && c.distinct !== false);
if (commits.length === 0) { console.log("push carried no new commits; nothing to say"); process.exit(0); }

const before = pushEvent.before, after = pushEvent.after;
const messages = [pushMessage(pushEvent, commits)];
if (before && after && !/^0+$/.test(before)) {
  for (const e of diaryEntries(before, after)) messages.push(diaryMessage(e));
  const chain = chainEntries(before, after);
  if (chain.groups.length) messages.push(chainMessage(chain));
}

for (const m of messages) await send(m);
console.log(`announced: ${messages.length} message(s) for ${commits.length} commit(s)`);
