/**
 * What the service refuses to start without on mainnet (T047, FR-023,
 * FR-032, FR-043). On testnet each of these has a default or a warning; on
 * 4663 a default is a way to lose money quietly: a memory store lets a retry
 * on a second instance pay twice, an open sweep endpoint lets anyone sign
 * with the operator's key, and no allowlist lets a sponsored buy target any
 * token. The fault names the variable, and the routes answer 503 with it.
 */

type Env = Record<string, string | undefined>;

export const MAINNET_CHAIN_ID = 4663;

const REQUIRED_ON_MAINNET: readonly [name: string, why: string][] = [
  ["DATABASE_URL", "the shared store: without it a retry on a second instance can pay twice"],
  ["CRON_SECRET", "the sweep's bearer: without it anyone can make the operator sign"],
  ["FLEET_TOKEN_ALLOWLIST", "the tokens a sponsored buy may target: without it, any token"],
];

/** The first thing missing, in the caller's words, or undefined when the chain is not mainnet or nothing is. */
export const mainnetPreflight = (chainId: number, env: Env): string | undefined => {
  if (chainId !== MAINNET_CHAIN_ID) return undefined;
  for (const [name, why] of REQUIRED_ON_MAINNET) {
    const value = env[name];
    if (!value || value.trim() === "") return `FLEET_CHAIN_ID=${MAINNET_CHAIN_ID} needs ${name}: ${why}`;
  }
  return undefined;
};
