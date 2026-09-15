#!/usr/bin/env node
// Computes landing/public/progress.json from the repo's own record of the
// work. Nothing here is typed in by hand: the numbers come from the task
// checkboxes in specs/*/tasks.md, the stage table in README.md, and git.
// PROGRESS.md is the rule this script implements; keep the two in step.
//
//   node scripts/progress.mjs            # write landing/public/progress.json
//   node scripts/progress.mjs --check    # exit 1 if the file is stale
//
// The GitHub workflow in .github/workflows/progress.yml runs this on every
// push to main and commits the result, so the landing's "how far along" sheet
// follows the repo without anyone remembering to update it.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = new URL("../landing/public/progress.json", import.meta.url);

/** A spec's task list: T-numbered checkboxes, grouped by its `## Phase` headings. */
function readSpec(dir) {
  const tasks = readFileSync(`${root}specs/${dir}/tasks.md`, "utf8");
  const spec = readFileSync(`${root}specs/${dir}/spec.md`, "utf8");
  const title = (spec.match(/^# (?:Feature Specification: )?(.+)$/m) ?? [, dir])[1].trim();

  const phases = [];
  let current = null;
  for (const line of tasks.split("\n")) {
    const heading = line.match(/^## Phase \d+: (.+?)(?: \(.*)?$/);
    if (heading) {
      current = { name: heading[1].replace(/ 🎯 MVP$/, "").trim(), done: 0, total: 0 };
      phases.push(current);
      continue;
    }
    if (line.startsWith("## ")) current = null;
    const task = line.match(/^- \[([ xX])\] (T\d+)/);
    if (!task || !current) continue;
    current.total += 1;
    if (task[1] !== " ") current.done += 1;
  }

  const open = [...tasks.matchAll(/^- \[ \] (T\d+) (.+)$/gm)]
    .map(([, id, text]) => ({ id, text: text.replace(/\s*\(.*$/, "").trim() }));

  return {
    id: dir,
    title,
    done: phases.reduce((n, p) => n + p.done, 0),
    total: phases.reduce((n, p) => n + p.total, 0),
    phases,
    open,
  };
}

/** The Stages table in README.md: `| **N. Name** | what | status |`. */
function readStages() {
  const readme = readFileSync(`${root}README.md`, "utf8");
  return [...readme.matchAll(/^\| \*\*(\d+)\. ([^*]+)\*\* \| [^|]+ \| ([^|]+) \|$/gm)]
    .map(([, n, name, status]) => ({ stage: Number(n), name: name.trim(), status: status.trim() }));
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const specs = readdirSync(`${root}specs`, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{3}-/.test(d.name))
  .map((d) => readSpec(d.name));

const done = specs.reduce((n, s) => n + s.done, 0);
const total = specs.reduce((n, s) => n + s.total, 0);

const progress = {
  rule: "PROGRESS.md",
  generatedAt: new Date().toISOString(),
  commit: git("rev-parse", "--short", "HEAD"),
  committedAt: git("log", "-1", "--format=%cI"),
  commits: Number(git("rev-list", "--count", "HEAD")),
  tasks: { done, total, percent: total === 0 ? 0 : Math.floor((done / total) * 100) },
  stages: readStages(),
  specs,
};

const json = `${JSON.stringify(progress, null, 2)}\n`;

if (process.argv.includes("--check")) {
  // The timestamp and commit change on every run; the facts must not.
  const strip = (s) => s.replace(/"(generatedAt|commit|committedAt|commits)": [^,\n]+,?\n/g, "");
  let current = "";
  try { current = readFileSync(out, "utf8"); } catch { /* missing counts as stale */ }
  if (strip(current) !== strip(json)) {
    console.error(`${basename(fileURLToPath(out))} is stale. Run: node scripts/progress.mjs`);
    process.exit(1);
  }
  console.log("progress.json is current");
} else {
  writeFileSync(out, json);
  console.log(`wrote ${fileURLToPath(out)}: ${done}/${total} tasks (${progress.tasks.percent}%)`);
}
