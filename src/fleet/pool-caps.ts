/**
 * The pool's caps, as numbers the service and the scripts share.
 *
 * FleetPool takes its caps at deployment (immutable), so the same contract
 * runs on testnet with room to test and on mainnet as a capped beta. These
 * are the published sets; a pool's own `DEPOSITOR_CAP()`, `DRAW_CAP()` and
 * `POOL_CAP()` are the truth the service reads at boot and the app shows.
 */

import { parseEther } from "viem";

export type PoolCaps = { depositor: bigint; draw: bigint; pool: bigint };

/** Robinhood Chain testnet (46630): room to test. */
export const TESTNET_CAPS: PoolCaps = { depositor: parseEther("0.5"), draw: parseEther("0.2"), pool: parseEther("5") };

/**
 * Robinhood Chain mainnet (4663), the beta: small on purpose. The most the
 * pool ever holds is 1 ETH, so the most anyone can lose to a bug the firm
 * audit has not looked at yet is bounded, and said so.
 */
export const MAINNET_BETA_CAPS: PoolCaps = { depositor: parseEther("0.1"), draw: parseEther("0.05"), pool: parseEther("1") };

export const capsForChain = (chainId: number): PoolCaps => (chainId === 4663 ? MAINNET_BETA_CAPS : TESTNET_CAPS);

/** Caps from the environment, when a deploy wants numbers of its own; else the chain's published set. */
export const capsFromEnv = (chainId: number, env: NodeJS.ProcessEnv = process.env): PoolCaps => {
  const base = capsForChain(chainId);
  const read = (name: string, fallback: bigint): bigint => {
    const raw = env[name];
    if (!raw) return fallback;
    if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${name} must be an ETH amount like 0.1, got ${raw}`);
    return parseEther(raw);
  };
  return {
    depositor: read("FLEET_DEPOSITOR_CAP_ETH", base.depositor),
    draw: read("FLEET_DRAW_CAP_ETH", base.draw),
    pool: read("FLEET_POOL_CAP_ETH", base.pool),
  };
};
