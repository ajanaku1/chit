import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ContractFunctionExecutionError,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatEther,
  http,
  isAddress,
  isHex,
  keccak256,
  parseEther,
  size,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ENTRY_POINT_V07 } from "../src/deployment-record.js";

const DEFAULT_RPC_URL = "https://sepolia.drpc.org";
const EVIDENCE_PATH = path.resolve("deployments/factory-browser-gate.json");
const ASSET_PATH = path.resolve("deployments/sepolia.json");
const BROWSER_SPONSOR = "0x536ad0665e4041e7e1843e0ce01b72ff90a9a4e5";
const ROUND_SALT = keccak256(stringToHex("chit-browser-factory-gate-v1"));
const PAYMASTER_DEPOSIT = parseEther("0.01");
const PAYMASTER_STAKE = parseEther("1");
const OPERATOR_GAS = parseEther("0.01");
const ACTIVATION_VALUE = PAYMASTER_DEPOSIT + PAYMASTER_STAKE + OPERATOR_GAS;
const UNSTAKE_DELAY = 86_400;
const SPONSOR_COLLATERAL = 10_000n;

interface ContractArtifact {
  readonly abi: Abi;
  readonly bytecode: Hex;
}

interface RoundRecord {
  readonly creator: Address;
  readonly operator: Address;
  readonly verifier: Address;
  readonly auditor: Address;
  readonly vault: Address;
  readonly settlement: Address;
  readonly paymaster: Address;
  readonly initializedSteps: number;
}

interface GateEvidence {
  chainId: number;
  sponsor: Address;
  roundSalt: Hex;
  chitToken?: Address;
  chitBudgetToken?: Address;
  factory?: Address;
  roundId?: Hex;
  vault?: Address;
  settlement?: Address;
  paymaster?: Address;
  factoryDeployTx?: Hex;
  beginRoundTx?: Hex;
  initializationTxs: Partial<Record<string, Hex>>;
  activationTx?: Hex;
  sponsorCollateralTx?: Hex;
  admissionExpiry?: number;
  admissionSignature?: Hex;
  gasEstimates: Partial<Record<string, string>>;
}

function privateKeyFromEnvironment(): Hex {
  const value = process.env.DEPLOYER_PRIVATE_KEY;
  if (value === undefined || !isHex(value) || size(value) !== 32) {
    throw new Error("DEPLOYER_PRIVATE_KEY must be a 32-byte hex value");
  }
  return value;
}

const rpcUrl = process.env.SEPOLIA_RPC_URL ?? DEFAULT_RPC_URL;
const deployer = privateKeyToAccount(privateKeyFromEnvironment());
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({
  account: deployer,
  chain: sepolia,
  transport: http(rpcUrl),
});

async function loadArtifact(
  source: string,
  contract = source,
): Promise<ContractArtifact> {
  const file = path.resolve(
    "artifacts/contracts",
    `${source}.sol`,
    `${contract}.json`,
  );
  const value = JSON.parse(await readFile(file, "utf8")) as ContractArtifact;
  if (!Array.isArray(value.abi) || !isHex(value.bytecode)) {
    throw new Error(`${contract} artifact is malformed`);
  }
  return value;
}

async function loadEvidence(): Promise<GateEvidence> {
  try {
    return JSON.parse(await readFile(EVIDENCE_PATH, "utf8")) as GateEvidence;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    return {
      chainId: sepolia.id,
      sponsor: BROWSER_SPONSOR,
      roundSalt: ROUND_SALT,
      initializationTxs: {},
      gasEstimates: {},
    };
  }
}

async function saveEvidence(evidence: GateEvidence): Promise<void> {
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function receipt(hash: Hex): Promise<TransactionReceipt> {
  const value = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 240_000,
  });
  if (value.status !== "success") throw new Error(`Sepolia transaction failed: ${hash}`);
  return value;
}

async function codeExists(address: Address | undefined): Promise<boolean> {
  if (address === undefined) return false;
  const code = await publicClient.getCode({ address });
  return code !== undefined && code !== "0x";
}

async function recordGas(
  evidence: GateEvidence,
  label: string,
  estimate: bigint,
): Promise<void> {
  const block = await publicClient.getBlock();
  if (estimate * 2n > block.gasLimit) {
    throw new Error(`${label} estimate exceeds 50% of the Sepolia block gas limit`);
  }
  evidence.gasEstimates[label] = estimate.toString();
  await saveEvidence(evidence);
}

async function deployFactory(
  evidence: GateEvidence,
  artifact: ContractArtifact,
  wrapper: Address,
): Promise<Address> {
  if (await codeExists(evidence.factory)) return evidence.factory as Address;
  if (evidence.factoryDeployTx === undefined) {
    evidence.factoryDeployTx = await broadcastFactoryDeployment(
      evidence,
      artifact,
      wrapper,
    );
    await saveEvidence(evidence);
  }
  const deployed = await receipt(evidence.factoryDeployTx);
  const address = deployed.contractAddress;
  if (address === null || address === undefined) {
    throw new Error("Factory receipt has no address");
  }
  evidence.factory = address;
  await saveEvidence(evidence);
  return address;
}

async function broadcastFactoryDeployment(
  evidence: GateEvidence,
  artifact: ContractArtifact,
  wrapper: Address,
): Promise<Hex> {
  const args = [ENTRY_POINT_V07, wrapper, parseEther("1")] as const;
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  await recordGas(
    evidence,
    "factoryDeploy",
    await publicClient.estimateGas({ account: deployer.address, data }),
  );
  return walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
}

function asRound(value: unknown): RoundRecord {
  if (typeof value !== "object" || value === null) throw new Error("Round is malformed");
  const round = value as Partial<RoundRecord>;
  for (const address of [
    round.creator,
    round.operator,
    round.verifier,
    round.auditor,
    round.vault,
    round.settlement,
    round.paymaster,
  ]) {
    if (typeof address !== "string" || !isAddress(address)) {
      throw new Error("Round contains an invalid address");
    }
  }
  if (typeof round.initializedSteps !== "number") {
    throw new Error("Round initialization mask is malformed");
  }
  return round as RoundRecord;
}

async function readRound(
  factory: Address,
  artifact: ContractArtifact,
  id: Hex,
): Promise<RoundRecord | undefined> {
  try {
    const value = await publicClient.readContract({
      address: factory,
      abi: artifact.abi,
      functionName: "getRound",
      args: [id],
    });
    return asRound(value);
  } catch (error) {
    if (error instanceof ContractFunctionExecutionError && error.message.includes("RoundNotFound")) {
      return undefined;
    }
    throw error;
  }
}

async function ensureRound(
  evidence: GateEvidence,
  factory: Address,
  artifact: ContractArtifact,
): Promise<RoundRecord> {
  const id = await factoryRoundId(factory, artifact);
  evidence.roundId = id;
  let round = await readRound(factory, artifact, id);
  if (round === undefined && evidence.beginRoundTx === undefined) {
    evidence.beginRoundTx = await broadcastBeginRound(
      evidence,
      factory,
      artifact,
    );
    await saveEvidence(evidence);
  }
  if (evidence.beginRoundTx !== undefined) await receipt(evidence.beginRoundTx);
  round = await readRound(factory, artifact, id);
  if (round === undefined) throw new Error("Round creation did not persist");
  await persistRoundAddresses(evidence, round);
  return round;
}

async function factoryRoundId(
  factory: Address,
  artifact: ContractArtifact,
): Promise<Hex> {
  return (await publicClient.readContract({
    address: factory,
    abi: artifact.abi,
    functionName: "roundId",
    args: [deployer.address, ROUND_SALT],
  })) as Hex;
}

async function broadcastBeginRound(
  evidence: GateEvidence,
  factory: Address,
  artifact: ContractArtifact,
): Promise<Hex> {
  const args = [ROUND_SALT, deployer.address, deployer.address, deployer.address] as const;
  const estimate = await publicClient.estimateContractGas({
    address: factory,
    abi: artifact.abi,
    functionName: "beginRound",
    args,
    account: deployer.address,
  });
  await recordGas(evidence, "beginRound", estimate);
  return walletClient.writeContract({
    address: factory,
    abi: artifact.abi,
    functionName: "beginRound",
    args,
  });
}

async function persistRoundAddresses(
  evidence: GateEvidence,
  round: RoundRecord,
): Promise<void> {
  Object.assign(evidence, {
    vault: round.vault,
    settlement: round.settlement,
    paymaster: round.paymaster,
  });
  await saveEvidence(evidence);
}

async function initializeRound(
  evidence: GateEvidence,
  factory: Address,
  artifact: ContractArtifact,
): Promise<void> {
  if (evidence.roundId === undefined) throw new Error("Round ID is missing");
  for (let step = 0; step < 5; step += 1) {
    await ensureInitializationStep(evidence, factory, artifact, step);
  }
}

async function ensureInitializationStep(
  evidence: GateEvidence,
  factory: Address,
  artifact: ContractArtifact,
  step: number,
): Promise<void> {
  if (evidence.roundId === undefined) throw new Error("Round ID is missing");
  const round = await readRound(factory, artifact, evidence.roundId);
  if (round === undefined) throw new Error("Round disappeared during initialization");
  if ((round.initializedSteps & (1 << step)) !== 0) return;
  const key = String(step);
  let hash = evidence.initializationTxs[key];
  if (hash === undefined) {
    hash = await broadcastInitializationStep(evidence, factory, artifact, step);
    evidence.initializationTxs[key] = hash;
    await saveEvidence(evidence);
  }
  await receipt(hash);
}

async function broadcastInitializationStep(
  evidence: GateEvidence,
  factory: Address,
  artifact: ContractArtifact,
  step: number,
): Promise<Hex> {
  if (evidence.roundId === undefined) throw new Error("Round ID is missing");
  const args = [evidence.roundId, step] as const;
  const estimate = await publicClient.estimateContractGas({
    address: factory,
    abi: artifact.abi,
    functionName: "initializeRoundStep",
    args,
    account: deployer.address,
  });
  await recordGas(evidence, `initializeStep${step}`, estimate);
  return walletClient.writeContract({
    address: factory,
    abi: artifact.abi,
    functionName: "initializeRoundStep",
    args,
  });
}

async function activateRound(
  evidence: GateEvidence,
  factory: Address,
  factoryArtifact: ContractArtifact,
  paymasterArtifact: ContractArtifact,
): Promise<void> {
  if (evidence.roundId === undefined || evidence.paymaster === undefined) {
    throw new Error("Round activation addresses are missing");
  }
  const state = await publicClient.readContract({
    address: evidence.paymaster,
    abi: paymasterArtifact.abi,
    functionName: "roundState",
  });
  if (state === 1) return;
  if (evidence.activationTx === undefined) {
    evidence.activationTx = await broadcastActivation(
      evidence,
      factory,
      factoryArtifact,
    );
    await saveEvidence(evidence);
  }
  await receipt(evidence.activationTx);
}

async function broadcastActivation(
  evidence: GateEvidence,
  factory: Address,
  artifact: ContractArtifact,
): Promise<Hex> {
  if (evidence.roundId === undefined) throw new Error("Round ID is missing");
  const args = activationArguments(evidence.roundId);
  const estimate = await publicClient.estimateContractGas({
    address: factory,
    abi: artifact.abi,
    functionName: "activateRound",
    args,
    account: deployer.address,
    value: ACTIVATION_VALUE,
  });
  await recordGas(evidence, "activateRound", estimate);
  return walletClient.writeContract({
    address: factory,
    abi: artifact.abi,
    functionName: "activateRound",
    args,
    value: ACTIVATION_VALUE,
  });
}

function activationArguments(
  roundId: Hex,
): readonly [Hex, bigint, bigint, number, bigint] {
  return [
    roundId,
    PAYMASTER_DEPOSIT,
    PAYMASTER_STAKE,
    UNSTAKE_DELAY,
    OPERATOR_GAS,
  ] as const;
}

async function fundSponsor(
  evidence: GateEvidence,
  tokenArtifact: ContractArtifact,
): Promise<void> {
  if (evidence.chitToken === undefined) throw new Error("CHIT token is missing");
  const balance = (await publicClient.readContract({
    address: evidence.chitToken,
    abi: tokenArtifact.abi,
    functionName: "balanceOf",
    args: [BROWSER_SPONSOR],
  })) as bigint;
  if (balance >= SPONSOR_COLLATERAL) return;
  if (evidence.sponsorCollateralTx === undefined) {
    evidence.sponsorCollateralTx = await walletClient.writeContract({
      address: evidence.chitToken,
      abi: tokenArtifact.abi,
      functionName: "transfer",
      args: [BROWSER_SPONSOR, SPONSOR_COLLATERAL - balance],
    });
    await saveEvidence(evidence);
  }
  await receipt(evidence.sponsorCollateralTx);
}

async function issueAdmission(
  evidence: GateEvidence,
  vaultArtifact: ContractArtifact,
): Promise<void> {
  if (evidence.vault === undefined) throw new Error("Vault is missing");
  const expiry = Math.floor(Date.now() / 1000) + 86_400;
  const digest = (await publicClient.readContract({
    address: evidence.vault,
    abi: vaultArtifact.abi,
    functionName: "admissionDigest",
    args: [BROWSER_SPONSOR, expiry],
  })) as Hex;
  evidence.admissionExpiry = expiry;
  evidence.admissionSignature = await walletClient.signMessage({
    account: deployer,
    message: { raw: digest },
  });
  await saveEvidence(evidence);
}

async function loadAssets(evidence: GateEvidence): Promise<void> {
  const value = JSON.parse(await readFile(ASSET_PATH, "utf8")) as Record<string, unknown>;
  if (
    typeof value.chitToken !== "string" ||
    !isAddress(value.chitToken) ||
    typeof value.chitBudgetToken !== "string" ||
    !isAddress(value.chitBudgetToken)
  ) {
    throw new Error("Existing Sepolia asset record is malformed");
  }
  evidence.chitToken = value.chitToken;
  evidence.chitBudgetToken = value.chitBudgetToken;
}

async function main(): Promise<void> {
  const evidence = await loadEvidence();
  await loadAssets(evidence);
  const balance = await publicClient.getBalance({ address: deployer.address });
  console.log(`Factory gate deployer ${deployer.address} has ${formatEther(balance)} ETH`);
  if (balance < parseEther("1.05")) throw new Error("At least 1.05 Sepolia ETH is required");
  const [factoryArtifact, paymasterArtifact, tokenArtifact, vaultArtifact] =
    await Promise.all([
      loadArtifact("ChitRoundFactory"),
      loadArtifact("ChitPaymaster"),
      loadArtifact("ChitAssets", "ChitToken"),
      loadArtifact("ChitVault"),
    ]);
  if (evidence.chitBudgetToken === undefined) throw new Error("Wrapper is missing");
  const factory = await deployFactory(evidence, factoryArtifact, evidence.chitBudgetToken);
  await ensureRound(evidence, factory, factoryArtifact);
  await initializeRound(evidence, factory, factoryArtifact);
  await activateRound(evidence, factory, factoryArtifact, paymasterArtifact);
  await fundSponsor(evidence, tokenArtifact);
  await issueAdmission(evidence, vaultArtifact);
  console.log(`Factory browser gate ready at vault ${evidence.vault}`);
}

await main();
