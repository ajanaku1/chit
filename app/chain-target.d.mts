/** Types for chain-target.mjs, which the build runs as plain JavaScript. */
export type ChainTarget = {
  pool?: string;
  chainId: number;
  chainName: string;
  rpcUrls: string[];
  caps: { depositor: string; draw: string; pool: string };
  beta: boolean;
  betaNote: string;
  betaFacts: string[];
  buyChitUrl: string;
  testnetUrl: string;
};
export const GATE_SENTENCE: string;
export const CAPS_UNTIL_AUDIT: string;
export function betaFacts(poolCap: string): string[];
export function withCaps(html: string, target: ChainTarget): string;
export function chainTargetFromEnv(env?: Record<string, string | undefined>): ChainTarget;
export type SessionTarget = { chainId: number; sessionFactory: string };
export function sessionTargetFromEnv(env?: Record<string, string | undefined>): SessionTarget;
export function withBetaNote(html: string, target: ChainTarget): string;
