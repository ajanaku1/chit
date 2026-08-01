import { createViemHandleClient } from "@iexec-nox/handle";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  isHex,
  parseAbi,
  parseEther,
  parseGwei,
  size,
  sliceHex,
  stringToHex,
  TransactionReceiptNotFoundError,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  entryPoint07Abi,
  type PackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  ENTRY_POINT_V07,
  NOX_COMPUTE_SEPOLIA,
  SIMPLE_ACCOUNT_FACTORY_V07,
  parseDeploymentRecord,
} from "../src/deployment-record.js";
import {
  buildPaymasterAndData,
  packChitUserOperation,
  userOperationHash,
} from "../src/user-operation.js";

const DEFAULT_RPC_URL = "https://sepolia.drpc.org";
const EVIDENCE_PATH = path.resolve("deployments/sepolia.json");
const CHAIN_ID = 11155111;
const ACCOUNT_SALT = BigInt(keccak256(stringToHex("chit-sepolia-v1")));
const TOKEN_SUPPLY = 1_000_000n;
const WRAP_AMOUNT = 100_000n;
const SPONSOR_BUDGET = 50_000n;
const PAYMASTER_DEPOSIT = parseEther("0.03");
const PROOF_BYTES = 137;

const factoryAbi = parseAbi([
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function createAccount(address owner, uint256 salt) returns (address)",
]);
const accountAbi = parseAbi([
  "function execute(address dest, uint256 value, bytes func)",
]);

type ContractKey =
  | "chitToken"
  | "chitBudgetToken"
  | "chitPaymaster"
  | "chitVault"
  | "chitSettlement"
  | "chitCounter";
type StepKey =
  | "setSettlementTx"
  | "tokenApproveTx"
  | "wrapTx"
  | "operatorTx"
  | "sponsorFundTx"
  | "paymasterDepositTx"
  | "sponsorEnrollTx"
  | "sponsoredUserOpTx"
  | "settleEpochTx";

interface ContractArtifact {
  readonly abi: Abi;
  readonly bytecode: Hex;
}

interface EncryptedInput {
  readonly handle: Hex;
  readonly handleProof: Hex;
}

interface UserOperationGas {
  readonly callGasLimit: bigint;
  readonly verificationGasLimit: bigint;
  readonly preVerificationGas: bigint;
  readonly paymasterVerificationGasLimit: bigint;
  readonly paymasterPostOpGasLimit: bigint;
  readonly maxCost: bigint;
}

interface Checkpoint {
  revision?: number;
  chainId: number;
  entryPoint: Address;
  noxCompute: Address;
  simpleAccountFactory: Address;
  addresses: Partial<Record<ContractKey, Address>>;
  deployTransactions: Partial<Record<ContractKey, Hex>>;
  transactions: Partial<Record<StepKey, Hex>>;
  simpleAccount?: Address;
  sponsorBudgetInputHandle?: Hex;
  sponsorSlotInputHandle?: Hex;
  userOperationHash?: Hex;
  claimWei?: string;
  superseded?: readonly unknown[];
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

function freshCheckpoint(): Checkpoint {
  return {
    revision: 2,
    chainId: CHAIN_ID,
    entryPoint: ENTRY_POINT_V07,
    noxCompute: NOX_COMPUTE_SEPOLIA,
    simpleAccountFactory: SIMPLE_ACCOUNT_FACTORY_V07,
    addresses: {},
    deployTransactions: {},
    transactions: {},
  };
}

async function migrateCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
  if (checkpoint.revision === 2) return checkpoint;
  const superseded = legacyCheckpointSnapshot(checkpoint);
  clearLegacyCheckpoint(checkpoint);
  checkpoint.revision = 2;
  checkpoint.superseded = [...(checkpoint.superseded ?? []), superseded];
  await saveCheckpoint(checkpoint);
  return checkpoint;
}

function legacyCheckpointSnapshot(checkpoint: Checkpoint): object {
  return {
    reason: "ChitVault v1 delegated fromExternal proof validation to the wrapper",
    addresses: {
      chitVault: checkpoint.addresses.chitVault,
      chitSettlement: checkpoint.addresses.chitSettlement,
    },
    deployTransactions: {
      chitVault: checkpoint.deployTransactions.chitVault,
      chitSettlement: checkpoint.deployTransactions.chitSettlement,
    },
    transactions: {
      setSettlementTx: checkpoint.transactions.setSettlementTx,
      operatorTx: checkpoint.transactions.operatorTx,
    },
    sponsorBudgetInputHandle: checkpoint.sponsorBudgetInputHandle,
  };
}

function clearLegacyCheckpoint(checkpoint: Checkpoint): void {
  delete checkpoint.addresses.chitVault;
  delete checkpoint.addresses.chitSettlement;
  delete checkpoint.deployTransactions.chitVault;
  delete checkpoint.deployTransactions.chitSettlement;
  delete checkpoint.transactions.setSettlementTx;
  delete checkpoint.transactions.operatorTx;
  delete checkpoint.transactions.sponsorFundTx;
  delete checkpoint.sponsorBudgetInputHandle;
}

async function loadCheckpoint(): Promise<Checkpoint> {
  try {
    const value = JSON.parse(await readFile(EVIDENCE_PATH, "utf8")) as Checkpoint;
    if (value.chainId !== CHAIN_ID) throw new Error("checkpoint chainId is not Sepolia");
    if (typeof value.addresses !== "object" || value.addresses === null) {
      throw new Error("Phase 2 evidence is finalized; use phase2:check");
    }
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    if (
      error instanceof Error &&
      !("code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
    return freshCheckpoint();
  }
}

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function loadArtifact(source: string, contract: string): Promise<ContractArtifact> {
  const artifactPath = path.resolve(
    "artifacts/contracts",
    `${source}.sol`,
    `${contract}.json`,
  );
  const value = JSON.parse(await readFile(artifactPath, "utf8")) as ContractArtifact;
  if (!Array.isArray(value.abi) || !isHex(value.bytecode)) {
    throw new Error(`${contract} artifact is malformed`);
  }
  return value;
}

async function successfulTransaction(hash: Hex | undefined): Promise<boolean> {
  if (hash === undefined) return false;
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return receipt.status === "success";
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return false;
    throw error;
  }
}

async function confirmTransaction(hash: Hex): Promise<Address | undefined> {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 240_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`Sepolia transaction failed: ${hash}`);
  }
  return receipt.contractAddress ?? undefined;
}

async function deployedCode(address: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address });
  return code !== undefined && code !== "0x";
}

async function preflight(minimumBalance: bigint): Promise<void> {
  const [entryPointReady, noxReady, factoryReady, balance] = await Promise.all([
    deployedCode(ENTRY_POINT_V07),
    deployedCode(NOX_COMPUTE_SEPOLIA),
    deployedCode(SIMPLE_ACCOUNT_FACTORY_V07),
    publicClient.getBalance({ address: deployer.address }),
  ]);
  if (!entryPointReady || !noxReady || !factoryReady) {
    throw new Error("canonical Sepolia infrastructure bytecode is missing");
  }
  console.log(`Deployer ${deployer.address} has ${formatEther(balance)} Sepolia ETH`);
  if (balance < minimumBalance) {
    throw new Error(
      `at least ${formatEther(minimumBalance)} Sepolia ETH is required`,
    );
  }
}

async function deployOnce(
  checkpoint: Checkpoint,
  key: ContractKey,
  artifact: ContractArtifact,
  args: readonly unknown[] = [],
): Promise<Address> {
  const existing = checkpoint.addresses[key];
  if (existing !== undefined && (await deployedCode(existing))) return existing;
  console.log(`Deploying ${key}...`);
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const address = await confirmTransaction(hash);
  if (address === undefined) throw new Error(`${key} receipt has no contract address`);
  checkpoint.addresses[key] = address;
  checkpoint.deployTransactions[key] = hash;
  await saveCheckpoint(checkpoint);
  return address;
}

async function sendStep(
  checkpoint: Checkpoint,
  key: StepKey,
  label: string,
  send: () => Promise<Hex>,
): Promise<Hex> {
  const existing = checkpoint.transactions[key];
  if (existing !== undefined && (await successfulTransaction(existing))) {
    return existing;
  }
  console.log(label);
  const hash = await send();
  await confirmTransaction(hash);
  checkpoint.transactions[key] = hash;
  await saveCheckpoint(checkpoint);
  return hash;
}

function requiredAddress(checkpoint: Checkpoint, key: ContractKey): Address {
  const value = checkpoint.addresses[key];
  if (value === undefined) throw new Error(`${key} is not deployed`);
  return value;
}

async function deployContracts(checkpoint: Checkpoint): Promise<void> {
  const assets = await loadArtifact("ChitAssets", "ChitToken");
  const token = await deployOnce(checkpoint, "chitToken", assets, [
    deployer.address,
    TOKEN_SUPPLY,
  ]);
  const wrapper = await loadArtifact("ChitAssets", "ChitBudgetToken");
  await deployOnce(checkpoint, "chitBudgetToken", wrapper, [token]);
  const paymaster = await loadArtifact("ChitPaymaster", "ChitPaymaster");
  await deployOnce(checkpoint, "chitPaymaster", paymaster, [
    ENTRY_POINT_V07,
    deployer.address,
    deployer.address,
  ]);
  await deployVaultAndSettlement(checkpoint);
  const counter = await loadArtifact("ChitAssets", "ChitCounter");
  await deployOnce(checkpoint, "chitCounter", counter);
}

async function deployVaultAndSettlement(checkpoint: Checkpoint): Promise<void> {
  const wrapper = requiredAddress(checkpoint, "chitBudgetToken");
  const vaultArtifact = await loadArtifact("ChitVault", "ChitVault");
  const vault = await deployOnce(checkpoint, "chitVault", vaultArtifact, [
    wrapper,
    deployer.address,
    deployer.address,
  ]);
  const settlementArtifact = await loadArtifact("ChitSettlement", "ChitSettlement");
  await deployOnce(checkpoint, "chitSettlement", settlementArtifact, [
    vault,
    deployer.address,
    deployer.address,
  ]);
}

async function configureSettlement(checkpoint: Checkpoint): Promise<void> {
  const vault = requiredAddress(checkpoint, "chitVault");
  const settlement = requiredAddress(checkpoint, "chitSettlement");
  const artifact = await loadArtifact("ChitVault", "ChitVault");
  await sendStep(checkpoint, "setSettlementTx", "Linking vault to settlement...", () =>
    walletClient.writeContract({
      address: vault,
      abi: artifact.abi,
      functionName: "setSettlement",
      args: [settlement],
    }),
  );
}

async function prepareWrappedBudget(checkpoint: Checkpoint): Promise<void> {
  const token = requiredAddress(checkpoint, "chitToken");
  const wrapper = requiredAddress(checkpoint, "chitBudgetToken");
  const tokenArtifact = await loadArtifact("ChitAssets", "ChitToken");
  const wrapperArtifact = await loadArtifact("ChitAssets", "ChitBudgetToken");
  await sendStep(checkpoint, "tokenApproveTx", "Approving collateral wrapper...", () =>
    walletClient.writeContract({
      address: token,
      abi: tokenArtifact.abi,
      functionName: "approve",
      args: [wrapper, WRAP_AMOUNT],
    }),
  );
  await sendStep(checkpoint, "wrapTx", "Wrapping confidential sponsor collateral...", () =>
    walletClient.writeContract({
      address: wrapper,
      abi: wrapperArtifact.abi,
      functionName: "wrap",
      args: [deployer.address, WRAP_AMOUNT],
    }),
  );
}

async function fundSponsor(checkpoint: Checkpoint): Promise<void> {
  if (await successfulTransaction(checkpoint.transactions.sponsorFundTx)) return;
  await prepareWrappedBudget(checkpoint);
  const wrapper = requiredAddress(checkpoint, "chitBudgetToken");
  const vault = requiredAddress(checkpoint, "chitVault");
  const wrapperArtifact = await loadArtifact("ChitAssets", "ChitBudgetToken");
  const vaultArtifact = await loadArtifact("ChitVault", "ChitVault");
  const until = Math.floor(Date.now() / 1000) + 86_400;
  await sendStep(checkpoint, "operatorTx", "Authorizing the vault as operator...", () =>
    walletClient.writeContract({
      address: wrapper,
      abi: wrapperArtifact.abi,
      functionName: "setOperator",
      args: [vault, until],
    }),
  );
  const encrypted = await encryptInput(SPONSOR_BUDGET, vault);
  checkpoint.sponsorBudgetInputHandle = encrypted.handle;
  await saveCheckpoint(checkpoint);
  await sendStep(checkpoint, "sponsorFundTx", "Importing encrypted sponsor budget...", () =>
    walletClient.writeContract({
      address: vault,
      abi: vaultArtifact.abi,
      functionName: "registerSponsor",
      args: [encrypted.handle, encrypted.handleProof],
    }),
  );
}

async function encryptInput(
  value: bigint,
  contract: Address,
): Promise<EncryptedInput> {
  const handleClient = await createViemHandleClient(walletClient);
  const encrypted = await handleClient.encryptInput(value, "uint256", contract);
  if (size(encrypted.handleProof) !== PROOF_BYTES) {
    throw new Error("Nox gateway returned an unexpected proof length");
  }
  return encrypted;
}

async function depositPaymaster(checkpoint: Checkpoint): Promise<void> {
  const paymaster = requiredAddress(checkpoint, "chitPaymaster");
  const artifact = await loadArtifact("ChitPaymaster", "ChitPaymaster");
  await sendStep(checkpoint, "paymasterDepositTx", "Depositing EntryPoint funds...", () =>
    walletClient.writeContract({
      address: paymaster,
      abi: artifact.abi,
      functionName: "deposit",
      value: PAYMASTER_DEPOSIT,
    }),
  );
}

async function resolveSimpleAccount(checkpoint: Checkpoint): Promise<Address> {
  if (checkpoint.simpleAccount !== undefined) return checkpoint.simpleAccount;
  const account = await publicClient.readContract({
    address: SIMPLE_ACCOUNT_FACTORY_V07,
    abi: factoryAbi,
    functionName: "getAddress",
    args: [deployer.address, ACCOUNT_SALT],
  });
  checkpoint.simpleAccount = account;
  await saveCheckpoint(checkpoint);
  return account;
}

async function enrollAccount(
  checkpoint: Checkpoint,
  account: Address,
): Promise<void> {
  if (await successfulTransaction(checkpoint.transactions.sponsorEnrollTx)) return;
  const settlement = requiredAddress(checkpoint, "chitSettlement");
  const artifact = await loadArtifact("ChitSettlement", "ChitSettlement");
  const encrypted = await encryptInput(0n, settlement);
  checkpoint.sponsorSlotInputHandle = encrypted.handle;
  await saveCheckpoint(checkpoint);
  await sendStep(checkpoint, "sponsorEnrollTx", "Enrolling encrypted sponsor slot...", () =>
    walletClient.writeContract({
      address: settlement,
      abi: artifact.abi,
      functionName: "enroll",
      args: [account, encrypted.handle, encrypted.handleProof],
    }),
  );
}

function userOperationGas(maxFeePerGas: bigint): UserOperationGas {
  const limits = {
    callGasLimit: 300_000n,
    verificationGasLimit: 1_000_000n,
    preVerificationGas: 120_000n,
    paymasterVerificationGasLimit: 300_000n,
    paymasterPostOpGasLimit: 250_000n,
  };
  const total = Object.values(limits).reduce((sum, value) => sum + value, 0n);
  return { ...limits, maxCost: total * maxFeePerGas };
}

async function unsignedOperation(
  checkpoint: Checkpoint,
  account: Address,
): Promise<{ operation: UserOperation<"0.7">; maxCost: bigint }> {
  const counter = requiredAddress(checkpoint, "chitCounter");
  const paymaster = requiredAddress(checkpoint, "chitPaymaster");
  const counterArtifact = await loadArtifact("ChitAssets", "ChitCounter");
  const increment = encodeFunctionData({
    abi: counterArtifact.abi,
    functionName: "increment",
  });
  const callData = encodeFunctionData({
    abi: accountAbi,
    functionName: "execute",
    args: [counter, 0n, increment],
  });
  return buildUnsignedOperation(account, paymaster, callData);
}

async function buildUnsignedOperation(
  account: Address,
  paymaster: Address,
  callData: Hex,
): Promise<{ operation: UserOperation<"0.7">; maxCost: bigint }> {
  const nonce = await publicClient.readContract({
    address: ENTRY_POINT_V07,
    abi: entryPoint07Abi,
    functionName: "getNonce",
    args: [account, 0n],
  });
  const gasPrice = await publicClient.getGasPrice();
  const maxFeePerGas = gasPrice * 2n > parseGwei("2") ? gasPrice * 2n : parseGwei("2");
  const { maxCost, ...gasLimits } = userOperationGas(maxFeePerGas);
  const deployment = await accountDeploymentFields(account);
  const operation = {
    sender: account,
    nonce,
    callData,
    ...deployment,
    ...gasLimits,
    maxFeePerGas,
    maxPriorityFeePerGas: maxFeePerGas,
    paymaster,
    paymasterData: "0x",
    signature: "0x",
  } satisfies UserOperation<"0.7">;
  return { operation, maxCost };
}

async function accountDeploymentFields(
  account: Address,
): Promise<{ factory?: Address; factoryData?: Hex }> {
  if (await deployedCode(account)) return {};
  const factoryData = encodeFunctionData({
    abi: factoryAbi,
    functionName: "createAccount",
    args: [deployer.address, ACCOUNT_SALT],
  });
  return { factory: SIMPLE_ACCOUNT_FACTORY_V07, factoryData };
}

async function authorizePaymaster(
  checkpoint: Checkpoint,
  operation: UserOperation<"0.7">,
  maxCost: bigint,
): Promise<UserOperation<"0.7">> {
  const paymaster = requiredAddress(checkpoint, "chitPaymaster");
  const artifact = await loadArtifact("ChitPaymaster", "ChitPaymaster");
  const validUntil = Math.floor(Date.now() / 1000) + 3_600;
  const packed = packChitUserOperation(operation);
  const digest = await publicClient.readContract({
    address: paymaster,
    abi: artifact.abi,
    functionName: "authorizationDigest",
    args: [packed, maxCost, validUntil],
  });
  if (typeof digest !== "string" || !isHex(digest) || size(digest) !== 32) {
    throw new Error("paymaster returned a malformed authorization digest");
  }
  const verifierSignature = await walletClient.signMessage({
    message: { raw: digest },
  });
  const fullPayload = buildPaymasterAndData(
    paymaster,
    operation.paymasterVerificationGasLimit ?? 0n,
    operation.paymasterPostOpGasLimit ?? 0n,
    validUntil,
    verifierSignature,
  );
  return { ...operation, paymasterData: sliceHex(fullPayload, 52) };
}

async function signAccountOperation(
  checkpoint: Checkpoint,
  operation: UserOperation<"0.7">,
): Promise<PackedUserOperation> {
  const hash = userOperationHash(operation, ENTRY_POINT_V07, CHAIN_ID);
  checkpoint.userOperationHash = hash;
  await saveCheckpoint(checkpoint);
  const signature = await walletClient.signMessage({ message: { raw: hash } });
  return packChitUserOperation({ ...operation, signature });
}

async function submitUserOperation(
  checkpoint: Checkpoint,
  account: Address,
): Promise<void> {
  if (await successfulTransaction(checkpoint.transactions.sponsoredUserOpTx)) return;
  const { operation, maxCost } = await unsignedOperation(checkpoint, account);
  const authorized = await authorizePaymaster(checkpoint, operation, maxCost);
  const packed = await signAccountOperation(checkpoint, authorized);
  const simulation = await publicClient.simulateContract({
    account: deployer,
    address: ENTRY_POINT_V07,
    abi: entryPoint07Abi,
    functionName: "handleOps",
    args: [[packed], deployer.address],
  });
  await sendStep(checkpoint, "sponsoredUserOpTx", "Self-bundling sponsored UserOperation...", () =>
    walletClient.writeContract({ ...simulation.request, gas: 5_000_000n }),
  );
}

async function settleEpoch(
  checkpoint: Checkpoint,
  account: Address,
): Promise<void> {
  const paymaster = requiredAddress(checkpoint, "chitPaymaster");
  const settlement = requiredAddress(checkpoint, "chitSettlement");
  const paymasterArtifact = await loadArtifact("ChitPaymaster", "ChitPaymaster");
  const settlementArtifact = await loadArtifact("ChitSettlement", "ChitSettlement");
  const claim = await publicClient.readContract({
    address: paymaster,
    abi: paymasterArtifact.abi,
    functionName: "claim",
    args: [0n, account],
  });
  if (typeof claim !== "bigint" || claim === 0n) {
    throw new Error("sponsored UserOperation produced no payable chit");
  }
  checkpoint.claimWei = claim.toString();
  await saveCheckpoint(checkpoint);
  await sendStep(checkpoint, "settleEpochTx", "Settling the encrypted sponsor epoch...", () =>
    walletClient.writeContract({
      address: settlement,
      abi: settlementArtifact.abi,
      functionName: "settleEpoch",
      args: [[account], [claim]],
      gas: 8_000_000n,
    }),
  );
}

function requireTransaction(checkpoint: Checkpoint, key: StepKey): Hex {
  const value = checkpoint.transactions[key];
  if (value === undefined) throw new Error(`${key} is missing`);
  return value;
}

async function finalizeEvidence(checkpoint: Checkpoint): Promise<void> {
  const record = {
    chainId: CHAIN_ID,
    entryPoint: ENTRY_POINT_V07,
    noxCompute: NOX_COMPUTE_SEPOLIA,
    simpleAccountFactory: SIMPLE_ACCOUNT_FACTORY_V07,
    ...checkpoint.addresses,
    simpleAccount: checkpoint.simpleAccount,
    deployTransactions: checkpoint.deployTransactions,
    sponsorFundTx: requireTransaction(checkpoint, "sponsorFundTx"),
    sponsorEnrollTx: requireTransaction(checkpoint, "sponsorEnrollTx"),
    sponsoredUserOpTx: requireTransaction(checkpoint, "sponsoredUserOpTx"),
    settleEpochTx: requireTransaction(checkpoint, "settleEpochTx"),
    setupTransactions: checkpoint.transactions,
    sponsorBudgetInputHandle: checkpoint.sponsorBudgetInputHandle,
    sponsorSlotInputHandle: checkpoint.sponsorSlotInputHandle,
    userOperationHash: checkpoint.userOperationHash,
    claimWei: checkpoint.claimWei,
    accountSalt: ACCOUNT_SALT.toString(),
    supersededDeployments: checkpoint.superseded,
  };
  parseDeploymentRecord(record);
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(record, null, 2)}\n`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    await preflight(0n);
    const evidence = JSON.parse(await readFile(EVIDENCE_PATH, "utf8")) as unknown;
    parseDeploymentRecord(evidence);
    console.log("Phase 2 evidence has a valid canonical shape");
    return;
  }
  const loaded = await loadCheckpoint();
  const isResume = Object.keys(loaded.addresses).length > 0;
  await preflight(parseEther(isResume ? "0.035" : "0.05"));
  const checkpoint = await migrateCheckpoint(loaded);
  await deployContracts(checkpoint);
  await configureSettlement(checkpoint);
  await fundSponsor(checkpoint);
  await depositPaymaster(checkpoint);
  const account = await resolveSimpleAccount(checkpoint);
  await enrollAccount(checkpoint, account);
  await submitUserOperation(checkpoint, account);
  await settleEpoch(checkpoint, account);
  await finalizeEvidence(checkpoint);
  console.log(`Phase 2 evidence written to ${EVIDENCE_PATH}`);
}

await main();
