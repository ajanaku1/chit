/*
 * The chain this build is for, as next.config.mjs fixed it from app/chain-target.mjs. These are
 * constants in every bundle and in every prerendered page, so what a page says about its chain is
 * in its HTML before any script runs: the same guarantee app/build.mjs gives by writing it in.
 */

export type ChainTarget = {
  chainId: number;
  chainName: string;
  rpcUrls: string[];
  caps: { depositor: string; draw: string; pool: string };
  beta: boolean;
  betaNote: string;
  betaFacts: string[];
};

export const TARGET = JSON.parse(process.env.NEXT_PUBLIC_CHAIN_TARGET ?? "{}") as ChainTarget;
export const BETA = TARGET.beta === true;
/** The statement beside the deposit amount (FR-007): the note, whole. */
export const BETA_NOTE = TARGET.betaNote ?? "";
/** FR-006's facts and the caps-until-audit sentence, one span each, as withBetaNote writes them. */
export const BETA_STRIP = JSON.parse(process.env.NEXT_PUBLIC_BETA_STRIP ?? "[]") as string[];
/** T058: the gate is the interface's only, said once beside the deposit form. */
export const GATE_SENTENCE = process.env.NEXT_PUBLIC_GATE_SENTENCE ?? "";
/** Where the app lives for this deploy: empty is this site, otherwise the host that serves it (FLEET_APP_ORIGIN). */
export const APP_ORIGIN = (process.env.NEXT_PUBLIC_APP_ORIGIN ?? "").replace(/\/+$/, "");
/** The app's entry, on whichever host serves it, so the site can be one host and the app another. */
export const APP_HREF = `${APP_ORIGIN}/app/balance`;

/** The draw cap a page states before the pool has answered (FR-001, T059). */
export const DRAW_CAP = TARGET.caps?.draw ?? "";

/**
 * FR-006: on the beta, one strip before the masthead of every app page that nothing closes, hides
 * or scrolls past (the style is sticky), carrying the three facts. Rendered, not injected.
 */
export function BetaStrip() {
  if (!BETA) return null;
  return (
    <p id="beta-note" className="beta-note" role="note">
      <strong>Beta on {TARGET.chainName}.</strong>{" "}
      {BETA_STRIP.map((fact) => (
        <span key={fact}>{fact} </span>
      ))}
    </p>
  );
}
