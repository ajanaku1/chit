import {
  NotYetComputedHandleError,
  UnknownHandleError,
  createViemHandleClient,
  type Handle,
  type HandleClient,
} from "@iexec-nox/handle";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  type Address,
  type EIP1193Provider,
  type Hash,
  type WalletClient,
} from "viem";
import { sepolia } from "viem/chains";

import {
  assertAdmissionFresh,
  assertGateSponsor,
  assertNoxProof,
  assertSepolia,
  parseFactoryGateEvidence,
  selectRabbyProvider,
  type FactoryGateEvidence,
  type InjectedWalletProvider,
} from "../../src/browser-nox.js";

interface RabbyProvider extends EIP1193Provider {
  readonly isRabby?: boolean;
}

declare global {
  interface Window {
    ethereum?: RabbyProvider;
  }
}

const RPC_URL = "https://sepolia.drpc.org";
const SPONSOR_BUDGET = 1_000n;
const tokenAbi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
const wrapperAbi = parseAbi([
  "function setOperator(address operator, uint48 until)",
  "function wrap(address to, uint256 amount) returns (bytes32)",
]);
const vaultAbi = parseAbi([
  "function sponsorCount() view returns (uint256)",
  "function sponsorAt(uint256 slot) view returns (address)",
  "function registeredSponsor(address sponsor) view returns (bool)",
  "function registerSponsor(bytes32 encryptedBudget, bytes inputProof, uint48 validUntil, bytes creatorSignature) returns (uint256)",
  "function budgetHandle(uint256 slot) view returns (bytes32)",
]);
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

interface GateState {
  account?: Address;
  client?: HandleClient;
  gate?: FactoryGateEvidence;
  handle?: Handle<"uint256">;
  wallet?: WalletClient;
}

interface EncryptedBudget {
  readonly handle: `0x${string}`;
  readonly handleProof: `0x${string}`;
}

const state: GateState = {};

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing #${id}`);
  return value as T;
}

function setStatus(message: string): void {
  element("status").textContent = message;
}

function complete(step: string): void {
  document.querySelector(`[data-step="${step}"]`)?.classList.add("complete");
}

function short(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${label} timed out after 30 seconds`)),
      30_000,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function discoverRabby(): Promise<EIP1193Provider> {
  const providers: InjectedWalletProvider<EIP1193Provider>[] = [];
  const announce = (event: Event): void => {
    const detail = (event as CustomEvent<InjectedWalletProvider<EIP1193Provider>>).detail;
    if (!providers.some(({ provider }) => provider === detail.provider)) providers.push(detail);
  };
  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => window.setTimeout(resolve, 500));
  window.removeEventListener("eip6963:announceProvider", announce);
  if (providers.length > 0) return selectRabbyProvider(providers);
  if (window.ethereum?.isRabby === true) return window.ethereum;
  throw new Error("Rabby Wallet did not announce itself. Unlock Rabby and refresh this page.");
}

async function connectWallet(): Promise<void> {
  setStatus("Finding Rabby Wallet…");
  const provider = await discoverRabby();
  setStatus("Approve this site's connection request in Rabby…");
  await withTimeout(provider.request({ method: "eth_requestAccounts" }), "Rabby connection");
  setStatus("Approve the switch to Ethereum Sepolia in Rabby…");
  await withTimeout(
    provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] }),
    "Sepolia network switch",
  );
  const wallet = createWalletClient({ chain: sepolia, transport: custom(provider) });
  const [account] = await wallet.getAddresses();
  if (account === undefined) throw new Error("The wallet returned no account");
  assertSepolia(await wallet.getChainId());
  state.account = account;
  state.wallet = wallet;
  if (state.gate === undefined) throw new Error("The factory gate record was not loaded");
  assertGateSponsor(state.gate.sponsor, account);
  setStatus("Rabby connected. Initializing the Nox gateway client…");
  state.client = await createViemHandleClient(wallet);
  element("account").textContent = short(account);
  complete("wallet");
}

async function loadGateEvidence(): Promise<void> {
  const response = await fetch("../../deployments/factory-browser-gate.json", {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load factory gate (${response.status})`);
  state.gate = parseFactoryGateEvidence(await response.json());
  element("vault").textContent = short(state.gate.vault);
}

async function confirm(hash: Hash): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`Sepolia transaction failed: ${hash}`);
}

function connectedState(): Required<Pick<GateState, "account" | "gate" | "wallet">> {
  if (state.account === undefined || state.gate === undefined || state.wallet === undefined) {
    throw new Error("Connect the admitted Rabby wallet first");
  }
  return { account: state.account, gate: state.gate, wallet: state.wallet };
}

async function approveAndWrap(): Promise<void> {
  const { account, gate, wallet } = connectedState();
  const balance = await publicClient.readContract({
    address: gate.chitToken,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [account],
  });
  if (balance < SPONSOR_BUDGET) throw new Error("The admitted wallet has insufficient CHIT");
  await ensureAllowance(account, gate, wallet);
  setStatus("Approve wrapping 1,000 CHIT base units in Rabby…");
  await confirm(await wallet.writeContract({
    account,
    address: gate.chitBudgetToken,
    abi: wrapperAbi,
    functionName: "wrap",
    args: [account, SPONSOR_BUDGET],
    chain: sepolia,
  }));
  complete("collateral");
}

async function ensureAllowance(
  account: Address,
  gate: FactoryGateEvidence,
  wallet: WalletClient,
): Promise<void> {
  const allowance = await publicClient.readContract({
    address: gate.chitToken,
    abi: tokenAbi,
    functionName: "allowance",
    args: [account, gate.chitBudgetToken],
  });
  if (allowance >= SPONSOR_BUDGET) return;
  setStatus("Approve the confidential CHIT wrapper in Rabby…");
  await confirm(await wallet.writeContract({
    account,
    address: gate.chitToken,
    abi: tokenAbi,
    functionName: "approve",
    args: [gate.chitBudgetToken, SPONSOR_BUDGET],
    chain: sepolia,
  }));
}

async function authorizeVault(): Promise<void> {
  const { account, gate, wallet } = connectedState();
  setStatus("Authorize this round's vault as the confidential transfer operator…");
  await confirm(await wallet.writeContract({
    account,
    address: gate.chitBudgetToken,
    abi: wrapperAbi,
    functionName: "setOperator",
    args: [gate.vault, gate.admissionExpiry],
    chain: sepolia,
  }));
  complete("operator");
}

async function waitForAcl(handle: Handle<"uint256">): Promise<void> {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    try {
      await state.client?.viewACL(handle);
      return;
    } catch (error) {
      const pending = error instanceof NotYetComputedHandleError || error instanceof UnknownHandleError;
      if (!pending || attempt === 35) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 5_000));
    }
  }
}

async function registerEncryptedBudget(): Promise<Hash> {
  const { gate } = connectedState();
  const slot = await nextSponsorSlot(gate);
  const encrypted = await encryptBudget(gate);
  const hash = await submitSponsorRegistration(gate, encrypted);
  await confirm(hash);
  complete("register");
  state.handle = await publicClient.readContract({
    address: gate.vault,
    abi: vaultAbi,
    functionName: "budgetHandle",
    args: [slot],
  });
  return hash;
}

async function nextSponsorSlot(gate: FactoryGateEvidence): Promise<bigint> {
  const slot = await publicClient.readContract({
    address: gate.vault,
    abi: vaultAbi,
    functionName: "sponsorCount",
  });
  if (slot >= 4n) throw new Error("This round has no free sponsor slot");
  return slot;
}

async function encryptBudget(gate: FactoryGateEvidence): Promise<EncryptedBudget> {
  if (state.client === undefined) throw new Error("Initialize the Nox client first");
  const encrypted = await state.client.encryptInput(SPONSOR_BUDGET, "uint256", gate.vault);
  assertNoxProof(encrypted.handleProof);
  element("proof").textContent = "137 bytes";
  complete("proof");
  return encrypted;
}

async function submitSponsorRegistration(
  gate: FactoryGateEvidence,
  encrypted: EncryptedBudget,
): Promise<Hash> {
  const { account, wallet } = connectedState();
  return wallet.writeContract({
    account,
    address: gate.vault,
    abi: vaultAbi,
    functionName: "registerSponsor",
    args: [
      encrypted.handle,
      encrypted.handleProof,
      gate.admissionExpiry,
      gate.admissionSignature,
    ],
    chain: sepolia,
  });
}

async function assertSponsorUnregistered(gate: FactoryGateEvidence): Promise<void> {
  const registered = await publicClient.readContract({
    address: gate.vault,
    abi: vaultAbi,
    functionName: "registeredSponsor",
    args: [gate.sponsor],
  });
  if (registered) throw new Error("This Rabby wallet is already registered in the round");
}

async function finishGate(hash: Hash): Promise<void> {
  element("transaction").textContent = short(hash);
  if (state.handle === undefined) throw new Error("The vault returned no budget handle");
  element("handle").textContent = short(state.handle);
  setStatus("Transaction confirmed. Waiting for the Nox ACL to resolve…");
  await waitForAcl(state.handle);
  complete("resolve");
  element<HTMLButtonElement>("decrypt").disabled = false;
  setStatus("Gate passed. Test whether the connected wallet is an allowed viewer.");
}

async function executeGate(): Promise<void> {
  setStatus("Loading the live factory round…");
  await loadGateEvidence();
  if (state.gate === undefined) throw new Error("The factory gate record was not loaded");
  assertAdmissionFresh(state.gate.admissionExpiry, Math.floor(Date.now() / 1_000));
  await connectWallet();
  await assertSponsorUnregistered(state.gate);
  await approveAndWrap();
  await authorizeVault();
  setStatus("Requesting the vault-bound 137-byte proof from the live Nox gateway…");
  await finishGate(await registerEncryptedBudget());
}

async function runGate(): Promise<void> {
  const button = element<HTMLButtonElement>("run");
  button.disabled = true;
  try {
    await executeGate();
  } catch (error) {
    setStatus(`Gate stopped: ${errorMessage(error)}`);
    button.disabled = false;
  }
}

async function testAccess(): Promise<void> {
  if (state.client === undefined || state.handle === undefined) return;
  const button = element<HTMLButtonElement>("decrypt");
  button.disabled = true;
  try {
    const decrypted = await state.client.decrypt(state.handle);
    setStatus(`Viewer allowed. Decrypted value: ${decrypted.value.toString()}.`);
  } catch (error) {
    setStatus(`Viewer denied as expected for a non-auditor: ${errorMessage(error)}`);
  } finally {
    button.disabled = false;
  }
}

element("run").addEventListener("click", () => void runGate());
element("decrypt").addEventListener("click", () => void testAccess());
