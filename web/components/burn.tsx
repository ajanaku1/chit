"use client";

import { ago, fmtChit, fmtEth, mmss, useLive, useSecondsTo, type Burn } from "./live";

const PAD = "pt-[112px] pb-[40px]";

/**
 * A clock face with sixty ticks. The hand is the real hour: it points at how much of the wait
 * since the last call has passed, and reaches the top when anyone may call the buyback again.
 */
function HourRing({ secs }: { secs: number | undefined }) {
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  const known = secs !== undefined;
  const turn = known ? ((3600 - Math.min(3600, secs)) / 3600) * 360 : 0;
  const open = known && secs === 0;
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[min(520px,56vh)]">
      <svg viewBox="0 0 200 200" className="h-full w-full" aria-hidden="true">
        <circle cx="100" cy="100" r="92" fill="none" stroke="rgba(245,239,229,0.08)" strokeWidth="1" />
        {ticks.map((i) => {
          const a = (i / 60) * Math.PI * 2;
          const long = i % 5 === 0;
          const passed = known && (i / 60) * 360 <= turn;
          return (
            <line
              key={i}
              x1={100 + Math.sin(a) * (long ? 80 : 84)}
              y1={100 - Math.cos(a) * (long ? 80 : 84)}
              x2={100 + Math.sin(a) * 90}
              y2={100 - Math.cos(a) * 90}
              stroke={i === 0 ? "#FF5A3C" : passed ? "rgba(255,90,60,0.75)" : long ? "rgba(245,239,229,0.45)" : "rgba(245,239,229,0.18)"}
              strokeWidth={i === 0 ? 2.4 : long ? 1.4 : 0.8}
              strokeLinecap="round"
            />
          );
        })}
        <g
          className={known ? "" : "sweep"}
          style={known ? { transform: `rotate(${turn}deg)`, transformOrigin: "100px 100px", transition: "transform 1s linear" } : undefined}
        >
          <path d="M100 100 L49.5 30.4 A86 86 0 0 1 100 14 Z" fill="url(#trail)" />
          <line x1="100" y1="100" x2="100" y2="12" stroke="#FF5A3C" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="100" cy="12" r="3" fill="#FF7A5C" />
        </g>
        <defs>
          <linearGradient id="trail" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#FF5A3C" stopOpacity="0" />
            <stop offset="1" stopColor="#FF5A3C" stopOpacity="0.4" />
          </linearGradient>
        </defs>
        <circle cx="100" cy="100" r="3.2" fill="#FF5A3C" />
      </svg>
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="mt-[34%] text-center">
          <p className="font-mono text-[clamp(30px,3.4vw,46px)] tnum tracking-[-0.04em]" suppressHydrationWarning>
            {open ? "Open now" : mmss(secs)}
          </p>
          <p className="eyebrow mt-2 text-paper/50">{open ? "Anyone can call it" : "Until the next call opens"}</p>
        </div>
      </div>
    </div>
  );
}

export function BurnHero() {
  const live = useLive<Burn>("/api/burn", 60000);
  const secs = useSecondsTo(live?.nextDueAt);
  const pct = Math.floor((live?.burnedOfMinted ?? 0.9954) * 100) / 100;
  return (
    <section id="top" data-scene="Burn" className={`scene flex bg-void ${PAD}`}>
      <div className="pointer-events-none absolute right-[-10vw] top-1/2 h-[90vh] w-[60vw] -translate-y-1/2 rounded-full bg-coral/[0.1] blur-[140px]" />
      <div className="relative mx-auto grid w-full max-w-wide grid-cols-1 items-center gap-10 px-6 md:px-10 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <p className="eyebrow mb-5 flex items-center gap-2.5 text-coral">
            <span className="live-dot" /> The $CHIT buyback, live
          </p>
          <h1 className="display text-[clamp(52px,7vw,108px)]">
            Supply that
            <br />
            only goes
            <br />
            <span className="text-coral">one way.</span>
          </h1>
          <div className="mt-10 grid max-w-[620px] grid-cols-2 gap-px overflow-hidden rounded-card border border-paper/10 bg-paper/10">
            {[
              ["Burned", `${pct.toFixed(2)}%`, "Of the minted billion"],
              ["CHIT burned", fmtChit(live?.burned ?? "9954674974375619552110455"), `Over ${live?.buys ?? 156} buys`],
              ["ETH spent", fmtEth(live?.spent ?? "1030530982367212800", 3), "Every wei of it on the pool"],
              ["Waiting to burn", `${fmtEth(live?.balance ?? "381457037632787200", 3)} ETH`, "1% of it each hour"],
            ].map(([k, v, s]) => (
              <div key={k} className="bg-surface p-5">
                <p className="eyebrow text-paper/45">{k}</p>
                <p className={`mt-2 font-mono text-[clamp(22px,2.2vw,32px)] tnum tracking-[-0.04em] ${k === "Burned" ? "text-coral" : ""}`}>{v}</p>
                <p className="mt-1 text-[13px] text-paper/50">{s}</p>
              </div>
            ))}
          </div>
        </div>
        <HourRing secs={secs} />
      </div>
    </section>
  );
}

/** Every call the contract answered, newest first: each row an event anyone can open on the explorer. */
export function BurnLog() {
  const live = useLive<Burn>("/api/burn", 60000);
  const rows = live?.events?.filter((e) => e.kind === "burned").slice(0, 8) ?? [];
  const explorer = live?.explorer ?? "https://robinhoodchain.blockscout.com";
  return (
    <section id="log" data-scene="The log" className={`scene flex bg-void ${PAD}`}>
      <div className="mx-auto grid w-full max-w-wide grid-cols-1 gap-10 px-6 md:px-10 lg:grid-cols-[1fr_1.4fr]">
        <div className="flex flex-col justify-center">
          <p className="eyebrow mb-4 flex items-center gap-2.5 text-coral">
            <span className="live-dot" /> Straight from the chain
          </p>
          <h2 className="display text-[clamp(44px,5.6vw,96px)]">Every burn, as it happened.</h2>
          <p className="mt-6 max-w-[42ch] text-[15px] leading-relaxed text-paper/60">
            Each row is an event the contract emitted: ETH in, $CHIT bought on the pool and burned in the same transaction.
            Open one and check it yourself.
          </p>
        </div>
        <div className="flex flex-col justify-center">
          <div className="overflow-hidden rounded-card border border-paper/10">
            <div className="eyebrow grid grid-cols-[1fr_1fr_1fr_auto] gap-3 whitespace-nowrap border-b border-paper/10 bg-surface px-4 py-3 text-[10px] text-paper/45 sm:gap-4 sm:px-5 sm:text-[11px]">
              <span>When</span>
              <span>ETH in</span>
              <span>CHIT burned</span>
              <span className="w-5" />
            </div>
            {rows.length === 0 && <p className="px-5 py-6 text-[14px] text-paper/50">Reading the chain…</p>}
            {rows.map((e, i) => (
              <a
                key={e.tx}
                href={`${explorer}/tx/${e.tx}`}
                className="row-in grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-3 whitespace-nowrap border-b border-paper/[0.06] px-4 py-3.5 font-mono text-[13px] tnum sm:gap-4 sm:px-5 sm:text-[14px] transition-colors last:border-0 hover:bg-paper/[0.04]"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <span className="text-paper/55" suppressHydrationWarning>{ago(e.at)}</span>
                <span>{fmtEth(e.ethIn, 4)}</span>
                <span className="text-coral">{fmtChit(e.burned)}</span>
                <span className="w-5 text-paper/40" aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const STEPS = [
  { n: "01", k: "Size", t: "One percent of the balance", f: ["spend = balance × 1%", "floor 0.002 · ceiling 0.1"], s: "A share never runs dry and a fuller contract buys bigger. A quiet hour wastes no gas and a loud one does not land in one candle." },
  { n: "02", k: "Quote", t: "The pool's own price", f: ["quote ← pool(key)", "key fixed at deploy"], s: "It reads the one pool it was deployed against, so nobody can point it at a pool they opened to drain it." },
  { n: "03", k: "Buy", t: "Or refuse", f: ["fill ≥ quote × 0.95", "else revert"], s: "One exact-in swap through the router. A burn nobody can hide is not a free lunch for a sandwich bot." },
  { n: "04", k: "Burn", t: "In the same transaction", f: ["burn(bought)", "token balance: 0 → 0"], s: "Everything bought is burned before the call ends, and the event carries the numbers." },
];

export function Mechanism() {
  return (
    <section id="how" data-scene="How" className={`scene flex flex-col bg-surface ${PAD}`}>
      <div className="mx-auto w-full max-w-wide px-6 md:px-10">
        <p className="eyebrow mb-4 text-coral">The mechanism</p>
        <h2 className="display text-[clamp(44px,6.4vw,104px)]">Four steps. One transaction.<br />Every hour.</h2>
      </div>
      {/* one row of four, their parts on shared tracks so every title and every line of copy sits level */}
      <ol className="mx-auto mt-10 grid w-full max-w-wide flex-1 grid-cols-1 gap-px overflow-hidden border-y border-paper/10 bg-paper/10 sm:grid-cols-2 lg:grid-cols-4 lg:grid-rows-[auto_1fr_auto_auto_auto]">
        {STEPS.map((s, i) => (
          <li key={s.n} className="group relative flex flex-col gap-4 bg-surface p-6 transition-colors duration-300 hover:bg-[#1a1816] md:p-8 lg:row-span-5 lg:grid lg:grid-rows-subgrid">
            <p className="display text-[clamp(64px,7vw,120px)] text-paper/[0.1] transition-colors duration-300 group-hover:text-coral">{s.n}</p>
            <div className="flex flex-col justify-center gap-1.5">
              {s.f.map((line, j) => (
                <code key={line} className={`w-fit rounded-inner border px-3 py-1.5 font-mono text-[12.5px] ${j === 0 ? "border-coral/35 bg-coral/[0.07] text-paper/85" : "border-paper/10 text-paper/50"}`}>{line}</code>
              ))}
            </div>
            <p className="eyebrow text-coral">{s.k}</p>
            <p className="font-display text-[clamp(22px,1.9vw,28px)] font-bold leading-[1.05] tracking-[-0.035em]">{s.t}</p>
            <p className="text-[14px] leading-relaxed text-paper/60">{s.s}</p>
            {i < STEPS.length - 1 && (
              <span className="absolute -right-3 top-[clamp(52px,5vw,84px)] z-10 hidden h-6 w-6 place-items-center rounded-full border border-paper/15 bg-void text-[12px] text-coral lg:grid" aria-hidden="true">→</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

const GUARDS = [
  ["No owner", "There is no function only we can call, so there is no key to lose and nothing to be pressured into using."],
  ["No withdraw", "ETH that goes in is spent on burns or sits there forever. The line people check first, and the one that cannot be argued with."],
  ["Anyone calls it", "If our keeper dies, a holder calls the function and the burn still happens. Once an hour, enforced on chain, so nobody drains it in a loop."],
  ["The fill guard", "A fill more than five percent under the pool's own quote reverts. The burn waits an hour rather than paying a bot."],
];

export function Guards() {
  return (
    <section id="guards" data-scene="Guards" className={`scene flex bg-surface ${PAD}`}>
      <div className="mx-auto grid w-full max-w-wide grid-cols-1 gap-10 px-6 md:grid-cols-[1fr_1.2fr] md:px-10">
        <div className="flex flex-col justify-center">
          <p className="eyebrow mb-4 text-coral">What makes it worth anything</p>
          <h2 className="display text-[clamp(44px,6vw,100px)]">A buyback is a sentence anyone can write.</h2>
          <p className="mt-6 max-w-[44ch] text-[15px] leading-relaxed text-paper/60">
            These are the reasons this one is a machine instead. Every line is something the contract refuses to do, not something
            we promise not to do.
          </p>
        </div>
        <div className="flex flex-col justify-center">
          {GUARDS.map(([k, v]) => (
            <div key={k} className="group grid grid-cols-[auto_1fr] gap-x-5 border-b border-paper/10 py-6 first:border-t">
              <span className="mt-2 h-3 w-3 rotate-45 bg-coral transition-transform duration-300 group-hover:rotate-[225deg]" />
              <div>
                <p className="font-display text-[clamp(24px,2.4vw,36px)] font-bold tracking-[-0.04em]">{k}</p>
                <p className="mt-1.5 max-w-[52ch] text-[14.5px] leading-relaxed text-paper/60">{v}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
