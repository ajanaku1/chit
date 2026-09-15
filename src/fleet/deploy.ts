/**
 * Fleet contract deployment.
 *
 * A single reusable routine that deploys the three hardened Fleet contracts and
 * returns a complete deployment record. It is transport-agnostic: the same
 * function runs against a local EVM in tests and against Robinhood Chain testnet
 * from `scripts/fleet-deploy-live.ts`, so the live deploy exercises exactly the
 * path the tests prove.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Abi, Address, Hex, PublicClient, WalletClient } from "viem";
import { isAddress, isHex } from "viem";

/** EntryPoint v0.7 and the Uniswap v4 router, verified live on chain 46630. */
export const ROBINHOOD_TESTNET_ENTRYPOINT = "0x0000000071727de22e5e9d8baf0edac6f37da032" as const;
export const ROBINHOOD_TESTNET_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as const;

type ContractArtifact = { abi: Abi; bytecode: Hex };

export type FleetDeployment = {
  network: string;
  chainId: number;
  operator: Address;
  /** The cold admin the policy's ownership was offered to; it accepts with one transaction. */
  admin: Address;
  entryPoint: Address;
  router: Address;
  sessionPolicy: Address;
  accountFactory: Address;
  campaignEscrow: Address;
  paymaster: Address;
  sessionPolicyTx: Hex;
  accountFactoryTx: Hex;
  campaignEscrowTx: Hex;
  paymasterTx: Hex;
  setSettlerTx: Hex;
  adminHandoverTx: Hex;
  deployedAt: string;
};

const ARTIFACTS: Record<string, string> = {
  FleetSessionPolicy: "artifacts/contracts/fleet/FleetSessionPolicy.sol/FleetSessionPolicy.json",
  FleetAccountFactory: "artifacts/contracts/fleet/FleetAccountFactory.sol/FleetAccountFactory.json",
  FleetCampaignEscrow: "artifacts/contracts/fleet/FleetCampaignEscrow.sol/FleetCampaignEscrow.json",
  FleetPaymaster: "artifacts/contracts/fleet/FleetPaymaster.sol/FleetPaymaster.json",
};

const loadArtifact = async (name: string): Promise<ContractArtifact> => {
  const artifactPath = ARTIFACTS[name];
  if (!artifactPath) throw new Error(`unknown fleet artifact: ${name}`);
  const parsed = JSON.parse(await readFile(path.resolve(artifactPath), "utf8")) as ContractArtifact;
  if (!Array.isArray(parsed.abi) || !isHex(parsed.bytecode)) {
    throw new Error(`${name} artifact is malformed`);
  }
  return parsed;
};

export type DeployClients = {
  wallet: WalletClient;
  publicClient: PublicClient;
  /** The hot key: the operator role on every contract, and the deployer. */
  operator: Address;
  /**
   * The cold key: offered the policy's admin role (Ownable2Step) at the end of
   * the deploy. It must not be the operator; a hot key that is also the admin
   * can unpause itself, which is the thing the split exists to prevent.
   */
  admin: Address;
  /** Human-readable network label for the record. */
  network: string;
};

/**
 * Deploys FleetSessionPolicy, FleetAccountFactory, and FleetCampaignEscrow with
 * `operator` as their operator, waits for each receipt, and returns the record.
 * The policy is deployed with the deployer as admin, so the pool deploy that
 * follows can call setPool, then its admin role is offered to `admin`; the cold
 * key completes the handover with acceptOwnership. Reverts if any deployment
 * does not land or leaves no code.
 */
export const deployFleet = async ({ wallet, publicClient, operator, admin, network }: DeployClients): Promise<FleetDeployment> => {
  if (!isAddress(operator)) throw new Error("operator is not an address");
  if (!isAddress(admin)) throw new Error("admin is not an address");
  if (admin.toLowerCase() === operator.toLowerCase()) throw new Error("admin must not be the operator: the cold key is a different key");
  const chainId = await publicClient.getChainId();

  const deploy = async (name: string, args: readonly unknown[]): Promise<{ address: Address; tx: Hex }> => {
    const artifact = await loadArtifact(name);
    const tx = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args,
      account: wallet.account ?? null,
      chain: wallet.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx, confirmations: 1, timeout: 180_000 });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`${name} deployment failed (${tx})`);
    }
    const code = await publicClient.getCode({ address: receipt.contractAddress });
    if (!code || code === "0x") throw new Error(`${name} left no code at ${receipt.contractAddress}`);
    return { address: receipt.contractAddress, tx };
  };

  const sessionPolicy = await deploy("FleetSessionPolicy", [operator, operator]);
  const accountFactory = await deploy("FleetAccountFactory", [operator]);
  const campaignEscrow = await deploy("FleetCampaignEscrow", [operator]);
  const paymaster = await deploy("FleetPaymaster", [ROBINHOOD_TESTNET_ENTRYPOINT, operator, campaignEscrow.address]);

  // Authorize the paymaster to settle budget against the escrow (set-once).
  const escrowArtifact = await loadArtifact("FleetCampaignEscrow");
  const setSettlerTx = await wallet.writeContract({
    address: campaignEscrow.address,
    abi: escrowArtifact.abi,
    functionName: "setSettler",
    args: [paymaster.address],
    account: wallet.account ?? null,
    chain: wallet.chain,
  });
  const settlerReceipt = await publicClient.waitForTransactionReceipt({ hash: setSettlerTx, confirmations: 1, timeout: 180_000 });
  if (settlerReceipt.status !== "success") throw new Error(`setSettler failed (${setSettlerTx})`);

  // Offer the policy's admin role to the cold key. Two-step: nothing changes
  // until it accepts, and the deployer keeps setPool for the pool deploy.
  const policyArtifact = await loadArtifact("FleetSessionPolicy");
  const adminHandoverTx = await wallet.writeContract({
    address: sessionPolicy.address,
    abi: policyArtifact.abi,
    functionName: "transferOwnership",
    args: [admin],
    account: wallet.account ?? null,
    chain: wallet.chain,
  });
  const handoverReceipt = await publicClient.waitForTransactionReceipt({ hash: adminHandoverTx, confirmations: 1, timeout: 180_000 });
  if (handoverReceipt.status !== "success") throw new Error(`transferOwnership failed (${adminHandoverTx})`);

  return {
    network,
    chainId,
    operator,
    admin,
    entryPoint: ROBINHOOD_TESTNET_ENTRYPOINT,
    router: ROBINHOOD_TESTNET_ROUTER,
    sessionPolicy: sessionPolicy.address,
    accountFactory: accountFactory.address,
    campaignEscrow: campaignEscrow.address,
    paymaster: paymaster.address,
    sessionPolicyTx: sessionPolicy.tx,
    accountFactoryTx: accountFactory.tx,
    campaignEscrowTx: campaignEscrow.tx,
    paymasterTx: paymaster.tx,
    setSettlerTx,
    adminHandoverTx,
    deployedAt: new Date().toISOString(),
  };
};
