# Runbook: the agent toolchain under eyebrow

Chit is written with AI coding agents. The skills, MCP servers, hooks and
rules those agents run with have the developer's privileges and can change
after they were looked at; a changed one is a way into the code that goes to
mainnet without anyone touching the code. eyebrow (eyebrow.cc, MIT, open
source at github.com/alexverify/eyebrow) inventories those artifacts, hashes
them into a lockfile, and reports the moment any of them drifts. This is
what we run, what is committed, what the gate proves and what it does not.
Half an hour the first time, seconds after that.

Two scopes, kept apart on purpose:

- **Project scope** is what lives in this repository: `.claude/{skills,
  commands}/`, `.mcp.json`, `CLAUDE.md`, `.cursor/`, `.codex/`,
  `.agents/skills/`, `.gemini/`, `.windsurf/`. Locked in `eyebrowlock.json`,
  gated in CI (`.github/workflows/eyebrow.yml`). Today it holds nothing:
  the lockfile is empty and signed, and the gate is what stops the first
  artifact arriving without a review.
- **Global scope** is a developer's own machine: `~/.claude/{skills,
  plugins}/`, `settings.json`, the MCP servers in `~/.claude.json`, and the
  same for the other tools. That is where the toolchain that writes this
  code actually lives. It is pinned per machine, locally, and a content-free
  snapshot of it is committed under `.eyebrow/fleet/` so the team can see
  each other's blast radius. CI cannot recompute a machine it does not have,
  so the global gate runs on the machine itself, before a push.

Everything is hashes and verdicts; no artifact's source is ever written
into a lockfile or a snapshot.

## 0. Install

- macOS / Linux: `curl -fsSL https://eyebrow.cc/install.sh | sh` or
  `brew install alexverify/tap/eyebrow`.
- Windows: the `eyebrow_<version>_windows_amd64.zip` on the releases page,
  checked against `checksums.txt` (sha256), `eyebrow.exe` on the PATH.
  Discovery, hashing and verification work; the OS sandbox for `wrap`
  does not exist on Windows, `doctor` says so.
- Pin the same version everywhere: the CI action is at `v0.5.2`, the
  lockfile records `eyebrow/0.5.2` as its generator.

`eyebrow doctor` after installing: tools found, lockfile, policy, signing
key, sandbox, hooks, all on one screen.

## 1. Your key, once

```bash
eyebrow key show                                   # creates ~/.eyebrow/key on first use, prints the public half
eyebrow key trust -name <you> -file eyebrow.trustedkeys <public key>
```

`eyebrow.trustedkeys` is committed: one base64 ed25519 public key per line
with a label. Once the registry exists it is authoritative, locally and in
CI alike: a lockfile signed by a key not in it fails `verify --ci`. Add
yourself before you sign anything; the private key never leaves
`~/.eyebrow/key`.

## 2. Project scope: the committed lockfile

Run from the repository root.

```bash
eyebrow scan                    # discover, hash, analyse; writes eyebrowlock.json
eyebrow verify                  # what changed since the lockfile, informational
eyebrow approve --all --sign    # every artifact in the lockfile approved, each approval signed by your key
eyebrow sign                    # the lockfile itself signed
eyebrow verify --ci             # the gate CI runs; exit 0 is the only pass
```

Commit `eyebrowlock.json`, `eyebrow.policy.json`, `eyebrow.trustedkeys`.
The policy:

```json
{
  "failOnSeverity": "high",
  "requireApproval": true,
  "requireSignedApproval": true,
  "requireSignature": true
}
```

That reads: any new finding at high or critical fails; an artifact nobody
approved fails; an approval not signed by a trusted key fails; a lockfile
not signed by a trusted key fails. Verified on this repository at 0.5.2:
a project skill dropped into `.claude/skills/` is `[added]` and
`unapproved`, exit 1; the signature removed, exit 1; the lockfile re-signed
by a key outside the registry, exit 1; the committed state, exit 0.

When an artifact is meant to arrive (a project skill, an `.mcp.json`):
whoever adds it runs `eyebrow scan`, reads what eyebrow says about it,
`eyebrow approve <id> --sign`, `eyebrow sign`, and commits the lockfile in
the same change. The review is the approval; the gate only checks that it
happened and who did it.

## 3. Global scope: your own machine, before every push

```bash
eyebrow scan -global -lockfile ~/.eyebrow/machine.lock.json      # everything your agents run with, hashed
eyebrow approve --all --sign -lockfile ~/.eyebrow/machine.lock.json   # after reading the findings, not before
eyebrow freeze --all -lockfile ~/.eyebrow/machine.lock.json      # any later drift fails the gate
eyebrow sign -lockfile ~/.eyebrow/machine.lock.json
eyebrow verify -global --ci -lockfile ~/.eyebrow/machine.lock.json    # the pre-push gate for this machine
```

The machine lockfile stays on the machine (it is yours; the repository's
lockfile is the project's). What is committed is the snapshot:

```bash
eyebrow fleet export -global -owner <you>       # writes .eyebrow/fleet/<you>.json, content-free
eyebrow fleet                                   # the team view: blast radius and policy conformance across snapshots
eyebrow fleet verify                            # exit 1 if any snapshot is out of policy
```

Re-export after any change you approved, in the same commit as the
approval, so the snapshot in the repository is the machine that pushed.

Optional, and worth it on macOS and Linux: `eyebrow wrap -global` routes
Claude Code's MCP servers through the auditing shim, so every tool call is
logged (`eyebrow audit`) and the policy's `mcp.servers` deny rules are
enforced live. `eyebrow unwrap -global` restores the original config.

## 4. What the gate proves, and what it does not

Proves: the artifacts in this repository are exactly the ones in the
signed lockfile, every one of them approved by a key in the registry; and
for each machine with a snapshot, what that machine's agents run with and
whether it conforms to the policy, as of the snapshot's date.

Does not prove: anything about the contracts or the TypeScript, which have
their own audits (`docs/audit/`) and their own suites (`./verify.sh`);
that a machine's snapshot is current, beyond its date; anything on a
machine without a snapshot. A snapshot is a claim by whoever exported it,
signed by their key, not a measurement CI took. Say it that way wherever
it is said in public: "the agent toolchain is locked and signed, last
verified <date> by <who>", never "verified by CI".

## 5. Where it shows

Nowhere yet. If the eyebrow partnership goes ahead, one line on the trust
page of chit.tools and on the $CHIT card in the bot, with the lockfile's
signature, the date, and who signed, read from this repository, is the
whole product surface; it is decided and built as its own change, after
this gate has run for a while.
