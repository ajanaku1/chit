"use client";

import { useEffect, useState } from "react";

const PAD = "pt-[112px] pb-[40px]";

/* ================================================================
   the keypad: paste a contract, everything else is a button
   ================================================================ */

const KEYS = [
  { k: "💰 Buy", t: "Buy", s: "Your three presets or a custom amount. Quoted from the pool with fee and price impact, guarded by your slippage setting, sent through the real Uniswap v4 router. The reply carries the hash.", ex: "Buy 0.01 · 0.05 · 0.1" },
  { k: "💸 Sell", t: "Sell", s: "25, 50 or 100% of a position, on a key you have let sell. Your account writes the router call itself, the ETH lands back in it, and no approval outlives the sale.", ex: "Let it sell: on, per key" },
  { k: "📊 Positions", t: "Positions", s: "Every token you hold and what each would fetch if sold right now, with the sell buttons on the row.", ex: "What the pool would fill" },
  { k: "🆕 New", t: "New pools", s: "The venue's newest ETH pools, read from the pool manager's own events over about a day, with a buy button wherever the bot can trade them.", ex: "Read from the chain" },
  { k: "⏱ Orders", t: "Limit buy and DCA", s: "Standing orders on your session, checked every five minutes. A limit never fills under the price you named, and three refusals in a row switch an order off.", ex: "0.02 at 1200000 · 0.01 every 4 hours, 6 times" },
  { k: "⭐ Leaders", t: "Follow a leader", s: "When a leader's buy lands, the same token is bought on your own session account, sized inside your caps and behind Orus's read. Sells are never mirrored, so your exit stays yours.", ex: "Only through recorded pools" },
  { k: "🔔 Alerts", t: "Big buys", s: "Buys of at least 0.5 ETH are posted to the group, and a buy over your own line is sent to you in private. The chain's facts and nothing else.", ex: "Read from the chain, not from us" },
  { k: "🌉 Bridge", t: "Bridge in", s: "The way in from Ethereum, Base, Arbitrum, Optimism, BNB, Polygon, Solana and more, through Relay. Only routes that quote right now are shown.", ex: "Sent from your own wallet" },
  { k: "📸 Share", t: "Share a win", s: "A position as a picture: the change as one big number, what you paid, what the pool would fill, and your referral link on it.", ex: "Costs from the bot's own record" },
  { k: "⚙️ Settings", t: "Settings", s: "Buy amounts, sell shares, slippage, confirm every trade. No priority fees and no MEV toggles: the chain has a sequencer, so none of that exists here.", ex: "Yours, per account" },
];

export function Keypad() {
  const [i, setI] = useState(0);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) {
      const back = setTimeout(() => setHeld(false), 20000);
      return () => clearTimeout(back);
    }
    const t = setTimeout(() => setI((n) => (n + 1) % KEYS.length), 4200);
    return () => clearTimeout(t);
  }, [i, held]);
  const k = KEYS[i]!;

  return (
    <section id="keys" data-scene="The buttons" className={`scene flex bg-void ${PAD}`}>
      <div className="mx-auto grid w-full max-w-wide grid-cols-1 content-center gap-10 px-6 md:px-10 lg:grid-cols-[1fr_1.05fr] lg:gap-14">
        <div className="flex flex-col justify-center">
          <p className="eyebrow mb-4 text-coral">The card</p>
          <h2 className="display text-[clamp(44px,5.4vw,92px)]">
            Paste a contract.
            <br />
            <span className="text-paper/35">The rest is a button.</span>
          </h2>
          <div key={i} className="row-in mt-8 min-h-[190px] rounded-card border border-paper/10 bg-surface p-6">
            <p className="eyebrow text-coral">{String(i + 1).padStart(2, "0")} / {KEYS.length}</p>
            <p className="mt-2 font-display text-[clamp(26px,2.4vw,36px)] font-bold tracking-[-0.04em]">{k.t}</p>
            <p className="mt-2 max-w-[52ch] text-[14.5px] leading-relaxed text-paper/65">{k.s}</p>
            <p className="mt-4 w-fit rounded-inner border border-paper/10 bg-void px-3 py-1.5 font-mono text-[12.5px] text-paper/70">{k.ex}</p>
          </div>
        </div>

        {/* the home card's keyboard, the way Telegram draws it */}
        <div className="flex flex-col justify-center">
          <div className="rounded-[28px] border border-paper/10 bg-[#131211] p-3 shadow-[0_40px_120px_-40px_rgba(255,90,60,0.35)] md:p-4">
            <div className="mb-3 rounded-[18px] bg-[#1e1c1a] p-4 font-mono text-[12.5px] leading-relaxed text-paper/70">
              <p className="text-paper">Robinhood Chain · 4663</p>
              <p>0x7a3e…c914 <span className="text-paper/40">(tap to copy)</span></p>
              <p>Balance: 0.42 ETH · 18.4M CHIT</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {KEYS.map((x, n) => (
                <button
                  key={x.k}
                  type="button"
                  onClick={() => { setI(n); setHeld(true); }}
                  aria-pressed={n === i}
                  className={`relative overflow-hidden rounded-[12px] px-3 py-3 text-center text-[13.5px] font-medium transition-all duration-200 md:text-[14.5px] ${n === i ? "bg-coral text-ink" : "bg-paper/[0.07] text-paper/85 hover:bg-paper/[0.12]"}`}
                >
                  {x.k}
                  {n === i && !held && <span key={i} className="fill-bar absolute inset-x-0 bottom-0 h-[3px] bg-ink/40" style={{ animationDuration: "4200ms" }} />}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-4 text-[13px] text-paper/45">Every figure is read from the chain when the card is drawn. Tap a key to hold it.</p>
        </div>
      </div>
    </section>
  );
}

/* ================================================================
   three readings, and what each one reads
   ================================================================ */

const READS = [
  {
    who: "Orus",
    on: "Safety, on every token",
    color: "text-[#C7F24A]",
    items: ["Honeypot", "Taxes", "Bundlers", "Top 10 share", "Holders", "Liquidity, and whether the LP is burned", "The deployer's launches"],
    note: "A blank from Orus reads as unknown, never as safe.",
  },
  {
    who: "Hey Research Lab",
    on: "The builder, on every token",
    color: "text-paper",
    items: ["Status: shipping or still building", "Commits in the last 30 days", "Releases in the last 30 days", "Verified builder"],
    note: "A missing field is skipped: unknown, never zero.",
  },
  {
    who: "Eyebrow",
    on: "Our own toolchain, on the $CHIT card",
    color: "text-live",
    items: ["Chit is written with AI coding agents", "Their skills, servers, hooks and rules, in a signed lockfile", "Checked on every push and every deploy"],
    note: "A drift is said as plainly as a clean result.",
  },
];

export function Readings() {
  return (
    <section id="readings" data-scene="Readings" className={`scene flex flex-col bg-surface ${PAD}`}>
      <div className="mx-auto flex w-full max-w-wide flex-wrap items-end justify-between gap-6 px-6 md:px-10">
        <div>
          <p className="eyebrow mb-4 text-coral">Before you buy</p>
          <h2 className="display text-[clamp(44px,5.6vw,96px)]">
            Three readings
            <br />
            on the card.
          </h2>
        </div>
        <p className="max-w-[44ch] text-[15px] leading-relaxed text-paper/60">
          Asked alongside the chain reads, so a card never waits on a partner alone. Each line links back to its source.
        </p>
      </div>
      <div className="mx-auto mt-10 grid w-full max-w-wide flex-1 grid-cols-1 gap-4 px-6 md:grid-cols-3 md:px-10">
        {READS.map((r) => (
          <article key={r.who} className="flex flex-col rounded-card border border-paper/10 bg-void p-6 md:p-7">
            <p className={`font-display text-[clamp(28px,2.6vw,40px)] font-bold tracking-[-0.045em] ${r.color}`}>{r.who}</p>
            <p className="eyebrow mt-2 text-paper/50">{r.on}</p>
            <ul className="mt-6 space-y-2.5">
              {r.items.map((x) => (
                <li key={x} className="flex gap-3 text-[14.5px] leading-snug text-paper/75">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rotate-45 bg-coral" />
                  {x}
                </li>
              ))}
            </ul>
            <p className="mt-auto border-t border-paper/10 pt-4 text-[13px] text-paper/50">{r.note}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ================================================================
   the session key, drawn as the Sessions page shows it
   ================================================================ */

const SETUP = [
  ["Create my account", "One per wallet, its address known before it exists. One transaction."],
  ["Fund it", "ETH from your wallet to the account. Take it back any time."],
  ["Grant a session", "The bot's key, the router it may call, how much per trade, how much in all, until when."],
  ["Watch it", "Every session shows its spend, its calls and its state, read from the chain."],
  ["Pause, resume, revoke", "Pause holds the key, revoke ends it for good. One transaction from your wallet."],
];

function Meter({ label, value, sub, pct, tone = "coral" }: { label: string; value: string; sub: string; pct: number; tone?: "coral" | "paper" }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <p className="eyebrow text-paper/50">{label}</p>
        <p className="whitespace-nowrap font-mono text-[15px] tnum">{value}</p>
      </div>
      <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-paper/10">
        <div className={`fill-bar h-full rounded-full ${tone === "coral" ? "bg-coral" : "bg-paper/60"}`} style={{ width: `${pct}%`, animationDuration: "1200ms" }} />
      </div>
      <p className="mt-1.5 text-[12.5px] text-paper/45">{sub}</p>
    </div>
  );
}

export function SessionKey() {
  return (
    <section id="session" data-scene="The key" className={`scene flex bg-void ${PAD}`}>
      <div className="mx-auto grid w-full max-w-wide grid-cols-1 content-center gap-10 px-6 md:px-10 lg:grid-cols-[1fr_1fr] lg:gap-14">
        <div className="flex flex-col justify-center">
          <p className="eyebrow mb-4 text-coral">A key with a ceiling</p>
          <h2 className="display text-[clamp(40px,4.8vw,84px)]">
            Other bots take your key.
            <br />
            <span className="text-coral">Chit gives you speed without it.</span>
          </h2>
          <ol className="mt-8 space-y-0">
            {SETUP.map(([t, s], n) => (
              <li key={t} className="grid grid-cols-[auto_1fr] gap-x-4 border-t border-paper/10 py-3.5 last:border-b">
                <span className="font-mono text-[12px] leading-[26px] text-coral">0{n + 1}</span>
                <div>
                  <p className="font-display text-[19px] font-bold tracking-[-0.03em]">{t}</p>
                  <p className="mt-0.5 text-[13.5px] leading-relaxed text-paper/55">{s}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="flex flex-col justify-center">
          <div className="rounded-card border border-paper/10 bg-surface p-6 md:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="eyebrow text-paper/45">Session key</p>
                <p className="mt-1 font-mono text-[15px]">@usechit_bot · 0x91c4…7e20</p>
              </div>
              <span className="flex items-center gap-2 rounded-full border border-live/30 bg-live/10 px-3 py-1 text-[12.5px] text-live">
                <span className="h-1.5 w-1.5 rounded-full bg-live" /> Active
              </span>
            </div>

            <div className="mt-7 space-y-6">
              <Meter label="Per trade" value="0.05 ETH" sub="The most one call can spend: a tenth of the total" pct={10} />
              <Meter label="Spent" value="0.12 / 0.5 ETH" sub="Every trade counts against it, and the key stops at the top" pct={24} />
              <Meter label="Time left" value="4 d 6 h of 7 d" sub="Then the key is dead, whatever is left" pct={61} tone="paper" />
            </div>

            <div className="mt-7 grid grid-cols-1 gap-3 border-t border-paper/10 pt-6 sm:grid-cols-2">
              <div>
                <p className="eyebrow text-paper/45">May call</p>
                <p className="mt-1.5 font-mono text-[13.5px] text-paper/80">Universal Router</p>
              </div>
              <div className="flex items-center justify-between gap-3 sm:justify-start">
                <div>
                  <p className="eyebrow text-paper/45">Let it sell</p>
                  <p className="mt-1.5 text-[13px] text-paper/60">Off until you switch it on</p>
                </div>
                <span className="relative h-6 w-11 shrink-0 rounded-full bg-paper/15" aria-hidden="true">
                  <span className="absolute left-1 top-1 h-4 w-4 rounded-full bg-paper/60" />
                </span>
              </div>
            </div>

            <div className="mt-7 flex gap-2">
              <span className="flex-1 rounded-full border border-paper/20 py-2.5 text-center text-[14px] font-medium">Pause</span>
              <span className="flex-1 rounded-full bg-coral py-2.5 text-center text-[14px] font-medium text-ink">Revoke in 1 tx</span>
            </div>
          </div>
          <p className="mt-4 text-[13px] text-paper/45">
            An example key. The figures are the beta&apos;s defaults, and every one is set per key by you on the Sessions page.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ================================================================
   built so a tap moves money once
   ================================================================ */

const ONCE = [
  ["Read, not remembered", "Every figure on a card is read from the chain when the card is drawn."],
  ["A real transaction", "Every trade is sent on chain, and the reply carries its hash."],
  ["Never sent twice", "A trade with no receipt in forty seconds is reported as still landing, with its hash, and the bot refuses to send it again."],
  ["One lock per wallet", "Two taps, or one tap delivered twice, cannot race on a nonce or spend twice."],
  ["No fee in the contract", "The session account has no Chit address in it and no operator. Its rules are on chain for anyone to read."],
  ["Proven on a fork", "A bot buys through its session, is refused outside it, is revoked, and the owner takes everything back."],
];

export function Once() {
  return (
    <section id="once" data-scene="Built careful" className={`scene flex flex-col bg-surface ${PAD}`}>
      <div className="mx-auto w-full max-w-wide px-6 md:px-10">
        <p className="eyebrow mb-4 text-coral">Under the buttons</p>
        <h2 className="display text-[clamp(44px,5.6vw,96px)]">
          Built so a tap
          <br />
          moves money once.
        </h2>
      </div>
      <div className="mx-auto mt-10 grid w-full max-w-wide flex-1 grid-cols-1 gap-px overflow-hidden border-y border-paper/10 bg-paper/10 sm:grid-cols-2 lg:grid-cols-3">
        {ONCE.map(([t, s], n) => (
          <div key={t} className="group flex flex-col gap-5 bg-surface p-6 transition-colors duration-300 hover:bg-[#1a1816] md:p-8">
            <span className="display text-[clamp(44px,4vw,64px)] text-paper/10 transition-colors duration-300 group-hover:text-coral">0{n + 1}</span>
            <div>
              <p className="font-display text-[clamp(22px,1.9vw,28px)] font-bold tracking-[-0.035em]">{t}</p>
              <p className="mt-2 max-w-[40ch] text-[14px] leading-relaxed text-paper/60">{s}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
