"use client";

import { useEffect, type ReactNode } from "react";

import { BetaStrip } from "./chain";

/*
 * The app's frame around each page, and the one place its logic is started. The logic is
 * chit-fleet's own (chit-fleet/app/src), unchanged: each page script finds its elements by id and
 * wires itself up the moment it is imported, so it is imported once, after the page is on screen.
 * Links between app pages are plain links on purpose: a page script runs once per page load.
 * What the page says about its chain (the beta strip, the notes, the caps) is rendered with it,
 * from components/chain.tsx, so it is in the HTML before the script is.
 */

export type AppPageName = "balance" | "fleet" | "fleet-dashboard" | "fleet-privacy" | "trade" | "sessions";

const LOAD: Record<AppPageName, () => Promise<unknown>> = {
  balance: () => import("@fleet-app/balance-page"),
  fleet: () => import("@fleet-app/fleet-page"),
  "fleet-dashboard": () => import("@fleet-app/fleet-dashboard"),
  "fleet-privacy": () => import("@fleet-app/fleet-privacy"),
  trade: () => import("@fleet-app/trade-page"),
  sessions: () => import("@fleet-app/sessions-page"),
};

const NAV: ReadonlyArray<readonly [AppPageName, string]> = [
  ["balance", "Balance"],
  ["fleet", "Set up"],
  ["trade", "Trade"],
  ["fleet-dashboard", "Control Room"],
  ["fleet-privacy", "Boundary"],
  ["sessions", "Sessions"],
];

function Masthead({ current }: { current: AppPageName }) {
  return (
    <header className="masthead">
      <a className="brand-lockup" href="/" aria-label="Chit home">
        <img src="/app/logo.svg" alt="" width={28} height={28} />
        <span>Chit</span>
      </a>
      <nav className="nav" id="fleet-nav" aria-label="Fleet pages">
        {NAV.map(([page, label]) => (
          <a key={page} href={`/app/${page}`} aria-current={page === current ? "page" : undefined}>{label}</a>
        ))}
      </nav>
      <button id="hdr-wallet" type="button" className="wallet-btn" data-state="disconnected" aria-label="Connect wallet">Connect wallet</button>
      <button className="burger" type="button" aria-label="Menu" aria-expanded="false" aria-controls="fleet-nav"><span></span><span></span><span></span></button>
      <div className="contract-row">
        <span className="contract-row__label">CHIT token</span>
        <code id="contract-address" title="0xD523A627030509021cC39B6d7C8543417D3E50D8"><span>0xD523A6</span><span className="sr-only">27030509021cC39B6d7C8543417D</span><span>3E50D8</span></code>
        <button id="copy-contract-address" type="button" aria-label="Copy CHIT token address">
          <svg className="contract-row__icon contract-row__icon--copy" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9h10v10H9z" /><path d="M5 15V5h10" /></svg>
          <svg className="contract-row__icon contract-row__icon--done" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          <span className="contract-row__action">Copy</span>
        </button>
        <span id="copy-contract-status" className="sr-only" role="status" aria-live="polite"></span>
      </div>
    </header>
  );
}

export function AppPage({ page, skip, children }: { page: AppPageName; skip: { href: string; label: string } | null; children: ReactNode }) {
  useEffect(() => {
    void LOAD[page]();
  }, [page]);

  return (
    <>
      {skip && <a className="skip-link" href={skip.href}>{skip.label}</a>}
      <div className="fleet-shell">
        <BetaStrip />
        <Masthead current={page} />
        {children}
      </div>
    </>
  );
}
