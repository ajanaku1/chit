import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  encodeDeployData,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
  type TransactionReceipt,
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
  LOW_STAKE_PROFILE,
  assertLowStakeBalance,
  clearFailedFactoryDeployment,
  nextLowStakeAction,
  parseFactoryBytecode,
  parseLowStakeRound,
  parseRecoveryCheckpoint,
  type LowStakeAction,
  type LowStakeRound,
  type RecoveryCheckpoint,
} from "../../src/low-stake-round.js";
import {
  assertOperatorRotationSupported,
  parseServiceOperatorRecord,
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

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const ROUND_SALT = keccak256(stringToHex("chit-low-stake-recovery-v1"));
const CHECKPOINT_KEY = "chit.low-stake-round.v1";
const FACTORY_ABI = parseAbi([
  "constructor(address entryPoint_, address wrapper_, uint256 minimumStake_)",
  "function minimumStake() view returns (uint256)",
  "function roundId(address creator, bytes32 salt) pure returns (bytes32)",
  "function beginRound(bytes32 salt,address operator,address verifier,address auditor) returns (bytes32)",
  "function initializeRoundStep(bytes32 id,uint8 step)",
  "function getRound(bytes32 id) view returns ((address creator,address operator,address verifier,address auditor,address vault,address settlement,address paymaster,uint8 initializedSteps))",
  "function activateRound(bytes32 id,uint256 paymasterDeposit,uint256 stake,uint32 unstakeDelay,uint256 operatorGas) payable",
]);
const PAYMASTER_ABI = parseAbi([
  "function roundState() view returns (uint8)",
  "function operator() view returns (address)",
  "function verifier() view returns (address)",
  "function entryPointBalance() view returns (uint256)",
  "function stakeInfo() view returns (uint112 stake,uint32 unstakeDelay,bool staked)",
]);
const SETTLEMENT_ABI = parseAbi(["function operator() view returns (address)"]);
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

interface DeploymentInputs {
  readonly record: ServiceOperatorRecord;
  readonly wrapper: Address;
  readonly factoryBytecode: Hex;
}

interface PageState {
  account?: Address;
  checkpoint: RecoveryCheckpoint;
  factory?: Address;
  inputs?: DeploymentInputs;
  wallet?: WalletClient;
}

interface ProgressSnapshot {
  readonly factory?: Address;
  readonly round?: LowStakeRound;
  readonly roundId?: Hex;
  readonly roundState?: number;
}

const state: PageState = { checkpoint: {} };

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

function loadCheckpoint(): RecoveryCheckpoint {
  const saved = window.localStorage.getItem(CHECKPOINT_KEY);
  return saved === null ? {} : parseRecoveryCheckpoint(JSON.parse(saved));
}

function saveCheckpoint(checkpoint: RecoveryCheckpoint): void {
  state.checkpoint = checkpoint;
  window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
  if (checkpoint.lastHash !== undefined) {
    element("transaction").textContent = short(checkpoint.lastHash);
  }
}

function clearPending(lastHash: Hex): void {
  const { pendingHash: _hash, pendingLabel: _label, ...rest } = state.checkpoint;
  saveCheckpoint({ ...rest, lastHash });
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

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return response.json();
}

function recordAddress(value: unknown, field: string): Address {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} source is malformed`);
  }
  const address = (value as Record<string, unknown>)[field];
  if (typeof address !== "string") throw new Error(`${field} is missing`);
  return getAddress(address);
}

async function loadInputs(): Promise<void> {
  const [service, gate, artifact] = await Promise.all([
    fetchJson("../../deployments/service-operator.json"),
    fetchJson("../../deployments/factory-browser-gate.json"),
    fetchJson("../../artifacts/contracts/ChitRoundFactory.sol/ChitRoundFactory.json"),
  ]);
  const record = parseServiceOperatorRecord(service);
  state.inputs = {
    record,
    wrapper: recordAddress(gate, "chitBudgetToken"),
    factoryBytecode: parseFactoryBytecode(artifact),
  };
  element("creator").textContent = short(record.creator);
  element("operator").textContent = short(record.serviceOperator);
  if (state.checkpoint.factory !== undefined) {
    element("factory").textContent = short(state.checkpoint.factory);
  }
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

function requireInputs(): DeploymentInputs {
  if (state.inputs === undefined) throw new Error("Recovery inputs are not loaded");
  return state.inputs;
}

async function requestCreator(provider: EIP1193Provider): Promise<Address> {
  const { record } = requireInputs();
  const existing = connectedWalletAddress(await withTimeout(
    provider.request({ method: "eth_accounts" }),
    "Rabby account check",
  ));
  const accounts = existing === undefined
    ? await withTimeout(
        provider.request({ method: "eth_requestAccounts" }),
        "Rabby connection",
      )
    : [existing];
  const connection = classifyWalletAccount(accounts, record.creator);
  if (connection.kind === "none") throw new Error("Rabby returned no account");
  if (connection.kind === "mismatch") {
    throw new Error(`Rabby: ${connection.account}. Required creator: ${connection.expected}.`);
  }
  return connection.account;
}

async function connect(): Promise<void> {
  const provider = await discoverRabby();
  const account = await requestCreator(provider);
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
}

function connected(): {
  readonly account: Address;
  readonly inputs: DeploymentInputs;
  readonly wallet: WalletClient;
} {
  if (state.account === undefined || state.wallet === undefined) {
    throw new Error("Connect the creator wallet first");
  }
  return { account: state.account, inputs: requireInputs(), wallet: state.wallet };
}

async function receipt(hash: Hash): Promise<TransactionReceipt> {
  return withTimeout(
    publicClient.waitForTransactionReceipt({ hash, confirmations: 1 }),
    "Sepolia confirmation",
    240_000,
  );
}

async function confirm(hash: Hash, label: string): Promise<TransactionReceipt> {
  saveCheckpoint({
    ...state.checkpoint,
    pendingHash: hash,
    pendingLabel: label,
    lastHash: hash,
  });
  setStatus(`Waiting for ${label} confirmation…`);
  const confirmed = await receipt(hash);
  clearPending(hash);
  if (confirmed.status !== "success") {
    throw new Error(`${label} reverted: ${hash}`);
  }
  return confirmed;
}

async function confirmFactoryDeployment(hash: Hex): Promise<void> {
  try {
    await confirm(hash, "factory deployment");
  } catch (error) {
    const deployed = await publicClient
      .getTransactionReceipt({ hash })
      .catch(() => undefined);
    if (deployed?.status === "reverted") {
      state.factory = undefined;
      saveCheckpoint(clearFailedFactoryDeployment(state.checkpoint, hash));
    }
    throw error;
  }
}

async function reconcilePending(): Promise<void> {
  const { pendingHash, pendingLabel = "transaction" } = state.checkpoint;
  if (pendingHash === undefined) return;
  await confirm(pendingHash, pendingLabel);
}

function factoryDeploymentData(inputs: DeploymentInputs): Hex {
  return encodeDeployData({
    abi: FACTORY_ABI,
    bytecode: inputs.factoryBytecode,
    args: [ENTRY_POINT, inputs.wrapper, LOW_STAKE_PROFILE.minimumStake],
  });
}

async function verifiedFactoryAddress(hash: Hex): Promise<Address> {
  const { record } = requireInputs();
  const [deployed, transaction] = await Promise.all([
    publicClient.getTransactionReceipt({ hash }),
    publicClient.getTransaction({ hash }),
  ]);
  const address = deployed.contractAddress;
  if (deployed.status !== "success" || address === null || address === undefined) {
    throw new Error("Recorded factory deployment did not succeed");
  }
  if (
    transaction.to !== null ||
    !sameAddress(transaction.from, record.creator) ||
    transaction.input.toLowerCase() !== factoryDeploymentData(requireInputs()).toLowerCase()
  ) {
    throw new Error("Recorded factory deployment provenance is invalid");
  }
  if (
    state.checkpoint.factory !== undefined &&
    !sameAddress(state.checkpoint.factory, address)
  ) {
    throw new Error("Stored factory does not match its deployment receipt");
  }
  return address;
}

async function resolveFactory(): Promise<Address | undefined> {
  if (state.factory !== undefined) return state.factory;
  const hash = state.checkpoint.factoryDeployTx;
  if (hash === undefined) return undefined;
  const factory = await verifiedFactoryAddress(hash);
  state.factory = factory;
  saveCheckpoint({ ...state.checkpoint, factory });
  return factory;
}

async function deployFactory(): Promise<void> {
  if (await resolveFactory() !== undefined) return;
  const { account, inputs, wallet } = connected();
  assertLowStakeBalance(await publicClient.getBalance({ address: account }));
  const args = [ENTRY_POINT, inputs.wrapper, LOW_STAKE_PROFILE.minimumStake] as const;
  const data = factoryDeploymentData(inputs);
  await publicClient.estimateGas({
    account,
    data,
  });
  setStatus("Approve the compatible factory deployment in Rabby…");
  const hash = await wallet.deployContract({
    account,
    chain: sepolia,
    abi: FACTORY_ABI,
    bytecode: inputs.factoryBytecode,
    args,
  });
  saveCheckpoint({ ...state.checkpoint, factoryDeployTx: hash });
  await confirmFactoryDeployment(hash);
  const factory = await resolveFactory();
  if (factory === undefined) throw new Error("Factory deployment was not recorded");
  element("factory").textContent = short(factory);
  complete("factory");
}

function missingRound(error: unknown): boolean {
  return error instanceof BaseError &&
    error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null;
}

async function readRound(factory: Address, roundId: Hex): Promise<LowStakeRound | undefined> {
  try {
    return parseLowStakeRound(await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: "getRound",
      args: [roundId],
    }));
  } catch (error) {
    if (missingRound(error)) return undefined;
    throw error;
  }
}

async function roundIdentity(factory: Address): Promise<Hex> {
  const { account } = connected();
  return publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "roundId",
    args: [account, ROUND_SALT],
  });
}

async function beginRound(factory: Address): Promise<void> {
  const { account, inputs, wallet } = connected();
  setStatus("Approve the service-wired round creation in Rabby…");
  const { request } = await publicClient.simulateContract({
    account,
    address: factory,
    abi: FACTORY_ABI,
    functionName: "beginRound",
    args: [ROUND_SALT, inputs.record.serviceOperator, inputs.record.serviceOperator, account],
  });
  await confirm(await wallet.writeContract(request), "round creation");
  complete("round");
}

async function initializeStep(factory: Address, roundId: Hex, step: number): Promise<void> {
  const { account, wallet } = connected();
  setStatus(`Approve Nox initialization step ${step + 1} of 5 in Rabby…`);
  const { request } = await publicClient.simulateContract({
    account,
    address: factory,
    abi: FACTORY_ABI,
    functionName: "initializeRoundStep",
    args: [roundId, step],
  });
  await confirm(await wallet.writeContract(request), `Nox initialization ${step + 1}`);
}

async function activateRound(factory: Address, roundId: Hex): Promise<void> {
  const { account, wallet } = connected();
  const profile = LOW_STAKE_PROFILE;
  const value = profile.paymasterDeposit + profile.minimumStake + profile.operatorGas;
  setStatus(`Approve ${formatEther(value)} ETH round activation in Rabby…`);
  const { request } = await publicClient.simulateContract({
    account,
    address: factory,
    abi: FACTORY_ABI,
    functionName: "activateRound",
    args: [
      roundId,
      profile.paymasterDeposit,
      profile.minimumStake,
      profile.unstakeDelay,
      profile.operatorGas,
    ],
    value,
  });
  await confirm(await wallet.writeContract(request), "round activation");
  complete("activate");
}

async function roundState(round: LowStakeRound): Promise<number> {
  return publicClient.readContract({
    address: round.paymaster,
    abi: PAYMASTER_ABI,
    functionName: "roundState",
  });
}

async function progress(): Promise<ProgressSnapshot> {
  const factory = await resolveFactory();
  if (factory === undefined) return {};
  complete("factory");
  element("factory").textContent = short(factory);
  const roundId = await roundIdentity(factory);
  const round = await readRound(factory, roundId);
  if (round === undefined) return { factory };
  complete("round");
  element("paymaster").textContent = short(round.paymaster);
  if (round.initializedSteps === 31) complete("initialize");
  return { factory, round, roundId, roundState: await roundState(round) };
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function verifyRound(factory: Address, round: LowStakeRound): Promise<void> {
  const { account, inputs } = connected();
  const [minimum, roles, stake, deposit, paymasterCode, settlementCode] = await Promise.all([
    publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: "minimumStake" }),
    Promise.all([
      publicClient.readContract({ address: round.paymaster, abi: PAYMASTER_ABI, functionName: "operator" }),
      publicClient.readContract({ address: round.paymaster, abi: PAYMASTER_ABI, functionName: "verifier" }),
      publicClient.readContract({ address: round.settlement, abi: SETTLEMENT_ABI, functionName: "operator" }),
    ]),
    publicClient.readContract({ address: round.paymaster, abi: PAYMASTER_ABI, functionName: "stakeInfo" }),
    publicClient.readContract({ address: round.paymaster, abi: PAYMASTER_ABI, functionName: "entryPointBalance" }),
    publicClient.getCode({ address: round.paymaster }),
    publicClient.getCode({ address: round.settlement }),
  ]);
  const roleMismatch = roles.some((role) => !sameAddress(role, inputs.record.serviceOperator));
  if (!sameAddress(round.creator, account) || !sameAddress(round.auditor, account) || roleMismatch) {
    throw new Error("New round roles do not match the creator and service target");
  }
  if (minimum !== LOW_STAKE_PROFILE.minimumStake || stake[0] !== minimum || !stake[2]) {
    throw new Error("New round stake does not match the disclosed 0.1 ETH profile");
  }
  if (stake[1] !== LOW_STAKE_PROFILE.unstakeDelay || deposit !== LOW_STAKE_PROFILE.paymasterDeposit) {
    throw new Error("New round deposit or unstake delay is incorrect");
  }
  assertOperatorRotationSupported(paymasterCode ?? "0x", settlementCode ?? "0x");
}

function requireFactory(current: ProgressSnapshot): Address {
  if (current.factory === undefined) throw new Error("Factory is not deployed");
  return current.factory;
}

function requireRoundId(current: ProgressSnapshot): Hex {
  if (current.roundId === undefined) throw new Error("Round id is not available");
  return current.roundId;
}

function requireRound(current: ProgressSnapshot): LowStakeRound {
  if (current.round === undefined) throw new Error("Round is not created");
  return current.round;
}

function plannedAction(current: ProgressSnapshot): LowStakeAction {
  return nextLowStakeAction({
    pending: state.checkpoint.pendingHash !== undefined,
    factory: current.factory !== undefined,
    ...(current.factory === undefined ? {} : { round: current.round !== undefined }),
    ...(current.round === undefined ? {} : {
      initializationMask: current.round.initializedSteps,
      roundState: current.roundState,
    }),
  });
}

async function executeAction(
  action: LowStakeAction,
  current: ProgressSnapshot,
): Promise<boolean> {
  if (action.kind === "reconcile-pending") await reconcilePending();
  if (action.kind === "deploy-factory") await deployFactory();
  if (action.kind === "begin-round") await beginRound(requireFactory(current));
  if (action.kind === "initialize") {
    await initializeStep(requireFactory(current), requireRoundId(current), action.step);
  }
  if (action.kind === "activate") {
    await activateRound(requireFactory(current), requireRoundId(current));
  }
  if (action.kind !== "complete") return false;
  await verifyRound(requireFactory(current), requireRound(current));
  complete("activate");
  setStatus("Compatible low-stake round is live on Sepolia.");
  return true;
}

async function runRecovery(): Promise<void> {
  for (;;) {
    const current = await progress();
    if (await executeAction(plannedAction(current), current)) return;
  }
}

async function run(): Promise<void> {
  const button = element<HTMLButtonElement>("run");
  button.disabled = true;
  try {
    if (state.wallet === undefined) await connect();
    await runRecovery();
    button.textContent = "Round deployed";
  } catch (error) {
    setStatus(errorMessage(error));
    button.textContent = state.wallet === undefined ? "Continue with Rabby" : "Resume deployment";
    button.disabled = false;
  }
}

async function initialize(): Promise<void> {
  try {
    state.checkpoint = loadCheckpoint();
    await loadInputs();
    if (state.checkpoint.lastHash !== undefined) {
      element("transaction").textContent = short(state.checkpoint.lastHash);
    }
    setStatus("Ready. The wallet will approve only unfinished Sepolia stages.");
    element<HTMLButtonElement>("run").disabled = false;
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

element("run").addEventListener("click", () => void run());
void initialize();
