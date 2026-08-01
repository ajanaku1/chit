import {
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  http,
  parseAbi,
  parseEther,
  type Address,
  type EIP1193Provider,
  type Hash,
  type WalletClient,
} from "viem";
import { sepolia } from "viem/chains";
import {
  assertSepolia,
  classifyWalletAccount,
  connectedWalletAddress,
  selectLegacyRabbyProvider,
  selectRabbyProvider,
  type InjectedWalletProvider,
} from "../../src/browser-nox.js";
import {
  assertOperatorRotationSupported,
  parseServiceOperatorRecord,
  planServiceRoleRotation,
  UnsupportedRotationError,
  type RoleRotationStep,
  type RoundServiceRoles,
  type ServiceOperatorRecord,
} from "../../src/service-role-rotation.js";

interface RabbyProvider extends EIP1193Provider {
  readonly isRabby?: boolean;
  readonly providers?: readonly RabbyProvider[];
}

declare global {
  interface Window {
    ethereum?: RabbyProvider;
  }
}

const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const SERVICE_GAS_TARGET = parseEther("0.02");
const PAYMASTER_ABI = parseAbi([
  "function creator() view returns (address)",
  "function operator() view returns (address)",
  "function verifier() view returns (address)",
  "function setOperator(address operator)",
  "function setVerifier(address verifier)",
]);
const SETTLEMENT_ABI = parseAbi([
  "function operator() view returns (address)",
  "function setOperator(address operator)",
]);
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

interface PageState {
  account?: Address;
  record?: ServiceOperatorRecord;
  wallet?: WalletClient;
}

const state: PageState = {};

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

function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeout = 30_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeout,
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

async function loadRecord(): Promise<void> {
  const response = await fetch("../../deployments/service-operator.json", {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load service target (${response.status})`);
  const record = parseServiceOperatorRecord(await response.json());
  state.record = record;
  element("creator").textContent = short(record.creator);
  element("operator").textContent = short(record.serviceOperator);
  element("paymaster").textContent = short(record.paymaster);
  element("settlement").textContent = short(record.settlement);
  setStatus("Ready. Continue with the recorded creator account in Rabby.");
}

async function discoverRabby(): Promise<EIP1193Provider> {
  setStatus("Looking for Rabby Wallet in Brave…");
  const providers: InjectedWalletProvider<EIP1193Provider>[] = [];
  function announce(event: Event): void {
    const detail = (event as CustomEvent<InjectedWalletProvider<EIP1193Provider>>).detail;
    if (!providers.some(({ provider }) => provider === detail.provider)) providers.push(detail);
  }
  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => window.setTimeout(resolve, 500));
  window.removeEventListener("eip6963:announceProvider", announce);
  if (providers.length > 0) return selectRabbyProvider(providers);
  if (window.ethereum?.providers !== undefined) {
    return selectLegacyRabbyProvider(window.ethereum.providers);
  }
  if (window.ethereum?.isRabby === true) return window.ethereum;
  throw new Error("Rabby did not announce itself. Unlock Rabby and refresh.");
}

async function connectedAccount(provider: EIP1193Provider): Promise<Address> {
  setStatus("Checking the existing Rabby connection…");
  const existing = connectedWalletAddress(await withTimeout(
    provider.request({ method: "eth_accounts" }),
    "Rabby account check",
  ));
  if (existing !== undefined) return existing;
  setStatus("Approve the pending connection inside Rabby…");
  const requested = connectedWalletAddress(await withTimeout(
    provider.request({ method: "eth_requestAccounts" }),
    "Rabby connection",
  ));
  if (requested === undefined) throw new Error("Rabby returned no account");
  return requested;
}

async function restoreAuthorizedWallet(): Promise<void> {
  const record = requireRecord();
  const provider = await discoverRabby();
  const accounts = await withTimeout(
    provider.request({ method: "eth_accounts" }),
    "Rabby account check",
  );
  const connection = classifyWalletAccount(accounts, record.creator);
  const button = element<HTMLButtonElement>("run");
  if (connection.kind === "none") {
    setStatus("Rabby has not authorized an account for this page yet.");
    return;
  }
  if (connection.kind === "mismatch") {
    button.textContent = "Re-check Rabby account";
    setStatus(`Rabby: ${connection.account}. Required creator: ${connection.expected}.`);
    return;
  }
  const wallet = createWalletClient({ chain: sepolia, transport: custom(provider) });
  if (await wallet.getChainId() !== sepolia.id) {
    button.textContent = "Switch to Sepolia";
    setStatus(`Creator ${connection.account} is connected. Switch it to Sepolia.`);
    return;
  }
  await requireRotationCapabilities(record);
  state.account = connection.account;
  state.wallet = wallet;
  complete("wallet");
  button.textContent = "Protect service roles";
  setStatus(`Creator ${connection.account} is connected on Sepolia.`);
}

async function connect(): Promise<void> {
  const record = requireRecord();
  const provider = await discoverRabby();
  const account = await connectedAccount(provider);
  if (classifyWalletAccount([account], record.creator).kind !== "match") {
    throw new Error(`Rabby: ${account}. Required creator: ${record.creator}.`);
  }
  setStatus("Approve the switch to Ethereum Sepolia in Rabby…");
  await withTimeout(
    provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    }),
    "Sepolia network switch",
  );
  const wallet = createWalletClient({ chain: sepolia, transport: custom(provider) });
  assertSepolia(await wallet.getChainId());
  state.account = account;
  state.wallet = wallet;
  complete("wallet");
  element<HTMLButtonElement>("run").textContent = "Protect service roles";
}

function requireRecord(): ServiceOperatorRecord {
  if (state.record === undefined) throw new Error("Service target is not loaded");
  return state.record;
}

function connected(): {
  readonly account: Address;
  readonly record: ServiceOperatorRecord;
  readonly wallet: WalletClient;
} {
  if (state.account === undefined || state.wallet === undefined) {
    throw new Error("Connect the creator wallet first");
  }
  return { account: state.account, record: requireRecord(), wallet: state.wallet };
}

async function confirm(hash: Hash): Promise<void> {
  element("transaction").textContent = short(hash);
  const receipt = await withTimeout(
    publicClient.waitForTransactionReceipt({ hash, confirmations: 1 }),
    "Sepolia confirmation",
    240_000,
  );
  if (receipt.status !== "success") throw new Error(`Sepolia transaction reverted: ${hash}`);
}

async function fundService(): Promise<void> {
  const { account, record, wallet } = connected();
  const balance = await publicClient.getBalance({ address: record.serviceOperator });
  if (balance < SERVICE_GAS_TARGET) {
    setStatus(`Approve ${formatEther(SERVICE_GAS_TARGET - balance)} ETH service gas in Rabby…`);
    await confirm(await wallet.sendTransaction({
      account,
      chain: sepolia,
      to: record.serviceOperator,
      value: SERVICE_GAS_TARGET - balance,
    }));
  }
  complete("fund");
}

async function readRoles(record: ServiceOperatorRecord): Promise<RoundServiceRoles> {
  const [verifier, paymasterOperator, settlementOperator] = await Promise.all([
    publicClient.readContract({
      address: record.paymaster, abi: PAYMASTER_ABI, functionName: "verifier",
    }),
    publicClient.readContract({
      address: record.paymaster, abi: PAYMASTER_ABI, functionName: "operator",
    }),
    publicClient.readContract({
      address: record.settlement, abi: SETTLEMENT_ABI, functionName: "operator",
    }),
  ]);
  return { verifier, paymasterOperator, settlementOperator };
}

async function requireLiveCreator(record: ServiceOperatorRecord): Promise<void> {
  const creator = await publicClient.readContract({
    address: record.paymaster,
    abi: PAYMASTER_ABI,
    functionName: "creator",
  });
  if (creator.toLowerCase() !== record.creator.toLowerCase()) {
    throw new Error("Public target creator does not match the live paymaster");
  }
}

async function requireRotationCapabilities(
  record: ServiceOperatorRecord,
): Promise<void> {
  const [paymasterCode, settlementCode] = await Promise.all([
    publicClient.getCode({ address: record.paymaster }),
    publicClient.getCode({ address: record.settlement }),
  ]);
  assertOperatorRotationSupported(
    paymasterCode ?? "0x",
    settlementCode ?? "0x",
  );
}

function stepTarget(record: ServiceOperatorRecord, step: RoleRotationStep): Address {
  return step.contract === "paymaster" ? record.paymaster : record.settlement;
}

function stepAbi(step: RoleRotationStep): typeof PAYMASTER_ABI | typeof SETTLEMENT_ABI {
  return step.contract === "paymaster" ? PAYMASTER_ABI : SETTLEMENT_ABI;
}

function stepLabel(step: RoleRotationStep): string {
  if (step.functionName === "setVerifier") return "verifier";
  return step.contract;
}

function markCurrentRoles(
  roles: RoundServiceRoles,
  service: Address,
): void {
  if (roles.verifier.toLowerCase() === service.toLowerCase()) complete("verifier");
  if (roles.paymasterOperator.toLowerCase() === service.toLowerCase()) {
    complete("paymaster");
  }
  if (roles.settlementOperator.toLowerCase() === service.toLowerCase()) {
    complete("settlement");
  }
}

async function rotateStep(step: RoleRotationStep): Promise<void> {
  const { account, record, wallet } = connected();
  setStatus(`Approve ${stepLabel(step)} rotation in Rabby…`);
  await confirm(await wallet.writeContract({
    account,
    chain: sepolia,
    address: stepTarget(record, step),
    abi: stepAbi(step),
    functionName: step.functionName,
    args: [record.serviceOperator],
  }));
  complete(stepLabel(step));
}

async function run(): Promise<void> {
  const button = element<HTMLButtonElement>("run");
  button.disabled = true;
  try {
    if (state.wallet === undefined) await connect();
    const record = requireRecord();
    await requireLiveCreator(record);
    await requireRotationCapabilities(record);
    await fundService();
    const roles = await readRoles(record);
    markCurrentRoles(roles, record.serviceOperator);
    const steps = planServiceRoleRotation(roles, record.serviceOperator);
    for (const step of steps) await rotateStep(step);
    if (planServiceRoleRotation(await readRoles(record), record.serviceOperator).length !== 0) {
      throw new Error("Live roles did not converge on the service operator");
    }
    setStatus("Protected service roles are live on Sepolia.");
    button.textContent = "Roles protected";
  } catch (error) {
    displayRunError(error, button);
  }
}

function displayRunError(error: unknown, button: HTMLButtonElement): void {
  setStatus(errorMessage(error));
  if (error instanceof UnsupportedRotationError) {
    button.textContent = "New round required";
    button.disabled = true;
    return;
  }
  button.textContent = state.wallet === undefined ? "Continue with Rabby" : "Resume rotation";
  button.disabled = false;
}

element("run").addEventListener("click", () => void run());

async function initialize(): Promise<void> {
  const button = element<HTMLButtonElement>("run");
  try {
    await loadRecord();
    await restoreAuthorizedWallet();
    button.disabled = false;
  } catch (error) {
    displayRunError(error, button);
  }
}

void initialize();
