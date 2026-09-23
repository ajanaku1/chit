"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { FACTS, useSceneExit } from "./chrome";
import { ago, fmtChit, fmtEth, mmss, useLive, useSecondsTo, type Burn } from "./live";
import { Mark, SEAM, leftOfSeam, rightOfSeam } from "./mark";
import { APP_HREF } from "./chain";

/* Every screen leaves room for the floating header above and the beta note below. */
const PAD = "pt-[112px] pb-[40px]";

/* ================================================================
   01 · the ticket, torn: the hero
   ================================================================ */

export function TornHero() {
  const ref = useRef<HTMLElement>(null);
  const p = useSceneExit(ref);
  // At rest a thin tear shows the glow behind; scrolling away pulls the two halves apart.
  const gap = 1.1 + p * 46;

  return (
    <section ref={ref} id="top" data-scene="Home" className="scene bg-void">
      {/* what shows through the tear: an ember glow on a faint ledger grid, no footage */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(245,239,229,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(245,239,229,0.035)_1px,transparent_1px)] bg-[size:72px_72px]" />
      <div className="ember absolute left-1/2 top-1/2 h-[120vh] w-[46vw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,#FF7A5C_0%,#FF5A3C_28%,#7A2415_62%,transparent_100%)] opacity-80 blur-2xl" />

      <div className="plate-cut absolute inset-x-[2.2vw] bottom-[max(20px,env(safe-area-inset-bottom))] top-[84px] lg:top-[92px]">
        {/* left half: the wallet's side */}
        <div className="enter-left absolute inset-0">
          <div
            className="absolute inset-0 bg-[radial-gradient(90%_70%_at_0%_0%,rgba(255,90,60,0.14),transparent_60%),linear-gradient(180deg,#171412,#100e0d)] will-change-transform"
            style={{ clipPath: leftOfSeam, transform: `translate3d(${-gap}vw,0,0)` }}
          >
            {/* both halves share one grid: label, space, headline, its line, less space, a foot, so the two headlines sit level */}
            <div className="grid h-full w-[45%] grid-rows-[auto_1fr_auto_auto_0.55fr_auto] p-[clamp(18px,3.2vw,56px)] text-paper">
              <HeroPulse />
              <span />
              <h1 className="display text-[clamp(44px,11vw,196px)]">
                Trade
                <br />
                <span className="text-coral">loud.</span>
              </h1>
              <div className="flex h-[5.5rem] flex-wrap content-start items-start gap-2 pt-5 md:h-[7.5rem] md:pt-7">
                <a href={APP_HREF} className="flex items-center gap-2 whitespace-nowrap rounded-full bg-coral py-2 pl-4 pr-2 text-[14px] font-medium text-ink transition-transform duration-200 hover:-translate-y-0.5 sm:py-2.5 sm:pl-6 sm:pr-2.5 sm:text-[15px]">
                  <span className="sm:hidden">Open app</span>
                  <span className="hidden sm:inline">Open the app</span>
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-ink text-paper" aria-hidden="true">→</span>
                </a>
                <a href="#boundary" className="hidden whitespace-nowrap rounded-full border border-paper/20 px-6 py-2.5 text-[15px] font-medium text-paper transition-colors duration-200 hover:border-paper lg:inline-flex">
                  Read the boundary
                </a>
              </div>
              <span />
              <p className="eyebrow flex h-7 items-center gap-2 text-paper/45">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-paper/45" /> Robinhood Chain · 4663
              </p>
            </div>
          </div>
        </div>

        {/* right half: the fleet's side, laid on the same three rows so both headlines sit on one baseline */}
        <div className="enter-right absolute inset-0">
          <div
            className="absolute inset-0 bg-[radial-gradient(90%_70%_at_100%_100%,rgba(255,90,60,0.12),transparent_60%),linear-gradient(180deg,#171412,#100e0d)] will-change-transform"
            style={{ clipPath: rightOfSeam, transform: `translate3d(${gap}vw,0,0)` }}
          >
            <div className={`ml-auto grid h-full w-[45%] grid-rows-[auto_1fr_auto_auto_0.55fr_auto] p-[clamp(18px,3.2vw,56px)] text-paper justify-items-end text-right`}>
              <p className="eyebrow flex min-h-6 items-center text-paper/55">Private, not anonymous</p>
              <span />
              <h2 className="display text-[clamp(44px,11vw,196px)]">
                Fund
                <br />
                <span className="text-paper/30">quiet.</span>
              </h2>
              <div className="h-[5.5rem] pt-5 md:h-[7.5rem] md:pt-7">
                <p className="hidden max-w-[40ch] text-[clamp(13px,1.05vw,16px)] leading-relaxed text-paper/70 md:block">
                  The Telegram bot and the private funding pool for Robinhood Chain. Your fleet trades in public, and no
                  transaction shows which wallet paid for it.
                </p>
                <p className="max-w-[16ch] text-[13px] font-medium leading-snug text-paper/70 md:hidden">Your main wallet never funds your fleet.</p>
              </div>
              <span />
              <p className="eyebrow hidden h-7 items-center gap-3 text-paper/45 md:flex" style={{ opacity: 1 - p * 3 }}>
                Scroll to tear it
                <span className="grid h-7 w-7 place-items-center rounded-full border border-paper/20 text-[13px] tracking-normal" aria-hidden="true">↓</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ================================================================
   02 · what the chain sees
   ================================================================ */

const FLEET = ["0x3f1a…9c04", "0x88e2…41d7", "0xa04c…e2b9", "0x5d71…0f3e", "0xc9b0…7a12"];

export function ChainSees() {
  // Opens part way through, so the first look already shows fleets being funded.
  const [shown, setShown] = useState(3);
  useEffect(() => {
    const t = setInterval(() => setShown((n) => (n >= FLEET.length + 3 ? 0 : n + 1)), 1100);
    return () => clearInterval(t);
  }, []);
  const rows = Math.min(shown, FLEET.length);

  return (
    <section id="boundary" data-scene="The chain" className={`scene flex flex-col bg-void ${PAD}`}>
      <div className="mx-auto grid w-full max-w-wide flex-none grid-cols-1 items-end gap-6 px-6 md:grid-cols-[1.5fr_1fr] md:px-10">
        <div>
          <p className="eyebrow mb-4 text-coral">What the chain sees</p>
          <h2 className="display text-[clamp(40px,5.2vw,86px)]">Two public ends.<br /><span className="text-coral">No line between.</span></h2>
        </div>
        <p className="max-w-[46ch] text-[clamp(14px,1.15vw,17px)] leading-relaxed text-paper/65 md:justify-self-end">
          Every transaction below is public. What you will not find is the one that joins your wallet to your fleet, because it
          was never sent. Private, not anonymous: Chit&apos;s operator can link them, and while the pool is small, amounts and
          timing can still line up.
        </p>
      </div>

      <div className="mx-auto mt-8 grid min-h-0 w-full max-w-wide flex-1 grid-cols-1 items-stretch gap-4 px-6 md:grid-cols-[1fr_120px_1fr] md:px-10">
        {/* your side */}
        <div className="flex flex-col rounded-card border border-paper/10 bg-paper/[0.035] p-6">
          <p className="eyebrow text-paper/50">Your wallet</p>
          <p className="mt-2 font-mono text-[15px] text-paper/80">0x7a3e…c914</p>
          <div className="my-auto hidden py-4 md:block">
            <p className="eyebrow text-paper/40">Deposit sizes</p>
            <div className="mt-3 flex gap-2">
              {["0.01", "0.05", "0.1"].map((v) => (
                <span key={v} className={`flex-1 rounded-inner border py-3 text-center font-mono text-[clamp(18px,1.8vw,26px)] tnum ${v === "0.05" ? "border-coral bg-coral text-ink" : "border-paper/10 text-paper/40"}`}>
                  {v}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-auto space-y-2">
            <div className="flex items-center justify-between gap-3 rounded-inner border border-coral/40 bg-coral/10 px-4 py-3 font-mono text-[13.5px]">
              <span className="text-paper/60">Deposit</span>
              <span className="tnum">0.05 ETH</span>
              <span className="text-coral">→ Chit pool</span>
            </div>
            <p className="text-[13px] text-paper/45">One of three fixed sizes, so it looks like every other deposit of its size.</p>
          </div>
        </div>

        {/* the seam itself */}
        <div className="relative hidden flex-col items-center justify-center md:flex">
          <svg viewBox="0 0 40 400" preserveAspectRatio="none" className="seam-pulse h-full w-10" aria-hidden="true">
            <polyline
              points={SEAM.map(([x, y]) => `${20 + (x - 50) * 3.2},${y * 4}`).join(" ")}
              fill="none"
              stroke="#FF5A3C"
              strokeWidth="2.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <p className="eyebrow absolute top-1/2 w-[112px] -translate-y-1/2 rounded-inner border border-coral/40 bg-void px-2 py-2 text-center text-[10px] leading-relaxed tracking-[0.18em] text-coral">
            no tx<br />crosses
          </p>
        </div>

        {/* the fleet's side */}
        <div className="flex flex-col rounded-card border border-paper/10 bg-paper/[0.035] p-6">
          <p className="eyebrow text-paper/50">Chit pool</p>
          <p className="mt-2 font-mono text-[15px] text-paper/80">0xce92…00c9</p>
          <div className="mt-auto space-y-2">
            {FLEET.slice(0, rows).map((a, i) => (
              <div key={`${a}-${shown > FLEET.length ? "h" : "r"}`} className="row-in flex items-center justify-between gap-3 rounded-inner border border-live/25 bg-live/[0.07] px-4 py-2.5 font-mono text-[13px]">
                <span className="text-paper/60">Fund</span>
                <span className="tnum">0.01 ETH</span>
                <span className="text-live">→ {a}</span>
                <span className="hidden text-paper/40 lg:inline">After {3 + i * 2} min</span>
              </div>
            ))}
            {rows === 0 && <p className="text-[13px] text-paper/40">Waiting a random one to fifteen minutes…</p>}
            <p className="pt-1 text-[13px] text-paper/45">Each draw waits its own random delay before it is funded.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ================================================================
   03 · bounded by contract
   ================================================================ */

const LIMITS = [
  {
    name: "Funding delay",
    fig: "60",
    unit: "sec floor",
    said: "The shortest wait the contract accepts between a deposit and the draw it funds. Chit's service picks a longer one, up to fifteen minutes, at random.",
    code: ["MIN_FUNDING_DELAY = 60", "openDraw → DelayTooShort", "fund → NotDue"],
  },
  {
    name: "Draw cap",
    fig: "0.05",
    unit: "ETH per campaign",
    said: "The most any one campaign can pull from the pool, whatever the operator asks for. Principal moves one buy at a time, just before that buy.",
    code: ["DRAW_CAP = 0.05 ether", "openDraw → DrawCapExceeded", "fundPrincipal → DrawExceeded"],
  },
  {
    name: "Self-serve exit",
    fig: "24",
    unit: "hours, then it's yours",
    said: "Two transactions Chit never signs. It works with the service offline and with the pool paused, and it cannot be shortened by you or by us.",
    code: ["EXIT_DELAY = 24 hours", "executeExit → ExitNotDue", "depositor only, no operator role"],
  },
  {
    name: "Pool cap",
    fig: "1",
    unit: "ETH, the whole pool",
    said: "The beta's ceiling, with 0.1 ETH per depositor. The most anyone can lose to a bug nobody has found yet is what the pool can hold.",
    code: ["poolCap = 1 ether", "perDepositor = 0.1 ether", "deposit → PoolCapExceeded"],
  },
  {
    name: "The brake",
    fig: "1",
    unit: "guardian, not the operator",
    said: "A second key that can only pause. It cannot move, draw or withdraw a thing, and a paused pool still lets every depositor leave.",
    code: ["setGuardian", "pause() → guardian only", "no guardian → deploy refused"],
  },
] as const;

const DWELL = 5200;

/** Counts a figure up from zero each time it changes, keeping its decimals ("0.05" stays two places). */
function CountUp({ value }: { value: string }) {
  const target = Number(value);
  const places = value.includes(".") ? value.split(".")[1]!.length : 0;
  const [n, setN] = useState(() => (typeof window === "undefined" ? target : 0));
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setN(target); return; }
    let raf = 0;
    const t0 = performance.now();
    const dur = 900;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      setN(target * (1 - Math.pow(2, -10 * k)));
      if (k < 1) raf = requestAnimationFrame(step);
      else setN(target);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return <>{n.toFixed(places)}</>;
}

export function Limits() {
  const [i, setI] = useState(0);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) {
      const back = setTimeout(() => setHeld(false), 20000);
      return () => clearTimeout(back);
    }
    const t = setTimeout(() => setI((n) => (n + 1) % LIMITS.length), DWELL);
    return () => clearTimeout(t);
  }, [i, held]);
  const l = LIMITS[i]!;

  return (
    <section id="limits" data-scene="Limits" className={`scene flex bg-void ${PAD}`}>
      <div className="mx-auto grid w-full max-w-wide grid-cols-1 gap-10 px-6 md:grid-cols-[1.35fr_1fr] md:px-10">
        <div className="flex flex-col justify-between gap-8">
          <div>
            <p className="eyebrow mb-4 text-coral">Bounded by contract, not by promise</p>
            <p className="max-w-[40ch] text-[15px] leading-relaxed text-paper/60">
              Each number is a constant in the pool contract with a revert that has a name. It bounds what a mistake, or a
              compromised key, can move. It does not make the operator trustless.
            </p>
          </div>
          <div key={i} className="row-in">
            <p className="display tnum text-[clamp(120px,22vw,340px)] text-coral" aria-label={l.fig} suppressHydrationWarning><CountUp value={l.fig} /></p>
            <p className="eyebrow mt-4 text-paper/70">{l.unit}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {l.code.map((c) => (
              <code key={c} className="rounded-inner border border-paper/10 bg-void/60 px-3 py-1.5 font-mono text-[12.5px] text-paper/75">
                {c}
              </code>
            ))}
          </div>
        </div>

        <div className="flex flex-col justify-center">
          {LIMITS.map((x, n) => (
            <button
              key={x.name}
              type="button"
              onClick={() => { setI(n); setHeld(true); }}
              aria-pressed={n === i}
              className="group relative border-b border-paper/10 py-5 text-left first:border-t"
            >
              <span className="flex items-baseline gap-4">
                <span className={`font-mono text-[12px] ${n === i ? "text-coral" : "text-paper/35"}`}>0{n + 1}</span>
                <span className={`font-display text-[clamp(22px,2.3vw,34px)] font-bold tracking-[-0.04em] transition-colors duration-200 ${n === i ? "text-paper" : "text-paper/35 group-hover:text-paper/70"}`}>
                  {x.name}
                </span>
              </span>
              {n === i && (
                <>
                  <span className="row-in mt-3 block max-w-[46ch] pl-9 text-[14px] leading-relaxed text-paper/60">{x.said}</span>
                  <span className="absolute inset-x-0 -bottom-px h-px overflow-hidden">
                    <span key={`${i}-${held}`} className={`block h-full bg-coral ${held ? "" : "fill-bar"}`} style={{ animationDuration: `${DWELL}ms` }} />
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ================================================================
   04 · the bot, in its own phone
   ================================================================ */

/** The chat plays once when the phone comes into view: you paste a token, the bot reads it, the card lands. */
function useChatStep(ref: React.RefObject<HTMLElement>) {
  const [step, setStep] = useState(3);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const io = new IntersectionObserver(([e]) => {
      if (!e?.isIntersecting) return;
      io.disconnect();
      setStep(0);
      timers = [setTimeout(() => setStep(1), 500), setTimeout(() => setStep(2), 1200), setTimeout(() => setStep(3), 2300)];
    }, { threshold: 0.6 });
    io.observe(el);
    return () => { io.disconnect(); timers.forEach(clearTimeout); };
  }, [ref]);
  return step;
}

function Phone() {
  const keys = [["Buy 0.01", "Buy 0.05", "Buy 0.1"], ["Limit buy", "DCA"], ["Sell 25%", "Sell 100%"], ["📸 Share", "↻ Refresh"]];
  const ref = useRef<HTMLDivElement>(null);
  const step = useChatStep(ref);
  return (
    <div ref={ref} className="relative mx-auto aspect-[9/18.5] h-[min(640px,calc(100dvh-210px))] rounded-[46px] border border-paper/15 bg-[#0e0d0c] p-2.5 shadow-[0_40px_120px_-30px_rgba(255,90,60,0.35)]">
      <div className="flex h-full flex-col overflow-hidden rounded-[38px] bg-[#131211]">
        <div className="flex items-center gap-3 border-b border-paper/10 px-5 pb-3 pt-7">
          <Mark className="h-8 w-8" />
          <div>
            <p className="text-[14px] font-semibold leading-tight">Chit Bot</p>
            <p className="text-[11px] text-paper/45">{step === 2 ? "typing…" : "bot"}</p>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-hidden p-3">
          <p className="self-center rounded-full bg-paper/[0.06] px-3 py-1 text-[10px] text-paper/45">Today</p>
          {step >= 1 && (
            <div className="row-in max-w-[82%] self-end break-all rounded-[16px] rounded-br-[6px] bg-coral-deep px-3.5 py-2.5 font-mono text-[10.5px] leading-snug text-[#FFE7E0]">
              0xd523a627030509021cc39b6d7c8543417d3e50d8
              <span className="mt-1 block text-right text-[9px] text-[#FFE7E0]/60">12:04 ✓✓</span>
            </div>
          )}
          {step === 2 && (
            <div className="row-in flex w-fit gap-1 rounded-[16px] rounded-bl-[6px] bg-[#1e1c1a] px-4 py-3" aria-label="The bot is reading the token">
              {[0, 1, 2].map((d) => <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-paper/50" style={{ animationDelay: `${d * 140}ms` }} />)}
            </div>
          )}
          {step >= 3 && (<>
          <div className="row-in rounded-[16px] rounded-bl-[6px] bg-[#1e1c1a] p-3.5 text-[11.5px] leading-[1.55]">
            <p className="font-semibold text-paper">$CHIT <span className="font-mono font-normal text-paper/50">· 0xd523…50d8</span></p>
            <p className="mt-1 text-paper/70">Price <span className="font-mono">10,738,347</span> per ETH · pool <span className="font-mono">9.53 ETH</span></p>
            <p className="mt-2 text-paper/70"><span className="text-[#C7F24A]">Orus:</span> Honeypot unknown · bundled 29% · top 10 hold 25% · 502 holders</p>
            <p className="mt-1 text-paper/70"><span className="text-paper">Hey Research Lab:</span> Shipping · 204 commits · verified builder</p>
            <p className="mt-1 text-paper/70"><span className="text-live">Eyebrow:</span> Toolchain locked and signed, clean</p>
            <p className="mt-2 text-paper/70">Your account holds <span className="font-mono">18.4M CHIT</span></p>
          </div>
          <div className="row-in space-y-1.5" style={{ animationDelay: "160ms" }}>
            {keys.map((row) => (
              <div key={row.join()} className="flex gap-1.5">
                {row.map((k) => (
                  <span key={k} className={`flex-1 rounded-[10px] py-2 text-center text-[11px] ${k.startsWith("Buy") ? "bg-coral/90 font-medium text-ink" : "bg-paper/10 text-paper/85"}`}>{k}</span>
                ))}
              </div>
            ))}
          </div>
          </>)}
        </div>
      </div>
    </div>
  );
}

const BOT = [
  { k: "Your keys", v: "The bot trades from an account you own, inside a session you set and pull back in one transaction." },
  { k: "Three readings", v: "Orus on safety and Hey Research Lab on the builder, on every token before you buy. Eyebrow on our own toolchain." },
  { k: "Orders", v: "Limit buys and DCA that fire on your session while you sleep." },
  { k: "Proof", v: "Tap 📸 and a position becomes a picture: what you paid, what the pool would fill, your link on it." },
];

export function BotScene({ hero = false }: { hero?: boolean }) {
  const Heading = hero ? "h1" : "h2";
  return (
    <section id="bot" data-scene="The bot" className={`scene flex bg-surface ${PAD}`}>
      <div className="pointer-events-none absolute -right-[10vw] top-1/2 h-[80vh] w-[60vw] -translate-y-1/2 rounded-full bg-coral/10 blur-[120px]" />
      <div className="relative mx-auto grid w-full max-w-wide grid-cols-1 items-center gap-10 px-6 md:grid-cols-[1.15fr_1fr] md:px-10">
        <div>
          <p className="eyebrow mb-4 text-coral">@usechit_bot</p>
          <Heading className="display text-[clamp(44px,6.6vw,108px)]">
            Trade the chain
            <br />
            from Telegram.
            <br />
            <span className="text-coral">Keys and all.</span>
          </Heading>
          <dl className="mt-10 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
            {BOT.map((b) => (
              <div key={b.k} className="border-t border-paper/15 pt-4">
                <dt className="font-display text-[20px] font-bold tracking-[-0.03em]">{b.k}</dt>
                <dd className="mt-1.5 text-[14px] leading-relaxed text-paper/60">{b.v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <Phone />
      </div>
    </section>
  );
}

/* ================================================================
   05 · the burn
   ================================================================ */

/** Total supply as a thousand squares, a tenth of a percent each; the burned ones glow. */
export function SupplyGrid({ burned = 9 }: { burned?: number }) {
  return (
    <div className="grid grid-cols-[repeat(50,minmax(0,1fr))] gap-[3px]" role="img" aria-label={`${burned} of 1,000 squares burned, ${burned / 10}% of total supply`}>
      {Array.from({ length: 1000 }, (_, i) => {
        const hot = i < burned;
        return (
          <span
            key={i}
            className={`aspect-square rounded-[2px] ${hot ? "cell-burn bg-coral" : "bg-paper/[0.09]"}`}
            style={hot ? { animationDelay: `${i * 170}ms` } : undefined}
          />
        );
      })}
    </div>
  );
}

export function BurnScene() {
  const live = useLive<Burn>("/api/burn", 60000);
  const secs = useSecondsTo(live?.nextDueAt);
  // Until the first reading lands, the figures are the reading taken when this page was built.
  const pct = Math.floor((live?.burnedOfMinted ?? 0.9954) * 100) / 100;
  const last = live?.events?.find((e) => e.kind === "burned");
  return (
    <section id="burn" data-scene="Burn" className={`scene flex bg-void ${PAD}`}>
      <div className="pointer-events-none absolute -left-[12vw] bottom-[-30vh] h-[70vh] w-[60vw] rounded-full bg-coral/[0.12] blur-[120px]" />

      <div className="relative mx-auto grid w-full max-w-wide grid-cols-1 items-center gap-12 px-6 md:px-10 lg:grid-cols-[1fr_1.1fr]">
        <div>
          <p className="eyebrow mb-4 flex items-center gap-2.5 text-coral">
            <span className="live-dot" /> The buyback, live from the chain
          </p>
          <p className="display tnum text-[clamp(96px,13vw,220px)] text-coral" aria-label={`${pct.toFixed(2)}%`} suppressHydrationWarning>
            <CountUp value={pct.toFixed(2)} />%
          </p>
          <p className="mt-5 max-w-[24ch] font-display text-[clamp(26px,2.6vw,40px)] font-bold leading-[1.02] tracking-[-0.04em]">
            Of the minted billion, bought and burned. Forever.
          </p>
          <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
            {[["Burned", `${fmtChit(live?.burned ?? "9954674974375619552110455")} CHIT`], ["Buys", String(live?.buys ?? 156)], ["ETH spent", fmtEth(live?.spent ?? "1030530982367212800", 2)]].map(([k, v]) => (
              <div key={k}>
                <dt className="eyebrow text-paper/45">{k}</dt>
                <dd className="mt-1 font-mono text-[18px] tnum">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-8 flex flex-wrap gap-2">
            <Link href="/burn" className="inline-flex items-center gap-2 rounded-full bg-coral py-2.5 pl-6 pr-2.5 text-[15px] font-medium text-ink transition-colors hover:bg-coral-lift">
              Watch it burn <span className="grid h-7 w-7 place-items-center rounded-full bg-ink text-paper" aria-hidden="true">→</span>
            </Link>
          </div>
        </div>

        <div className="rounded-card border border-paper/10 bg-surface p-5 md:p-7">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow text-paper/45">The minted billion</p>
              <p className="mt-1.5 text-[14px] text-paper/60">1,000 squares, each one 0.1%</p>
            </div>
            <div className="flex gap-4 text-[12.5px] text-paper/60">
              <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-[2px] bg-coral" />Burned</span>
              <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-[2px] bg-paper/20" />Still out there</span>
            </div>
          </div>
          <SupplyGrid burned={Math.max(1, Math.round(pct * 10))} />
          <div className="mt-6 grid grid-cols-1 gap-px overflow-hidden rounded-inner border border-paper/10 bg-paper/10 sm:grid-cols-2">
            <div className="bg-surface p-4">
              <p className="eyebrow text-paper/45" suppressHydrationWarning>{secs === 0 ? "Next call" : "Next call opens in"}</p>
              <p className="mt-1.5 font-mono text-[22px] tnum text-coral" suppressHydrationWarning>{secs === 0 ? "Open now" : mmss(secs)}</p>
              <p className="mt-1 text-[12.5px] text-paper/50">Once an hour, anyone can call it</p>
            </div>
            <div className="bg-surface p-4">
              <p className="eyebrow text-paper/45">Last burn</p>
              {last ? (
                <>
                  <p className="mt-1.5 font-mono text-[15px] tnum">{fmtEth(last.ethIn, 4)} ETH → {fmtChit(last.burned)} CHIT</p>
                  <a href={`${live?.explorer ?? "https://robinhoodchain.blockscout.com"}/tx/${last.tx}`} className="mt-1 inline-block text-[12.5px] text-paper/50 underline decoration-paper/20 underline-offset-4 hover:text-paper" suppressHydrationWarning>
                    {ago(last.at)} · see it on the explorer
                  </a>
                </>
              ) : (
                <p className="mt-1.5 text-[13px] text-paper/50">Reading the chain…</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ================================================================
   06 · launch
   ================================================================ */

function CopyChip({ label, value }: { label: string; value: string }) {
  const [said, setSaid] = useState("Copy");
  return (
    <span className="inline-flex items-center gap-3 rounded-full border border-paper/15 bg-paper/[0.04] py-1.5 pl-4 pr-1.5">
      <code className="font-mono text-[13px] text-paper/75">{label}</code>
      <button
        type="button"
        className="rounded-full bg-paper/10 px-3.5 py-1.5 text-[12.5px] transition-colors hover:bg-paper/20"
        onClick={async () => {
          try { await navigator.clipboard.writeText(value); setSaid("Copied"); } catch { setSaid(value); }
          setTimeout(() => setSaid("Copy"), 1800);
        }}
      >
        {said}
      </button>
    </span>
  );
}

export function Launch({ tone = "surface" }: { tone?: "surface" | "void" }) {
  return (
    <footer id="launch" data-scene="Launch" className={`footer-snap relative ${tone === "void" ? "bg-void" : "bg-surface"}`}>
      {/* who reads on the bot card, as a strip that never stops, right above the way in */}
      <div className="marquee-hover relative overflow-hidden border-y border-paper/10 py-5 [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
        <p className="eyebrow mb-3 text-center text-paper/40">On the bot card</p>
        <div className="marquee" style={{ ["--marquee-s" as string]: "26s" }}>
          {[0, 1].map((copy) => (
            <div key={copy} className="flex shrink-0 items-center gap-10 pr-10" aria-hidden={copy === 1}>
              {["Orus", "Hey Research Lab", "Eyebrow", "Orus", "Hey Research Lab", "Eyebrow"].map((w, i) => (
                <span key={`${w}-${i}`} className="flex items-center gap-10">
                  <span className={`display whitespace-nowrap text-[clamp(28px,3.4vw,52px)] ${i % 2 ? "outline-text" : "text-paper/85"}`}>{w}</span>
                  <span className="h-2.5 w-2.5 rotate-45 bg-coral" />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-wide grid-cols-1 gap-12 px-6 pb-8 pt-14 md:px-10 lg:grid-cols-[1.3fr_1fr] lg:pt-16">
        <div>
          <div className="flex items-center gap-4">
            <Mark className="h-14 w-14 rounded-[22%]" />
            <p className="eyebrow text-paper/50">Capped beta · holders only</p>
          </div>
          <h2 className="display mt-6 text-[clamp(48px,6.4vw,112px)]">Launch the app.</h2>
          <p className="mt-4 max-w-[48ch] text-[15px] leading-relaxed text-paper/60">
            Every limit on this page is enforced by the contract, and the caps stay until a professional audit is complete.
          </p>
          <div className="mt-7 flex flex-wrap gap-2">
            <a href={APP_HREF} className="flex items-center gap-2 rounded-full bg-coral py-2.5 pl-6 pr-2.5 text-[15px] font-medium text-ink transition-colors hover:bg-coral-lift">
              Open the app <span className="grid h-7 w-7 place-items-center rounded-full bg-ink text-paper" aria-hidden="true">→</span>
            </a>
            <a href="https://t.me/usechit_bot" className="rounded-full border border-paper/20 px-6 py-2.5 text-[15px] font-medium transition-colors hover:border-paper">
              Open @usechit_bot
            </a>
          </div>
          <div className="mt-5">
            <CopyChip label="$CHIT 0xD523…50D8" value="0xD523A627030509021cC39B6d7C8543417D3E50D8" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:pt-4">
          {[
            ["Product", [["Home", "/"], ["The bot", "/bot"], ["Burn", "/burn"], ["Open the app", APP_HREF]]],
            ["Community", [["Telegram", "https://t.me/usechittools"], ["@usechit_bot", "https://t.me/usechit_bot"]]],
            ["On chain", [["Explorer", "https://robinhoodchain.blockscout.com"], ["$CHIT contract", "https://robinhoodchain.blockscout.com/token/0xD523A627030509021cC39B6d7C8543417D3E50D8"], ["Buyback contract", "https://robinhoodchain.blockscout.com/address/0xe5a7dbd4fd12edfb5b2c1e584b5d1ea9131f8b64"]]],
          ].map(([title, links]) => (
            <nav key={title as string} aria-label={title as string}>
              <p className="eyebrow text-paper/40">{title as string}</p>
              <ul className="mt-4 space-y-2.5">
                {(links as string[][]).map(([label, href]) => (
                  <li key={label}>
                    {href.startsWith("/") ? (
                      <Link href={href} className="text-[14.5px] text-paper/70 transition-colors hover:text-paper">{label}</Link>
                    ) : (
                      <a href={href} className="text-[14.5px] text-paper/70 transition-colors hover:text-paper">{label}</a>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-wide flex-col gap-3 border-t border-paper/10 px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-6 text-[12.5px] leading-relaxed text-paper/40 md:px-10 lg:flex-row lg:justify-between lg:gap-10">
        <p className="max-w-[70ch]">{FACTS.join(" ")}</p>
        <p className="max-w-[56ch] lg:text-right">
          Chit is independent and not affiliated with, sponsored by, or endorsed by Robinhood, Uniswap, or any other project named here.
        </p>
      </div>
    </footer>
  );
}

/** The hero's live line: the burn, read from the chain, on the first screen. */
function HeroPulse() {
  const live = useLive<Burn>("/api/burn", 60000);
  const secs = useSecondsTo(live?.nextDueAt);
  const pct = Math.floor((live?.burnedOfMinted ?? 0.9954) * 100) / 100;
  return (
    <p className="flex min-h-6 items-center gap-2.5 font-mono text-[11px] uppercase leading-snug tracking-[0.16em] text-paper/70 md:whitespace-nowrap md:text-[12px] md:tracking-[0.18em]">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full bg-coral/60" />
        <span className="relative h-2 w-2 rounded-full bg-coral" />
      </span>
      <span>
        $CHIT {pct.toFixed(2)}% burned
        <span className="hidden md:inline" suppressHydrationWarning> · {secs === 0 ? "buyback open now" : `next buyback ${mmss(secs)}`}</span>
      </span>
    </p>
  );
}
