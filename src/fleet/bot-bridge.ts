/**
 * The way in from another chain: Relay's cross-chain swap, one transaction
 * on the chain the user is on, ETH or CHIT delivered on Robinhood Chain.
 *
 * Nothing here moves money. The bot asks Relay which routes quote right
 * now, shows only those, and hands the user a link into Relay's own app
 * with the fields filled in; the transaction is theirs, from their wallet.
 * A route Relay does not quote (Arc into Robinhood Chain on Arc's first
 * day, for one) is simply not shown, never promised.
 *
 * Mainnet only by nature: CHIT and the money are on 4663. The playground
 * bot runs on testnet, and the card says so.
 */

import type { Address } from "./types.js";

export type BridgeOrigin = { id: number; name: string; /** What the chain's native coin is called, for the line. */ native: string; /** How Relay names the native coin on that chain; the zero address on EVM chains, the system program on Solana. */ currency: string };

/** Where people come from. Relay's own chain ids; Solana's is Relay's number for it. */
export const BRIDGE_ORIGINS: readonly BridgeOrigin[] = [
  { id: 1, name: "ethereum", native: "ETH", currency: "0x0000000000000000000000000000000000000000" },
  { id: 8453, name: "base", native: "ETH", currency: "0x0000000000000000000000000000000000000000" },
  { id: 42161, name: "arbitrum", native: "ETH", currency: "0x0000000000000000000000000000000000000000" },
  { id: 10, name: "optimism", native: "ETH", currency: "0x0000000000000000000000000000000000000000" },
  { id: 56, name: "bnb chain", native: "BNB", currency: "0x0000000000000000000000000000000000000000" },
  { id: 137, name: "polygon", native: "POL", currency: "0x0000000000000000000000000000000000000000" },
  { id: 792703809, name: "solana", native: "SOL", currency: "11111111111111111111111111111111" },
  { id: 5042, name: "arc", native: "USDC", currency: "0x0000000000000000000000000000000000000000" },
];

export const ROBINHOOD_CHAIN_ID = 4663;
export const CHIT_MAINNET: Address = "0xd523a627030509021cc39b6d7c8543417d3e50d8";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
/** The probe's `user` has to look like an address on the origin chain: Solana's is a base58 key (wSOL's mint, any valid key does). */
const PROBE_USER: Record<string, string> = { SOL: "So11111111111111111111111111111111111111112" };
const EVM_PROBE_USER = "0x000000000000000000000000000000000000dEaD";
/** A representative amount to ask a quote for: enough to be routable, small enough to mean nothing. */
const PROBE_AMOUNT: Record<string, string> = { ETH: "1000000000000000", BNB: "5000000000000000", POL: "10000000000000000000", SOL: "20000000", USDC: "5000000000000000000" };

export type BridgeRoute = {
  origin: BridgeOrigin;
  /** Native of the origin into ETH on Robinhood Chain quotes right now. */
  eth: boolean;
  /** Native of the origin straight into CHIT quotes right now. */
  chit: boolean;
  /** Relay's app with the fields filled in; the user signs there. */
  ethUrl: string;
  chitUrl: string;
};

export interface BotBridge {
  /** The routes that quote at this moment; cached briefly, so a card is one fetch a minute at most. */
  routes(): Promise<BridgeRoute[]>;
}

const appUrl = (origin: BridgeOrigin, toCurrency: Address): string =>
  `https://relay.link/bridge/robinhood?fromChainId=${origin.id}&fromCurrency=${origin.currency}&toCurrency=${toCurrency}`;

export const createRelayBridge = (fetchImpl: typeof fetch = fetch, cacheMs = 5 * 60_000): BotBridge => {
  let cache: { at: number; routes: BridgeRoute[] } | undefined;
  const quotes = async (origin: BridgeOrigin, toCurrency: Address): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const r = await fetchImpl("https://api.relay.link/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          user: PROBE_USER[origin.native] ?? EVM_PROBE_USER, recipient: EVM_PROBE_USER,
          originChainId: origin.id, destinationChainId: ROBINHOOD_CHAIN_ID,
          originCurrency: origin.currency, destinationCurrency: toCurrency,
          amount: PROBE_AMOUNT[origin.native] ?? PROBE_AMOUNT["ETH"], tradeType: "EXACT_INPUT",
        }),
      });
      if (!r.ok) return false;
      const body = (await r.json().catch(() => ({}))) as { errorCode?: string; steps?: unknown[] };
      return !body.errorCode && Array.isArray(body.steps);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async routes() {
      if (cache && Date.now() - cache.at < cacheMs) return cache.routes;
      const routes = await Promise.all(BRIDGE_ORIGINS.map(async (origin) => {
        const [eth, chit] = await Promise.all([quotes(origin, NATIVE), quotes(origin, CHIT_MAINNET)]);
        return { origin, eth, chit, ethUrl: appUrl(origin, NATIVE), chitUrl: appUrl(origin, CHIT_MAINNET) };
      }));
      cache = { at: Date.now(), routes };
      return routes;
    },
  };
};
