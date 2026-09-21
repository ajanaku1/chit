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
 * With ANTHROPIC_API_KEY set, the push and the diary are told as one post in
 * the group's own voice instead: what shipped, why a holder cares, what is
 * live and what is next (see "the voice" below). Claude is given the facts
 * this file gathered and nothing else, and is held to them. Without the key,
 * or when the call fails, the grouped message and the diary go out as they
 * always did, so a push is never left unsaid. The chain message is never
 * reworded: every address and transaction in it is a link a reader can check.
 * The repository is private, so nothing here links to it.
 *
 * Runs from .github/workflows/announce-push.yml with a full checkout, so the
 * diary and chain diffs can read the tree before and after the push. Needs
 * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; without them it prints what it
 * would send and exits 0, so a fork or a missing secret never turns a push red.
 */

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const eventPath = process.env.GITHUB_EVENT_PATH;

const REPO_NAME = "chit fleet";
const DIARY = "IMPLEMENTATION.md";
const DEPLOYMENTS = "deployments/fleet-46630.json";
const MAX_LINES = 12;

/** Telegram's HTML mode needs exactly these three escaped. */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A subject line the group can read on a phone. Some commit subjects in this
 *  repo are whole paragraphs; one of them alone can fill a Telegram message,
 *  so a long one is cut at a word boundary rather than allowed to crowd out
 *  every other change in the push. */
const SUBJECT_MAX = 140;
const subject = (message) => {
  const first = String(message).split("\n")[0].trim();
  if (first.length <= SUBJECT_MAX) return first;
  const cut = first.slice(0, SUBJECT_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > SUBJECT_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()} …`;
};
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

/* ---------- the voice ---------- */

/**
 * The group hears feature news in one voice: lowercase, no dashes, no
 * disclaimers, hyped about the work and honest about what it is. A push used
 * to arrive as a list of commit subjects in another register, and the
 * subjects in this repo are often whole paragraphs written for the dev who
 * reads the log, not for a holder on a phone. So, with a key, Claude writes
 * the post from the facts: every commit's whole message, the diary entries
 * the push added, the chain records it will be followed by. The system
 * prompt is the voice and the rules; the facts are the only material. What
 * comes back is checked once more here: only the three tags Telegram allows,
 * balanced, the cashtag upper case, no dashes, a length Telegram accepts. An
 * unusable answer, a failed call or a missing key all fall back to the
 * grouped message and the diary, so the group never misses a push because
 * the voice was unavailable.
 */
const VOICE_MODEL = "claude-opus-5";

export const VOICE = `you write the changelog posts for CHIT Chat, the telegram group of chit (chit.tools): a private funding layer for trading fleets on robinhood chain. a trader deposits into chit, chit funds fresh wallets and pays their gas, so the main wallet never touches the fleet: private, not anonymous. $CHIT is the token; the buyback contract buys and burns $CHIT with 1% of its balance every hour. @usechit_bot is the telegram trading bot: token card with the orus and hey research lab lines, the pnl share card, the copy desk. the developer is bambam. the reader is a holder on a phone who wants to know that the project moves and exactly what moved.

the voice
- everything lowercase. the only exceptions: the cashtag is always $CHIT, and names of contracts, flags, variables and addresses are copied as they are
- no em dashes, no en dashes. commas, full stops, colons
- no disclaimers, no "not financial advice", no "stay tuned", no hashtags, no exclamation marks in a row. one emoji at the head of the post, at most one per bullet
- hyped but honest: the pride is in the work itself. short lines, plain words, a line a holder can repeat to a friend
- explain, do not list. each bullet says what changed and why it matters to a holder or a trader, in one or two lines. small related commits become one bullet. a docs, chore or test commit gets half a line, or nothing if it is only housekeeping

the facts
- say only what the facts say. never a price, a date, a launch, a listing, a partnership or an audit the facts do not name. never call anything live on mainnet unless the facts say mainnet. a test is a test, a doc is a doc, a plan is a plan
- if a commit says the work is not finished, say what is next in one line, in the facts' own words
- when chain records are in the facts, end with "addresses below": the script posts them with explorer links right after your post
- no commit hashes, no file paths, no links: the repository is private

the shape
- one line at the head: an emoji, then <b>a headline under ten words</b>
- then two to six bullets, each "· <b>two or three words</b>: the explanation"
- optionally one closing line: what it means for the holder, or what is next
- telegram html only: <b>, <i>, <code>. no markdown, no other tags, no headings. under 1400 characters
- write the post and nothing else: no preface, no notes, no code fence

an example of the voice, a feature post from this group:
<b>your pnl card just got receipts.</b>

tap 📸 on any position in @usechit_bot and this is what comes out: what you paid, what the pool would fill right now (fee and impact in), the number that matters biggest, your referral link on it.

and now two lines nobody else on the chain has on a card:
🔎 <b>orus</b>: honeypot, taxes, bundlers, top 10, holders, liquidity. the scan, on your bag.
🛠 <b>hey research lab</b>: shipping or not, commits, releases, verified builder. the builder, on your bag.

a screenshot of your position is now also proof you checked the token. forward it anywhere.`;

/** The facts, as plain text: the whole push, in the order it was made. */
export function voiceFacts(event, commits, diary, chain) {
  const pusher = event.pusher?.name ?? event.sender?.login ?? "the dev";
  const lines = [`push to main by ${pusher}: ${commits.length} commit${commits.length === 1 ? "" : "s"}`, ""];
  lines.push("the commits, oldest first, each with its whole message:");
  for (const c of [...commits].reverse()) lines.push("", `--- commit by ${c.author?.name ?? pusher}`, String(c.message).trim());
  if (diary.length) {
    lines.push("", "dev diary entries this push added (the dev's own words):");
    for (const e of diary) lines.push("", `## ${e.title}`, e.para);
  }
  if (chain.groups.length) {
    lines.push("", `chain records this push added on ${CHAIN_NAMES[chain.chainId] ?? `chain ${chain.chainId}`} (posted with explorer links after your post):`);
    for (const g of chain.groups) {
      const part = PARTS[g.part] ?? { label: spaced(g.part), what: "" };
      lines.push(`- ${part.label}${part.what ? ` (${part.what})` : ""}: ${g.items.map((it) => `${fieldLabel(it.leaf)} ${looksOnChain(it.value) ? short(String(it.value)) : String(it.value)}`).join("; ")}`);
    }
  }
  return lines.join("\n");
}

/** The answer, held to Telegram's HTML and the group's voice; empty when it cannot be made safe. */
export const tidyVoice = (raw) => {
  let s = String(raw).replace(/^\s*```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "").trim();
  // The dashes the voice never uses: a spaced one was a comma, a joined en dash a hyphen.
  s = s.replace(/\s+[\u2014\u2013]\s+/g, ", ").replace(/\u2014/g, ", ").replace(/\u2013/g, "-");
  s = s.replace(/\$chit\b/gi, "$CHIT");
  // Only <b>, <i> and <code> survive; every other angle bracket and bare ampersand is escaped, or Telegram refuses the post.
  const kept = [];
  s = s.replace(/<\/?(b|i|code)>/g, (t) => { kept.push(t); return `\u0000${kept.length - 1}\u0000`; });
  s = s.replace(/&(?!(amp|lt|gt|quot|#\d+);)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
  for (const t of ["b", "i", "code"]) {
    const open = (s.match(new RegExp(`<${t}>`, "g")) ?? []).length, close = (s.match(new RegExp(`</${t}>`, "g")) ?? []).length;
    if (open !== close) return "";
  }
  return s;
};

async function voiceMessage(event, commits, diary, chain) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  let Anthropic;
  try { ({ default: Anthropic } = await import("@anthropic-ai/sdk")); } catch (e) { console.log(`voice: the sdk is not installed (${e?.message ?? e}); the grouped message goes out`); return null; }
  const facts = voiceFacts(event, commits, diary, chain);
  try {
    const client = new Anthropic({ apiKey: key, timeout: 120_000, maxRetries: 1 });
    const response = await client.messages.create({
      model: VOICE_MODEL,
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: VOICE,
      messages: [{ role: "user", content: facts }],
    });
    if (response.stop_reason !== "end_turn") { console.log(`voice: the answer stopped on ${response.stop_reason}; the grouped message goes out`); return null; }
    const post = tidyVoice(response.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
    if (post.length < 40 || post.length > TELEGRAM_MAX) { console.log(`voice: an answer of ${post.length} characters cannot be posted; the grouped message goes out`); return null; }
    console.log(`voice: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out`);
    return post;
  } catch (e) {
    // Any failure is the same for the group: the plain message instead. The class is logged so the run says which it was.
    const kind = e instanceof Anthropic.AuthenticationError ? "the key was refused" : e instanceof Anthropic.RateLimitError ? "rate limited" : e instanceof Anthropic.APIError ? `api error ${e.status}` : e instanceof Anthropic.APIConnectionError ? "no connection" : "error";
    console.log(`voice: ${kind}: ${e?.message ?? e}; the grouped message goes out`);
    return null;
  }
}

/* ---------- send ---------- */

/** Telegram refuses a message over 4096 characters with a 400. A push of many
 *  commits can pass that even with subjects trimmed, and a failed announcement
 *  is a push the group never hears about, so a long message is split on line
 *  boundaries instead of being sent whole and rejected. Splitting on lines
 *  keeps every HTML tag inside one part, since no tag in this file spans one. */
const TELEGRAM_MAX = 4096;
const parts = (text) => {
  if (text.length <= TELEGRAM_MAX) return [text];
  const out = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.length > TELEGRAM_MAX ? `${line.slice(0, TELEGRAM_MAX - 2)} …` : line;
    if (current && current.length + piece.length + 1 > TELEGRAM_MAX) { out.push(current); current = piece; }
    else current = current ? `${current}\n${piece}` : piece;
  }
  if (current) out.push(current);
  return out;
};

async function send(text) {
  if (!token || !chat) { console.log("would send:\n" + text + "\n"); return; }
  for (const part of parts(text)) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: part, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!response.ok) throw new Error(`telegram answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
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
    // The whole message, not only the subject: the voice reads the body, where this repo's devs say why.
    const out = git("log", "--no-merges", "--format=%H%x1f%B%x1f%an%x1e", `${before}..${after}`);
    if (!out.trim()) return [];
    const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY ?? ""}`;
    return out.split("\x1e").map((r) => r.trim()).filter(Boolean).map((record) => {
      const [id, message, name] = record.split("\x1f");
      return { id, message: message.trim(), author: { name }, url: `${repoUrl}/commit/${id}` };
    });
  } catch {
    return null;
  }
}

const fromGit = commitsFromGit(pushEvent.before, pushEvent.after);
const commits = fromGit ?? pushEvent.commits.filter((c) => c && typeof c.id === "string" && c.distinct !== false);
if (commits.length === 0) { console.log("push carried no new commits; nothing to say"); process.exit(0); }

const before = pushEvent.before, after = pushEvent.after;
const ranged = Boolean(before && after && !/^0+$/.test(before));
const diary = ranged ? diaryEntries(before, after) : [];
const chain = ranged ? chainEntries(before, after) : { chainId: 46630, groups: [] };
/* One post in the voice when it can be had; the grouped message and the diary otherwise. The chain message follows either. */
const voiced = await voiceMessage(pushEvent, commits, diary, chain);
const messages = voiced ? [voiced] : [pushMessage(pushEvent, commits), ...diary.map(diaryMessage)];
if (chain.groups.length) messages.push(chainMessage(chain));

for (const m of messages) await send(m);
console.log(`announced: ${messages.length} message(s) for ${commits.length} commit(s)`);
