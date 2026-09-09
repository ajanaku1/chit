/**
 * Runs the Stage 2 pooled journey against Robinhood Chain testnet (46630),
 * locally and in process, so it can be checked before anything is deployed.
 *
 *   npm run fleet-pool:check     configuration and funding only, spends nothing
 *   npm run fleet-pool:journey   the whole journey, spends testnet ETH
 *
 * Reads, never invents:
 *   DEPLOYER_PRIVATE_KEY        operator, and the trader for this demo
 *   FLEET_POOL_ADDRESS          optional; defaults to the recorded deployment
 *   ROBINHOOD_TESTNET_RPC_URL   optional
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient, createWalletClient, defineChain, formatEther, http, isHex, parseEther,
  type Address, type Hex, type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CampaignRouter } from "../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../src/fleet/campaign-service.js";
import { createFleetPool } from "../src/fleet/chain-pool.js";
import { campaignKey, createFleetChain } from "../src/fleet/chain-service.js";
import { ledgerKey } from "../src/fleet/pool-ledger.js";
import { createPoolService } from "../src/fleet/pool-buy.js";
import type { AuthEnvelope } from "../src/fleet/types.js";

const RECORD = path.resolve("deployments/fleet-46630.json");
const RPC_URL = process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const ORIGIN = "https://chit.tools";
const DEPOSIT = parseEther("0.05");
const DRAW = parseEther("0.02");
const PRINCIPAL = parseEther("0.0005");

const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const keyFromEnv = (): Hex => {
  const value = process.env.DEPLOYER_PRIVATE_KEY;
  if (!value || !isHex(value) || value.length !== 66) throw new Error("Set DEPLOYER_PRIVATE_KEY");
  return value;
};

type Deployment = {
  pool?: { address: Address };
  venue?: { token: Address };
  sessionPolicy: Address;
  accountFactory: Address;
  campaignEscrow: Address;
  router: Address;
};

const eth = (wei: bigint): string => `${formatEther(wei)} ETH`;

/** Reads the pool's own constants back, which only a real pool can answer. */
const probePool = async (publicClient: PublicClient, address: Address) => {
  const pool = createFleetPool(
    createWalletClient({ account: privateKeyToAccount(keyFromEnv()), chain, transport: http(RPC_URL) }),
    publicClient,
    address,
  );
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`no contract at ${address}`);
  await pool.paused();
  return pool;
};

const main = async (): Promise<void> => {
  const check = process.argv.includes("--check");
  const record = JSON.parse(await readFile(RECORD, "utf8")) as Deployment;
  const operator = privateKeyToAccount(keyFromEnv());
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) }) as unknown as PublicClient;
  const wallet = createWalletClient({ account: operator, chain, transport: http(RPC_URL) });

  const recorded = record.pool?.address;
  const configured = process.env.FLEET_POOL_ADDRESS as Address | undefined;
  const address = (configured ?? recorded) as Address | undefined;
  if (!address) throw new Error("No pool address: deploy with npm run fleet-pool-deploy:live");

  console.log(`operator          ${operator.address}`);
  console.log(`pool (recorded)   ${recorded ?? "none"}`);
  console.log(`pool (env)        ${configured ?? "unset, using the recorded one"}`);
  if (configured && recorded && configured.toLowerCase() !== recorded.toLowerCase()) {
    console.log("WARNING: FLEET_POOL_ADDRESS does not match the recorded deployment.");
  }
  if (configured && configured.toLowerCase() === operator.address.toLowerCase()) {
    throw new Error("FLEET_POOL_ADDRESS is the operator's own wallet, not the pool contract");
  }

  const pool = await probePool(publicClient, address);
  const balance = await publicClient.getBalance({ address: operator.address });
  const paused = await pool.paused();
  console.log(`pool responds     yes (paused: ${paused})`);
  console.log(`operator balance  ${eth(balance)}`);

  const needed = DEPOSIT + parseEther("0.004");
  const short = balance < needed;
  const blockers: string[] = [];
  if (short) blockers.push(`top up ${eth(needed - balance)} from the faucet (the journey needs about ${eth(needed)})`);
  if (paused) blockers.push("unpause the pool");
  if (!record.venue?.token) blockers.push("record a venue token; the buy step has nothing to buy");

  if (check) {
    if (blockers.length === 0) {
      console.log("\nReady: this configuration can run the whole journey.");
      return;
    }
    console.log("\nNot ready yet:");
    for (const blocker of blockers) console.log(`  - ${blocker}`);
    return;
  }
  if (blockers.length > 0) throw new Error(`not ready: ${blockers.join("; ")}`);

  // --- the journey, in process against the live chain ---------------------
  const serviceConfig = { origin: ORIGIN, chainId: 46630, maxTtlSeconds: 300 };
  const service = new CampaignService(serviceConfig, { nonceSecret: ledgerKey(keyFromEnv()) });
  const router = new CampaignRouter({
    service,
    pool: createPoolService(wallet, publicClient, pool, ledgerKey(keyFromEnv())),
    chain: createFleetChain(wallet, publicClient, {
      escrow: record.campaignEscrow, factory: record.accountFactory, policy: record.sessionPolicy,
    }),
  });

  let calls = 0;
  const call = async (action: string, body: Record<string, unknown>) => {
    const hash = payloadHash(body);
    const c = service.issueChallenge({ primaryWallet: operator.address, action, payloadHash: hash });
    const fields = {
      primaryWallet: operator.address, nonce: c.nonce, issuedAt: c.issuedAt,
      expiresAt: c.expiresAt, action, payloadHash: hash,
    };
    const signature = await operator.signMessage({ message: challengeBytes(serviceConfig, fields) });
    const result = await router.handle(
      { action, auth: { ...fields, signature } as AuthEnvelope, body },
      `fleet-${action}-${String(calls++).padStart(16, "0")}`,
    );
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`${action} -> ${result.status} ${JSON.stringify(result.body)}`);
    }
    console.log(`${action} -> ${result.status}`);
    return result.body as Record<string, unknown>;
  };

  const depositTx = await wallet.writeContract({
    address, abi: [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }],
    functionName: "deposit", value: DEPOSIT, account: operator, chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: depositTx });
  console.log(`deposited ${eth(DEPOSIT)} (${depositTx})`);

  const start = await call("balance", {});
  console.log(`available         ${eth(BigInt(String(start["available"])))}`);

  const created = await call("create", {
    quoteId: "q",
    policy: {
      chainId: 46630, accounts: 5, router: record.router, function: "execute(bytes,bytes[],uint256)",
      maxTradeValue: parseEther("0.001").toString(),
      perAccountGas: parseEther("0.002").toString(),
      totalGas: parseEther("0.01").toString(),
      expiry: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
    accounts: Array.from({ length: 5 }, (_, i) => ({
      ownerAddress: privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address,
      salt: `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex,
    })),
    recoveryVaultCommitment: generatePrivateKey(),
  });
  const campaign = String(created["campaign"]);
  await call("confirmRecovery", { campaign });

  const activated = await call("activate", { campaign, draw: DRAW.toString() });
  const accounts = activated["accounts"] as Address[];
  const dueAt = (activated["draw"] as { dueAt: string }).dueAt;
  console.log(`fleet             ${accounts.join(", ")}`);
  console.log(`funded after      ${dueAt}`);

  // The wait is the privacy; poll it exactly as the page does.
  for (;;) {
    const remaining = Date.parse(dueAt) - Date.now();
    if (remaining <= 0) break;
    console.log(`waiting ${Math.ceil(remaining / 1000)}s ...`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, remaining + 2_000)));
  }
  const swept = await call("sweep", {});
  console.log(`swept             ${JSON.stringify(swept)}`);

  const bought = await call("buy", {
    campaign, accounts: [accounts[0]], token: record.venue?.token ?? record.router, value: PRINCIPAL.toString(),
  });
  const results = bought["results"] as { account: string; status: string; txHash?: string; reason?: string }[];
  console.log(`buy               ${JSON.stringify(results[0])}`);

  const closed = await call("close", { campaign });
  console.log(`credited back     ${eth(BigInt(String(closed["creditedToBalance"] ?? "0")))}`);

  const fresh = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
  const paid = await call("withdraw", { amount: parseEther("0.01").toString(), destination: fresh });
  console.log(`withdrew to       ${fresh} (${String(paid["payoutTx"])})`);

  const full = JSON.parse(await readFile(RECORD, "utf8")) as Record<string, unknown>;
  full["pooledJourney"] = {
    campaign, fleet: accounts, depositTx, deposit: DEPOSIT.toString(), draw: DRAW.toString(),
    buy: results[0], creditedToBalance: closed["creditedToBalance"], withdrawTx: paid["payoutTx"],
    withdrawTo: fresh, at: new Date().toISOString(),
  };
  await writeFile(RECORD, `${JSON.stringify(full, null, 2)}\n`);
  console.log(`recorded pooledJourney in ${RECORD}`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
