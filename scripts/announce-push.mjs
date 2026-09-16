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
 *                   used to pass in silence.
 *
 * Nothing is reworded or summarised by a model. Every line is either a commit
 * subject, a paragraph the dev wrote, or a value from the deployment record.
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
  const lines = [`🚀 <b>${esc(REPO_NAME)}</b>: ${commits.length} commit${commits.length === 1 ? "" : "s"} shipped to <code>${esc(branch)}</code> by ${esc(pusher)}`, esc(counts), ""];

  let shown = 0;
  for (const g of GROUPS) {
    const items = grouped.get(g.key);
    if (!items.length) continue;
    lines.push(`<b>${g.label}</b>`);
    for (const it of items) {
      if (shown >= MAX_LINES) break;
      lines.push(`· <a href="${esc(it.url)}">${it.short}</a> ${esc(it.text)}`);
      shown += 1;
    }
    if (shown >= MAX_LINES) break;
  }
  if (commits.length > shown) lines.push(`… and ${commits.length - shown} more`);
  if (compare) lines.push("", `<a href="${esc(compare)}">everything that changed</a>`);
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

const diaryMessage = (e) => `📓 <b>dev diary</b>: ${esc(e.title)}\n\n${esc(e.para)}\n\n<i>from ${esc(DIARY)}, written by the dev</i>`;

/* ---------- the chain ---------- */

const flatten = (o, prefix = "", out = {}) => {
  if (o && typeof o === "object" && !Array.isArray(o)) for (const k of Object.keys(o)) flatten(o[k], prefix ? `${prefix}.${k}` : k, out);
  else if (Array.isArray(o)) o.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else out[prefix] = o;
  return out;
};

const looksOnChain = (v) => typeof v === "string" && (/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x[0-9a-fA-F]{64}$/.test(v));

function chainEntries(before, after) {
  const read = (ref) => { try { return flatten(JSON.parse(git("show", `${ref}:${DEPLOYMENTS}`))); } catch { return null; } };
  const prev = read(before), next = read(after);
  if (!next) return [];
  return Object.entries(next)
    .filter(([k, v]) => looksOnChain(v) && (!prev || prev[k] !== v))
    .map(([k, v]) => ({ key: k, value: v, kind: v.length === 42 ? "address" : "tx" }));
}

function chainMessage(entries) {
  const lines = entries.slice(0, MAX_LINES).map((e) => `· <b>${esc(e.key)}</b> ${e.kind}: <code>${esc(e.value)}</code>`);
  if (entries.length > MAX_LINES) lines.push(`… and ${entries.length - MAX_LINES} more`);
  return [`⛓ <b>on chain</b>: ${entries.length} new record${entries.length === 1 ? "" : "s"} on Robinhood Chain testnet 46630`, "", ...lines, "", `<i>from ${esc(DEPLOYMENTS)}, every value is verifiable on the chain</i>`].join("\n");
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
  if (chain.length) messages.push(chainMessage(chain));
}

for (const m of messages) await send(m);
console.log(`announced: ${messages.length} message(s) for ${commits.length} commit(s)`);
