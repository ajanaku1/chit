"use client";

import { useState } from "react";

import { useLive, type Progress } from "./live";

const PAD = "pt-[112px] pb-[40px]";

/* ================================================================
   how it works, in three moves
   ================================================================ */

const STEPS = [
  {
    n: "01",
    t: "Deposit",
    s: "Send ETH from your main wallet into the Chit pool, in one of three fixed sizes, so it looks like every other deposit of its size.",
    chips: ["0.01", "0.05", "0.1"],
    code: "deposit → chit pool",
  },
  {
    n: "02",
    t: "Fund your fleet",
    s: "Set up your fleet in the app. Chit funds each fleet wallet from the shared pool after a random wait, so no transaction joins the two.",
    chips: ["1 min floor", "15 min at most"],
    code: "pool → fleet, on a timer",
  },
  {
    n: "03",
    t: "Trade",
    s: "Trade from the app or from @usechit_bot, on a session key with the limits you set. Take back what is unspent yourself, any time.",
    chips: ["Per trade cap", "Expiry", "Revoke in 1 tx"],
    code: "session key → your fleet",
  },
];

export function HowItWorks() {
  return (
    <section id="how" data-scene="How it works" className={`scene flex flex-col bg-surface ${PAD}`}>
      <div className="mx-auto flex w-full max-w-wide flex-wrap items-end justify-between gap-6 px-6 md:px-10">
        <div>
          <p className="eyebrow mb-4 text-coral">How it works</p>
          <h2 className="display text-[clamp(44px,6vw,100px)]">
            Three moves.
            <br />
            <span className="text-paper/35">No line between them.</span>
          </h2>
        </div>
        <a href="#boundary" className="rounded-full border border-paper/20 px-6 py-2.5 text-[15px] font-medium transition-colors hover:border-paper">
          See what the chain sees
        </a>
      </div>

      {/* three cards on shared rows: number, space, title, copy, chips, the line under; so every title and every line sits level */}
      <ol className="mx-auto mt-10 grid w-full max-w-wide flex-1 grid-cols-1 gap-x-4 gap-y-4 px-6 md:grid-cols-3 md:grid-rows-[auto_1fr_auto_auto_auto_auto] md:gap-y-0 md:px-10">
        {STEPS.map((s, i) => (
          <li key={s.n} className="group relative flex flex-col gap-3 overflow-hidden rounded-card border border-paper/10 bg-void p-6 transition-colors duration-300 hover:border-coral/50 md:row-span-6 md:grid md:grid-rows-subgrid md:gap-0 md:p-8">
            {/* the seam runs down the right of every card, the way it runs through the mark */}
            <svg viewBox="0 0 20 100" preserveAspectRatio="none" className="absolute inset-y-0 right-6 h-full w-4 opacity-20 transition-opacity duration-300 group-hover:opacity-60" aria-hidden="true">
              <polyline points="10,0 6,13 13,26 6,40 13,54 6,68 13,82 8,100" fill="none" stroke="#FF5A3C" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
            <div className="flex items-center justify-between">
              <span className="display text-[clamp(56px,6vw,96px)] text-coral">{s.n}</span>
              {i < STEPS.length - 1 && <span className="mr-10 hidden text-[22px] text-paper/30 md:block" aria-hidden="true">→</span>}
            </div>
            <span className="min-h-6" aria-hidden="true" />
            <p className="font-display text-[clamp(26px,2.4vw,36px)] font-bold leading-[1.05] tracking-[-0.04em]">{s.t}</p>
            <p className="max-w-[36ch] pr-6 text-[14.5px] leading-relaxed text-paper/60 md:mt-3">{s.s}</p>
            <div className="flex flex-wrap content-start gap-2 pr-6 md:mt-5">
              {s.chips.map((c) => (
                <span key={c} className="rounded-full border border-paper/15 px-3 py-1 font-mono text-[12px] text-paper/70">{c}</span>
              ))}
            </div>
            <p className="self-end border-t border-paper/10 pt-4 font-mono text-[12.5px] text-paper/40 md:mt-5">{s.code}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ================================================================
   where the line sits
   ================================================================ */

const SEEN = ["Fleet accounts", "Trades", "Amounts", "Timing", "Gas", "The operator's gas payments", "Deposits into the pool", "Fleets funded from it"];
const WONT = ["No custody", "No imported keys", "No arbitrary calls", "No new token", "No manufactured volume", "Never a trade kept out of view"];

export function LineSits() {
  return (
    <section id="line" data-scene="The line" className={`scene flex bg-surface ${PAD}`}>
      <div className="mx-auto grid w-full max-w-wide grid-cols-1 content-center gap-8 px-6 md:px-10 lg:grid-cols-[1fr_1.25fr] lg:gap-12">
        <div className="flex flex-col justify-center">
          <p className="eyebrow mb-4 text-coral">Private, not anonymous</p>
          <h2 className="display text-[clamp(44px,5.6vw,96px)]">
            Here is exactly
            <br />
            where the line sits.
          </h2>
          <p className="mt-6 max-w-[44ch] text-[15px] leading-relaxed text-paper/60">
            The same line the tests enforce. Chit&apos;s operator knows which balance paid for which fleet, and while the pool is
            small, amounts and timing can still line up. We are not a mixer and we do not try to make you disappear.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-card border border-paper/10 bg-void p-6">
            <p className="eyebrow text-paper/50">Everyone can see</p>
            <ul className="mt-4 space-y-2.5">
              {SEEN.map((x) => (
                <li key={x} className="flex items-center gap-3 text-[14.5px] text-paper/75">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-paper/40" />
                  {x}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col rounded-card border border-coral/40 bg-coral p-6 text-ink">
            <p className="eyebrow text-ink/60">Kept off the chain</p>
            <p className="mt-4 font-display text-[clamp(24px,2.2vw,32px)] font-bold leading-[1.05] tracking-[-0.04em]">
              Which wallet funded which fleet.
            </p>
            <p className="mt-auto pt-6 text-[14px] leading-relaxed text-ink/75">
              Your ETH goes into a shared pool that carries no fleet marker, and Chit funds fleets from that pool, so no transaction
              links the two.
            </p>
          </div>
          <div className="rounded-card border border-paper/10 bg-void p-6 sm:col-span-2">
            <p className="eyebrow text-paper/50">What Chit will not do, by design</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {WONT.map((x) => (
                <span key={x} className="rounded-full border border-paper/15 px-3.5 py-1.5 text-[13px] text-paper/75">{x}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ================================================================
   where the build stands, read from the repo
   ================================================================ */

export function BuildProgress() {
  const p = useLive<Progress>("/api/progress", 300000);
  const pct = p?.tasks?.percent ?? 96;
  return (
    <section id="build" data-scene="The build" className={`scene flex bg-surface ${PAD}`}>
      <div className="mx-auto grid w-full max-w-wide grid-cols-1 content-center gap-10 px-6 md:px-10 lg:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col justify-center">
          <p className="eyebrow mb-4 flex items-center gap-2.5 text-coral">
            <span className="live-dot" /> Where the build stands
          </p>
          <p className="display tnum text-[clamp(110px,16vw,250px)]">
            {pct}
            <span className="text-coral">%</span>
          </p>
          <p className="mt-3 font-display text-[clamp(22px,2.2vw,32px)] font-bold tracking-[-0.04em]">Of the specced tasks, done.</p>
          <div className="mt-6 h-2 max-w-[560px] overflow-hidden rounded-full bg-paper/10">
            <div className="fill-bar h-full rounded-full bg-coral" style={{ width: `${pct}%`, animationDuration: "1400ms" }} />
          </div>
          <p className="mt-4 max-w-[48ch] text-[14px] leading-relaxed text-paper/50">
            {p?.tasks ? `${p.tasks.done} of ${p.tasks.total} tasks${p.commits ? `, ${p.commits.toLocaleString("en-US")} commits` : ""}. ` : ""}
            Progress is read, never typed: ticked boxes in the repo&apos;s task lists, recomputed on every push to main.
          </p>
        </div>

        <ol className="flex flex-col justify-center gap-3">
          {(p?.stages?.length ? p.stages : [
            { stage: 1, name: "Private gas", status: "Live on 46630" },
            { stage: 2, name: "Private funding pool", status: "Built, gates green, live validation pending" },
            { stage: 3, name: "Trustless shielded pool", status: "Not built" },
          ]).map((s) => {
            const live = /^live/i.test(s.status);
            const none = /^not built/i.test(s.status);
            return (
              <li key={s.stage} className={`flex items-center gap-5 rounded-card border p-5 md:p-6 ${live ? "border-live/30 bg-live/[0.06]" : none ? "border-paper/10 bg-transparent" : "border-coral/30 bg-coral/[0.06]"}`}>
                <span className={`display text-[clamp(40px,4vw,60px)] ${none ? "text-paper/20" : live ? "text-live" : "text-coral"}`}>0{s.stage}</span>
                <div>
                  <p className="font-display text-[clamp(20px,1.8vw,26px)] font-bold tracking-[-0.03em]">{s.name}</p>
                  <p className={`mt-1 text-[13.5px] ${none ? "text-paper/40" : "text-paper/65"}`}>{s.status}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/* ================================================================
   questions, straight answers
   ================================================================ */

const FAQ = [
  {
    q: "Is it anonymous?",
    a: "No. It is private, not anonymous. Nobody on the chain can join your wallet to your fleet, but Chit's operator can, and while the pool is small, amounts and timing can still line up.",
  },
  {
    q: "What if Chit goes offline?",
    a: "Your unspent balance is still yours. Request an exit, wait 24 hours, execute it. Chit never signs either transaction, and it works with the service down and the pool paused.",
  },
  {
    q: "Who can join the beta?",
    a: "$CHIT holders. The pool is capped at 1 ETH, with 0.1 ETH per depositor, and the caps stay until a professional audit is complete.",
  },
  {
    q: "Has it been audited?",
    a: "Not by a firm yet. Every limit is enforced by the contract and covered by tests, and that is exactly why the caps stay small until an audit is done.",
  },
  {
    q: "Where does the buyback money come from?",
    a: "A share of the fees goes into the buyback contract every day, and the share grows with $CHIT's market cap. The contract has no owner and no withdraw, so it can only buy and burn.",
  },
  {
    q: "Can the bot move my funds anywhere it likes?",
    a: "No. It trades on a session key you set: a cap per trade, a total, an expiry. It can only do what that key allows, and you revoke it in one transaction.",
  },
];

export function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" data-scene="Questions" className={`scene flex bg-void ${PAD}`}>
      <div className="mx-auto grid w-full max-w-wide grid-cols-1 content-center gap-10 px-6 md:px-10 lg:grid-cols-[0.9fr_1.3fr]">
        <div className="flex flex-col justify-center">
          <p className="eyebrow mb-4 text-coral">Questions</p>
          <h2 className="display text-[clamp(44px,5.6vw,96px)]">
            Straight
            <br />
            answers.
          </h2>
          <p className="mt-6 max-w-[36ch] text-[15px] leading-relaxed text-paper/60">
            Ask anything else in the Telegram. The answers there are the same as here: what is live, what is not.
          </p>
          <a href="https://t.me/usechittools" className="mt-6 w-fit rounded-full border border-paper/20 px-6 py-2.5 text-[15px] font-medium transition-colors hover:border-paper">
            Ask in Telegram
          </a>
        </div>
        <div className="flex flex-col justify-center">
          {FAQ.map((f, i) => {
            const on = open === i;
            return (
              <div key={f.q} className="border-b border-paper/10 first:border-t">
                <button
                  type="button"
                  onClick={() => setOpen(on ? -1 : i)}
                  aria-expanded={on}
                  className="flex w-full items-center justify-between gap-6 py-5 text-left"
                >
                  <span className={`font-display text-[clamp(20px,1.9vw,28px)] font-bold tracking-[-0.035em] transition-colors ${on ? "text-paper" : "text-paper/60 hover:text-paper"}`}>{f.q}</span>
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border text-[16px] transition-all duration-300 ${on ? "rotate-45 border-coral bg-coral text-ink" : "border-paper/20 text-paper/70"}`} aria-hidden="true">+</span>
                </button>
                <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${on ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                  <p className="overflow-hidden pr-14 text-[15px] leading-relaxed text-paper/65">
                    <span className="block pb-5">{f.a}</span>
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
