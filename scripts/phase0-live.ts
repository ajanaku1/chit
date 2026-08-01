import { createViemHandleClient, type Handle } from "@iexec-nox/handle";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isHex,
  size,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const DEFAULT_RPC_URL = "https://sepolia.drpc.org";
const GATEWAY_URL = "https://gateway-testnets.noxprotocol.dev";
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const BUDGET = 1_000_000n;
const PROOF_BYTES = 137;

interface ContractArtifact {
  abi: Abi;
  bytecode: Hex;
}

interface ImportedBudget {
  contractAddress: Address;
  fromExternalTx: Hex;
  inputHandle: Hex;
  budgetHandle: Handle<"uint256">;
  proofBytes: number;
}

interface GateStatus {
  auditorDecrypt: boolean;
  nonAuditorDenied: boolean;
  handleResolved: boolean;
}

interface HandleStatusResponse {
  payload?: {
    statuses?: Array<{ handle?: string; resolved?: boolean }>;
  };
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

async function loadArtifact(): Promise<ContractArtifact> {
  const artifactPath = path.resolve(
    "artifacts/contracts/ConfidentialPaymaster.sol/ConfidentialPaymaster.json",
  );
  const parsed = JSON.parse(await readFile(artifactPath, "utf8")) as ContractArtifact;
  if (!Array.isArray(parsed.abi) || !isHex(parsed.bytecode)) {
    throw new Error("ConfidentialPaymaster artifact is malformed");
  }
  return parsed;
}

async function loadEvidence(): Promise<ImportedBudget> {
  const evidencePath = path.resolve("deployments/phase0-live.json");
  const value = JSON.parse(await readFile(evidencePath, "utf8")) as Record<
    string,
    unknown
  >;
  if (
    typeof value.contractAddress !== "string" ||
    !isAddress(value.contractAddress) ||
    typeof value.fromExternalTx !== "string" ||
    !isHex(value.fromExternalTx) ||
    size(value.fromExternalTx) !== 32 ||
    typeof value.inputHandle !== "string" ||
    value.proofBytes !== PROOF_BYTES
  ) {
    throw new Error("Phase 0 evidence is malformed");
  }
  return {
    contractAddress: value.contractAddress,
    fromExternalTx: value.fromExternalTx,
    inputHandle: asUint256Handle(value.inputHandle),
    budgetHandle: asUint256Handle(value.budgetHandle),
    proofBytes: value.proofBytes,
  };
}

async function confirmTransaction(hash: Hex): Promise<Address | undefined> {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`Sepolia transaction failed: ${hash}`);
  }
  return receipt.contractAddress ?? undefined;
}

async function deployPaymaster(artifact: ContractArtifact): Promise<Address> {
  console.log("Deploying the Phase 0 paymaster to Sepolia...");
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [ENTRY_POINT, deployer.address],
  });
  const contractAddress = await confirmTransaction(hash);
  if (contractAddress === undefined) {
    throw new Error("Deployment receipt did not include a contract address");
  }
  return contractAddress;
}

function asUint256Handle(value: unknown): Handle<"uint256"> {
  if (typeof value !== "string" || !isHex(value) || size(value) !== 32) {
    throw new Error("Contract returned an invalid budget handle");
  }
  return value;
}

async function importBudget(
  artifact: ContractArtifact,
  contractAddress: Address,
): Promise<ImportedBudget> {
  console.log("Requesting a real encrypted input from the Nox gateway...");
  const handleClient = await createViemHandleClient(walletClient);
  const encrypted = await handleClient.encryptInput(
    BUDGET,
    "uint256",
    contractAddress,
  );
  const proofBytes = validateProof(encrypted.handleProof);
  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: artifact.abi,
    functionName: "openSponsor",
    args: [encrypted.handle, encrypted.handleProof],
  });
  await confirmTransaction(hash);
  return {
    contractAddress,
    fromExternalTx: hash,
    inputHandle: encrypted.handle,
    budgetHandle: await readBudgetHandle(artifact.abi, contractAddress),
    proofBytes,
  };
}

function validateProof(proof: Hex): number {
  const proofBytes = size(proof);
  if (proofBytes !== PROOF_BYTES) {
    throw new Error(`Expected a ${PROOF_BYTES}-byte proof, received ${proofBytes}`);
  }
  return proofBytes;
}

async function readBudgetHandle(
  abi: Abi,
  contractAddress: Address,
): Promise<Handle<"uint256">> {
  const handle = await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: "budgetHandle",
    args: [0n],
  });
  return asUint256Handle(handle);
}

async function isHandleResolved(handle: Hex): Promise<boolean> {
  const response = await requestHandleStatus(handle);
  if (response === undefined) return false;
  if (!response.ok) return false;
  const data = (await response.json()) as HandleStatusResponse;
  return (
    data.payload?.statuses?.some(
      (status) =>
        status.handle?.toLowerCase() === handle.toLowerCase() &&
        status.resolved === true,
    ) ?? false
  );
}

async function requestHandleStatus(handle: Hex): Promise<Response | undefined> {
  try {
    return await fetch(`${GATEWAY_URL}/v0/public/handles/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handles: [handle] }),
    });
  } catch {
    return undefined;
  }
}

async function waitForHandle(handle: Hex): Promise<void> {
  console.log("Waiting for the live Sepolia handle to resolve...");
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    if (await isHandleResolved(handle)) return;
    if (attempt % 6 === 0) console.log(`Still resolving (${attempt * 5}s)...`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Nox gateway did not resolve the handle within five minutes");
}

async function verifyAuditorAccess(handle: Handle<"uint256">): Promise<void> {
  console.log("Checking auditor-only decryption...");
  await decryptAsAuditor(handle);
  const outsiderClient = await createViemHandleClient(
    createWalletClient({
      account: privateKeyToAccount(generatePrivateKey()),
      chain: sepolia,
      transport: http(rpcUrl),
    }),
  );
  try {
    await outsiderClient.decrypt(handle);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not authorized")) return;
    throw error;
  }
  throw new Error("A non-auditor decrypted the sponsor budget");
}

async function decryptAsAuditor(handle: Handle<"uint256">): Promise<void> {
  const auditorClient = await createViemHandleClient(walletClient);
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const decrypted = await auditorClient.decrypt(handle);
      if (decrypted.value !== BUDGET) {
        throw new Error(`Auditor decrypted an unexpected value: ${decrypted.value}`);
      }
      return;
    } catch (error) {
      if (!isGatewayAclLag(error) || attempt === 60) throw error;
      if (attempt % 6 === 0) console.log(`ACL still syncing (${attempt * 5}s)...`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

function isGatewayAclLag(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Access denied: not a viewer")
  );
}

async function recordEvidence(
  imported: ImportedBudget,
  status: GateStatus,
): Promise<void> {
  const evidence = {
    network: "ethereum-sepolia",
    chainId: sepolia.id,
    ...imported,
    ...status,
  };
  const outputPath = path.resolve("deployments/phase0-live.json");
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Phase 0 evidence recorded at ${outputPath}`);
}

async function main(): Promise<void> {
  const artifact = await loadArtifact();
  const contractAddress = await deployPaymaster(artifact);
  const imported = await importBudget(artifact, contractAddress);
  const pending = {
    auditorDecrypt: false,
    nonAuditorDenied: false,
    handleResolved: false,
  };
  await recordEvidence(imported, pending);
  await waitForHandle(imported.budgetHandle);
  await recordEvidence(imported, { ...pending, handleResolved: true });
  await verifyAuditorAccess(imported.budgetHandle);
  await recordEvidence(imported, {
    auditorDecrypt: true,
    nonAuditorDenied: true,
    handleResolved: true,
  });
}

async function verifyExistingEvidence(): Promise<void> {
  const evidence = await loadEvidence();
  await confirmTransaction(evidence.fromExternalTx);
  if (!(await isHandleResolved(evidence.budgetHandle))) {
    throw new Error("Recorded Nox handle is not resolved");
  }
  await verifyAuditorAccess(evidence.budgetHandle);
  console.log("Phase 0 live evidence verified without sending transactions.");
}

if (process.argv.includes("--verify")) {
  await verifyExistingEvidence();
} else {
  await main();
}
