import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";
import noxPlugin from "@iexec-nox/nox-hardhat-plugin";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, noxPlugin],
  solidity: {
    version: "0.8.35",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,
      },
    },
  },
  // The fork already carries the real NoxCompute, so the plugin's Docker-based
  // local stack is unnecessary (and unavailable here).
  nox: { skipTestOverride: true },
  networks: {
    default: {
      type: "edr-simulated",
      chainType: "op",
    },
    // Robinhood Chain testnet (Arbitrum Orbit L2). Chain 46630 carries the
    // canonical ERC-4337 EntryPoints and the Uniswap v4 stack; both were
    // confirmed by eth_getCode on 2026-08-30 and are recorded in
    // specs/001-fleet-mission/research.md.
    robinhoodTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 46630,
      url: process.env.ROBINHOOD_TESTNET_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com",
    },
    // Fork of Robinhood Chain testnet, so Fleet tests run against the real
    // EntryPoint and Universal Router without spending testnet ETH.
    robinhoodTestnetFork: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 46630,
      forking: {
        url: process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
        // No block number here on purpose. The public RPC serves state for
        // only ~6,900 blocks (about eighteen minutes), so any number written
        // in this file is unservable by the time it is committed, and a fresh
        // clone fails with "metadata is not found". test/fork/robinhood-fork.ts
        // pins each connection a few blocks behind the live tip instead, which
        // keeps EDR's on-disk cache and the RPC's burst limit happy without a
        // number that rots. ROBINHOOD_FORK_BLOCK replays a specific run.
      },
    },
    // Fork of Ethereum Sepolia. chainId stays 11155111 so Nox's hardcoded
    // address resolution picks the real NoxCompute (0x24Ef...77bF), and so the
    // plugin skips its Docker-based local stack entirely.
    sepoliaFork: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 11155111,
      forking: {
        url: process.env.FORK_RPC_URL ?? "https://sepolia.drpc.org",
      },
    },
  },
});
