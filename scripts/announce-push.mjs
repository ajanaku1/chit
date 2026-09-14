/**
 * Tells the Telegram group what just landed on main.
 *
 * Runs from .github/workflows/announce-push.yml on every push to main and
 * posts one message: who pushed, how many commits, their subject lines, and
 * the compare link. That is the whole feature. It does not summarise, judge,
 * or reword anything; the commit subjects in this repo already say what
 * changed and why, so the group reads the same log the team does.
 *
 * Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. Without them it prints the
 * message and exits 0, so a fork or a missing secret never turns a push red.
 * Everything else comes from the event payload GitHub writes to
 * GITHUB_EVENT_PATH.
 */

import { readFile } from "node:fs/promises";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const eventPath = process.env.GITHUB_EVENT_PATH;

/** Telegram's HTML mode needs exactly these three escaped. */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Subject lines only; the body is for the repo, not the group. */
const subject = (message) => String(message).split("\n")[0].trim();

const MAX_LINES = 15;

const event = eventPath ? JSON.parse(await readFile(eventPath, "utf8")) : null;
if (!event || !Array.isArray(event.commits)) {
  console.log("no push event to announce");
  process.exit(0);
}

const commits = event.commits.filter((c) => c.distinct !== false);
if (commits.length === 0) {
  console.log("push carried no new commits (a force push or a merge of known work); nothing to say");
  process.exit(0);
}

const repo = event.repository?.full_name ?? "chit-fleet";
const branch = String(event.ref ?? "").replace(/^refs\/heads\//, "");
const pusher = event.pusher?.name ?? event.sender?.login ?? "someone";
const compare = event.compare ?? "";

const lines = commits.slice(0, MAX_LINES).map((c) => {
  const short = String(c.id).slice(0, 7);
  return `<a href="${esc(c.url)}">${short}</a> ${esc(subject(c.message))}`;
});
if (commits.length > MAX_LINES) lines.push(`… and ${commits.length - MAX_LINES} more`);

const head = `<b>${esc(repo)}</b> · ${commits.length} commit${commits.length === 1 ? "" : "s"} to <code>${esc(branch)}</code> by ${esc(pusher)}`;
const tail = compare ? `<a href="${esc(compare)}">what changed</a>` : "";
const text = [head, "", ...lines, "", tail].join("\n").trim();

if (!token || !chat) {
  console.log("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set; would have sent:\n" + text);
  process.exit(0);
}

const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
});
const body = await response.text();
if (!response.ok) {
  console.error(`telegram answered ${response.status}: ${body.slice(0, 200)}`);
  process.exit(1);
}
console.log(`announced ${commits.length} commit(s) to the group`);
