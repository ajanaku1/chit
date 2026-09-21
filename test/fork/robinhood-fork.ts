import { network } from "hardhat";

/**
 * A fork of Robinhood Chain testnet at a block the public RPC can still serve.
 *
 * The RPC keeps state for roughly 6,900 blocks and blocks land every 0.16s, so
 * a block number committed to `hardhat.config.ts` stops being servable about
 * eighteen minutes after it is written. Every fresh clone then fails
 * `fleet-venue` with `metadata is not found`, and the gate was only ever green
 * on a machine that still had the fork state cached from a day it worked.
 *
 * So the block is not committed. It is chosen here, at connect time, a short
 * margin behind the tip: pinned, so EDR caches remote state for the run and
 * does not burst the RPC, but never stale. A run that needs reproducing sets
 * `ROBINHOOD_FORK_BLOCK` to the number this printed, and gets the same fork
 * for as long as the RPC still serves it.
 */

const RPC_URL = process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const MAINNET_RPC_URL = process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

/** Far enough behind the tip that the node has surely finalised the state; a few seconds of chain. */
const MARGIN_BLOCKS = 64;

/** Reads the tip with a plain fetch: the fork does not exist yet, so there is no client to ask. */
const latestBlock = async (rpcUrl = RPC_URL): Promise<number> => {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  if (!response.ok) throw new Error(`robinhood testnet rpc answered ${response.status} to eth_blockNumber`);
  const { result, error } = (await response.json()) as { result?: string; error?: { message?: string } };
  if (typeof result !== "string") throw new Error(`robinhood testnet rpc refused eth_blockNumber: ${error?.message ?? "no result"}`);
  return Number.parseInt(result, 16);
};

export const resolveForkBlock = async (): Promise<number> => {
  const pinned = process.env.ROBINHOOD_FORK_BLOCK;
  if (pinned !== undefined && pinned !== "") {
    const block = Number(pinned);
    if (!Number.isInteger(block) || block <= 0) throw new Error(`ROBINHOOD_FORK_BLOCK must be a positive block number, got ${pinned}`);
    return block;
  }
  return (await latestBlock()) - MARGIN_BLOCKS;
};

/** Connects a fork of Robinhood Chain mainnet (4663), a margin behind its tip; ROBINHOOD_MAINNET_FORK_BLOCK replays one. */
export const connectRobinhoodMainnetFork = async () => {
  const pinned = process.env.ROBINHOOD_MAINNET_FORK_BLOCK;
  const blockNumber = pinned ? Number(pinned) : (await latestBlock(MAINNET_RPC_URL)) - MARGIN_BLOCKS;
  console.log(`robinhood mainnet fork at block ${blockNumber} (ROBINHOOD_MAINNET_FORK_BLOCK=${blockNumber} replays it)`);
  return network.connect({
    network: "robinhoodMainnetFork",
    override: { forking: { url: MAINNET_RPC_URL, blockNumber } },
  });
};

/** Connects the 46630 fork at a servable block and says which, so a failure can be replayed. */
export const connectRobinhoodFork = async () => {
  const blockNumber = await resolveForkBlock();
  console.log(`robinhood testnet fork at block ${blockNumber} (ROBINHOOD_FORK_BLOCK=${blockNumber} replays it)`);
  return network.connect({
    network: "robinhoodTestnetFork",
    override: { forking: { url: RPC_URL, blockNumber } },
  });
};
