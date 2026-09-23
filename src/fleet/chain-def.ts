/**
 * The chain, defined once (T041's other half).
 *
 * viem polls a receipt on an interval it takes from the chain's `blockTime`,
 * and falls back to four seconds for a chain that does not state one.
 * Robinhood Chain seals a block in about a quarter of a second (measured:
 * 286 ms on 46630, 102 ms on 4663), so a write that had landed was still
 * waited on for four seconds, once per write, in every path that sends one.
 * The fleet service was given a block time with T041; the sponsor route, the
 * bot's chain, its link reader, its session chain and its venue watcher each
 * had a `defineChain` of their own and kept the four seconds. This is the one
 * definition they all build on, and test/fleet/chain-def.test.ts keeps it the
 * only one.
 */
import { defineChain } from "viem";

/** Measured on both chains; the poll that follows from it is half of this. */
export const BLOCK_TIME_MS = 250;

export const MAINNET_CHAIN_ID = 4663;
export const TESTNET_CHAIN_ID = 46630;

/** What the chain is called. A testnet that calls itself the mainnet reads as mainnet in a log and in a wallet's prompt. */
export const chainName = (chainId: number): string =>
  chainId === MAINNET_CHAIN_ID ? "Robinhood Chain" : chainId === TESTNET_CHAIN_ID ? "Robinhood Chain Testnet" : `chain ${chainId}`;

export const robinhoodChain = (chainId: number, rpcUrl: string) =>
  defineChain({
    id: chainId,
    name: chainName(chainId),
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockTime: BLOCK_TIME_MS,
  });
