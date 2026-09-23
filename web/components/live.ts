"use client";

import { useEffect, useState } from "react";

export type BurnEvent = { block: number; at: number; tx: string; kind: "funded" | "burned" | string; amount?: string; ethIn?: string; bought?: string; burned?: string; totalBurned?: string };
export type Burn = {
  burnedOfMinted: number; burned: string; buys: number; received: string; spent: string; balance: string; supply: string;
  nextDueAt: number; nextSpend: string; readAt: number; stale: boolean; explorer: string; events: BurnEvent[];
};
export type Progress = { tasks: { done: number; total: number; percent: number }; stages: { stage: number; name: string; status: string }[]; commits: number; committedAt: string };

/** Polls one of the site's own read endpoints; null until the first good answer, and the last good answer after that. */
export function useLive<T>(url: string, everyMs = 60000) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok && alive) setData(await r.json());
      } catch { /* keep the last good reading */ }
    };
    read();
    const t = setInterval(read, everyMs);
    return () => { alive = false; clearInterval(t); };
  }, [url, everyMs]);
  return data;
}

/** Seconds until a unix time, ticking once a second. */
export function useSecondsTo(at: number | undefined) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  return at === undefined ? undefined : Math.max(0, Math.round(at - now));
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const wei = (v: string | undefined) => (v ? Number(BigInt(v)) / 1e18 : 0);
export const fmtEth = (v: string | undefined, dp = 3) => wei(v).toFixed(dp);
export const fmtChit = (v: string | undefined) => {
  const n = wei(v);
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0);
};
export const ago = (at: number) => {
  const s = Math.max(0, Date.now() / 1000 - at);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
export const mmss = (s: number | undefined) => (s === undefined ? "--:--" : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`);
