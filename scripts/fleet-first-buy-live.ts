/**
 * First live sponsored buy through the hosted Fleet API (Stage 1 go-live,
 * Step 5). Drives the real trader journey against FLEET_API_ORIGIN
 * (default https://chit.tools): quote -> create -> confirmRecovery -> fund the
 * escrow on-chain -> fund -> activate -> one bounded ETH -> FLEET buy from the
 * first fleet account. Records the tx hashes under `firstBuy` in
 * deployments/fleet-46630.json.
 *
 * Reads, never invents:
 *   FLEET_OWNER_PRIVATE_KEY   the trader's primary wallet (defaults to
 *                             DEPLOYER_PRIVATE_KEY for the first demo)
 *   FLEET_API_ORIGIN          optional, the served site the wallet signs for
 *   ROBINHOOD_TESTNET_RPC_URL optional
 *
 * Run:  npm run fleet-first-buy:live
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, isHex, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { challengeBytes, payloadHash } from "../src/fleet/campaign-service.js";
import { campaignKey } from "../src/fleet/chain-service.js";
import { ROBINHOOD_TESTNET_ROUTER } from "../src/fleet/deploy.js";
import { UNIVERSAL_ROUTER_EXECUTE } from "../src/fleet/v4-swap.js";

const API = process.env.FLEET_API_ORIGIN || "https://chit.tools";
const RPC_URL = process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const RECORD = path.resolve("deployments/fleet-46630.json");
const SERVICE = { origin: API, chainId: 46630, maxTtlSeconds: 300 };
const ESCROW_ABI = parseAbi(["function fund(bytes32 campaign) payable"]);

const AMOUNTS = {
  escrow: parseEther("0.002"), perAccountGas: parseEther("0.0002"), totalGas: parseEther("0.001"),
  maxTrade: parseEther("0.0005"), principal: parseEther("0.0006"), buy: parseEther("0.0005"),
};

const chain = defineChain({
  id: 46630, name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const keyFromEnv = (): Hex => {
  const value = process.env.FLEET_OWNER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!value || !isHex(value) || value.length !== 66) throw new Error("Set FLEET_OWNER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY (funded, 46630)");
  return value;
};

const route = (action: string): string =>
  ["pause", "resume", "revoke", "close"].includes(action) ? "control" : action === "buy" ? "buy" : "campaign";

const api = async (payload: Record<string, unknown>, action: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!["quote", "challenge", "read"].includes(action)) {
    headers["idempotency-key"] = `fleet-${action}${Date.now()}`.padEnd(22, "0").slice(0, 40);
  }
  const response = await fetch(`${API}/api/fleet/${route(action)}`, { method: "POST", headers, body: JSON.stringify(payload) });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${action} -> ${response.status} ${JSON.stringify(body)}`);
  console.log(`${action} -> ${response.status}`);
  return { status: response.status, body };
};

const main = async (): Promise<void> => {
  const owner = privateKeyToAccount(keyFromEnv());
  const transport = http(RPC_URL);
  const wallet = createWalletClient({ account: owner, chain, transport });
  const publicClient = createPublicClient({ chain, transport });
  const record = JSON.parse(await readFile(RECORD, "utf8")) as Record<string, unknown>;
  const escrow = record["campaignEscrow"] as Address;
  const token = (record["venue"] as { token: Address }).token;
  const primaryWallet = owner.address.toLowerCase() as Address;

  const signed = async (action: string, body: Record<string, unknown>) => {
    const hash = payloadHash(body);
    const { body: c } = await api({ action: "challenge", body: { primaryWallet, action, payloadHash: hash } }, "challenge");
    const fields = { primaryWallet, nonce: c["nonce"] as string, issuedAt: c["issuedAt"] as string, expiresAt: c["expiresAt"] as string, action, payloadHash: hash };
    const signature = await owner.signMessage({ message: challengeBytes(SERVICE, fields) });
    return api({ action, auth: { ...fields, signature }, body }, action);
  };

  const quote = await api({ action: "quote", body: { primaryWallet } }, "quote");
  const accounts = Array.from({ length: 5 }, () => ({
    ownerAddress: privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address,
    salt: generatePrivateKey() as Hex,
  }));
  const created = await signed("create", {
    quoteId: quote.body["quoteId"],
    policy: {
      chainId: 46630, accounts: 5, router: ROBINHOOD_TESTNET_ROUTER, function: UNIVERSAL_ROUTER_EXECUTE,
      maxTradeValue: AMOUNTS.maxTrade.toString(), perAccountGas: AMOUNTS.perAccountGas.toString(),
      totalGas: AMOUNTS.totalGas.toString(), expiry: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
    accounts,
    // No vault is generated here; the commitment only has to be well-formed bytes32.
    recoveryVaultCommitment: generatePrivateKey(),
  });
  const campaign = created.body["campaign"] as string;
  const key = campaignKey(campaign);
  console.log(`campaign ${campaign} key ${key}`);
  await signed("confirmRecovery", { campaign });

  const fundTx = await wallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "fund", args: [key], value: AMOUNTS.escrow });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  console.log(`escrow funded (${fundTx})`);
  await signed("fund", { campaign, fundingReference: fundTx });

  const activated = await signed("activate", { campaign });
  const fleet = activated.body["accounts"] as Address[];
  console.log(`fleet ${fleet.join(", ")}`);

  const principalTx = await wallet.sendTransaction({ to: fleet[0]!, value: AMOUNTS.principal });
  await publicClient.waitForTransactionReceipt({ hash: principalTx });
  console.log(`principal sent to ${fleet[0]} (${principalTx})`);

  const bought = await signed("buy", { campaign, accounts: [fleet[0]], token, value: AMOUNTS.buy.toString() });
  const result = (bought.body["results"] as Record<string, unknown>[])[0]!;
  console.log(JSON.stringify(result, null, 2));
  if (result["status"] !== "sponsored") throw new Error("first buy was not sponsored");

  record["firstBuy"] = {
    api: API, campaign, key, owner: owner.address, fleet, fundTx, principalTx,
    buyTx: result["txHash"], account: fleet[0], token, budget: result["budget"], at: new Date().toISOString(),
  };
  await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`recorded firstBuy in ${RECORD}`);
};

main().catch((error: unknown) => { console.error(error); process.exit(1); });
