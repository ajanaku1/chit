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
