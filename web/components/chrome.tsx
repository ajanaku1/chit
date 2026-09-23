"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { Mark } from "./mark";

/* ---------- the scroll surface, shared with anything that reacts to scroll ---------- */

const StageContext = createContext<RefObject<HTMLElement> | null>(null);
export const useStage = () => useContext(StageContext);

export function Stage({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  // Screens below the first wait closed on the seam and tear open the first time they come into view.
  useEffect(() => {
    const root = ref.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const els = [...root.querySelectorAll<HTMLElement>("[data-scene]")].slice(1);
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement;
        if (e.isIntersecting && e.intersectionRatio >= 0.3) { el.dataset.tear = "in"; io.unobserve(el); }
      }
    }, { root, threshold: [0, 0.3] });
    for (const el of els) {
      const box = el.getBoundingClientRect();
      if (box.top >= window.innerHeight * 0.7) { el.dataset.tear = "wait"; io.observe(el); }
    }
    return () => io.disconnect();
  }, []);
  return (
    <StageContext.Provider value={ref}>
      <main ref={ref} className="stage">{children}</main>
    </StageContext.Provider>
  );
}

/** How far a scene has scrolled out of view, 0 at rest to 1 when it has left. */
export function useSceneExit(scene: RefObject<HTMLElement>) {
  const stage = useStage();
  const [p, setP] = useState(0);
  useEffect(() => {
    const el = stage?.current;
    if (!el) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const box = scene.current;
      if (!box) return;
      const top = box.offsetTop;
      const h = box.offsetHeight || 1;
      setP(Math.min(1, Math.max(0, (el.scrollTop - top) / h)));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(read); };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, [stage, scene]);
  return p;
}

/* ---------- header: a floating bar that reads on coral and on void alike ---------- */

const NAV = [
  { href: "/", label: "Home" },
  { href: "/bot", label: "The bot" },
  { href: "/burn", label: "Burn" },
];

export function Header({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  return (
    <>
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-[max(14px,env(safe-area-inset-top))]">
      <div className="pointer-events-auto flex w-full max-w-wide items-center justify-between gap-4 rounded-full border border-paper/10 bg-void/70 py-2 pl-3 pr-2 backdrop-blur-xl">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="grid h-9 w-9 place-items-center rounded-full md:hidden"
          >
            <span className="relative block h-3 w-4">
              <span className={`absolute left-0 h-[2px] w-4 rounded bg-paper transition-transform duration-300 ${open ? "top-[5px] rotate-45" : "top-0"}`} />
              <span className={`absolute left-0 top-[5px] h-[2px] w-4 rounded bg-paper transition-opacity duration-200 ${open ? "opacity-0" : ""}`} />
              <span className={`absolute left-0 h-[2px] w-4 rounded bg-paper transition-transform duration-300 ${open ? "top-[5px] -rotate-45" : "top-[10px]"}`} />
            </span>
          </button>
          <Link href="/" className="flex items-center gap-2.5" aria-label="Chit, home">
            <Mark className="h-8 w-8" />
            <span className="font-display text-[20px] font-bold tracking-[-0.05em]">chit</span>
          </Link>
        </div>
        <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={current === n.href ? "page" : undefined}
              className="rounded-full px-4 py-2 text-[14px] text-paper/60 transition-colors duration-200 hover:text-paper aria-[current=page]:bg-paper/10 aria-[current=page]:text-paper"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <a href="/app/balance" className="flex items-center gap-2 whitespace-nowrap rounded-full bg-coral py-2 pl-5 pr-2 text-[14px] font-medium text-ink transition-colors duration-200 hover:bg-coral-lift">
          Launch app
          <span className="grid h-7 w-7 place-items-center rounded-full bg-ink text-paper" aria-hidden="true">→</span>
        </a>
      </div>
    </header>

    {/* phones: the whole screen becomes the menu, links rising in one after another */}
    <div
      id="menu"
      className={`fixed inset-0 z-40 flex flex-col justify-between bg-coral px-6 pb-[max(32px,env(safe-area-inset-bottom))] pt-[110px] text-ink transition-[clip-path] duration-500 ease-out md:hidden ${open ? "[clip-path:inset(0_0_0_0)]" : "pointer-events-none [clip-path:inset(0_0_100%_0)]"}`}
      aria-hidden={!open}
    >
      <nav aria-label="Menu" className="flex flex-col gap-1">
        {NAV.map((n, i) => (
          <Link
            key={n.href}
            href={n.href}
            onClick={() => setOpen(false)}
            tabIndex={open ? 0 : -1}
            className={`display flex items-baseline gap-4 py-1 text-[clamp(56px,17vw,96px)] ${open ? "rise-in" : "opacity-0"}`}
            style={{ animationDelay: `${140 + i * 80}ms` }}
          >
            <span className="font-mono text-[12px] font-normal tracking-normal text-ink/60">0{i + 1}</span>
            {n.label}
            {current === n.href && <span className="h-3 w-3 rotate-45 bg-ink" aria-label="Current page" />}
          </Link>
        ))}
      </nav>
      <div className={`flex flex-col gap-3 text-[15px] ${open ? "rise-in" : "opacity-0"}`} style={{ animationDelay: "420ms" }}>
        <a href="https://t.me/usechit_bot" tabIndex={open ? 0 : -1} className="font-medium underline decoration-ink/30 underline-offset-4">Open @usechit_bot</a>
        <a href="https://t.me/usechittools" tabIndex={open ? 0 : -1} className="font-medium underline decoration-ink/30 underline-offset-4">Telegram</a>
      </div>
    </div>
    </>
  );
}

/* ---------- the beta facts, said once in the footer ---------- */

export const FACTS = [
  "Beta on Robinhood Chain.",
  "The pool is capped at 1 ETH.",
  "The contracts have not been audited by a firm.",
  "Chit's operator key can move what is in the pool, up to that cap.",
  "The caps stay until a professional audit is complete.",
];

/* ---------- where you are: one dot per screen, named on hover ---------- */

export function SceneDots() {
  const stage = useStage();
  const [scenes, setScenes] = useState<{ id: string; label: string }[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const root = stage?.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>("[data-scene]")];
    setScenes(els.map((e) => ({ id: e.id, label: e.dataset.scene ?? "" })));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(els.indexOf(e.target as HTMLElement));
      },
      { root, threshold: 0.55 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [stage]);

  return (
    <nav aria-label="Screens" className="fixed right-4 top-1/2 z-40 hidden -translate-y-1/2 flex-col gap-3 rounded-full border border-paper/10 bg-void/60 px-2 py-3 backdrop-blur-md lg:flex">
      {scenes.map((s, i) => (
        <a key={s.id} href={`#${s.id}`} className="group relative flex items-center justify-center" aria-current={i === active ? "true" : undefined} aria-label={s.label}>
          <span className="eyebrow pointer-events-none absolute right-[calc(100%+14px)] whitespace-nowrap rounded-full bg-void/80 px-3 py-1.5 text-paper/80 opacity-0 transition-opacity duration-200 group-hover:opacity-100">{s.label}</span>
          <span className={`block w-2 rounded-full transition-all duration-300 ${i === active ? "h-6 bg-coral" : "h-2 bg-paper/30 group-hover:bg-paper/60"}`} />
        </a>
      ))}
    </nav>
  );
}
