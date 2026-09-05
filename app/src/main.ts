import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  getAddress,
  http,
  parseAbi,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
  type WalletClient,
} from "viem";
import { sepolia } from "viem/chains";
import {
  assertSepolia,
  connectedWalletAddress,
  selectLegacyRabbyProvider,
  selectRabbyProvider,
  type InjectedWalletProvider,
} from "../../src/browser-nox.js";
import { parseLowStakeRound, type LowStakeRound } from "../../src/low-stake-round.js";
import { LIVE_PROFILE } from "./live-profile.js";
import {
  canEditRoundLabel,
  deriveRoundSalt,
  nextRoundAction,
  parseRoundCheckpoint,
  type RoundAction,
  type RoundCheckpoint,
  type RoundProgress,
} from "./round-machine.js";

interface RabbyProvider extends EIP1193Provider {
  readonly isRabby?: boolean;
  readonly providers?: readonly RabbyProvider[];
}

declare global {
  interface Window { ethereum?: RabbyProvider; }
}

const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const FACTORY_ABI = parseAbi([
  "function minimumStake() view returns (uint256)",
  "function roundId(address creator,bytes32 salt) pure returns (bytes32)",
  "function beginRound(bytes32 salt,address operator,address verifier,address auditor) returns (bytes32)",
  "function initializeRoundStep(bytes32 id,uint8 step)",
  "function getRound(bytes32 id) view returns ((address creator,address operator,address verifier,address auditor,address vault,address settlement,address paymaster,uint8 initializedSteps))",
  "function activateRound(bytes32 id,uint256 paymasterDeposit,uint256 stake,uint32 unstakeDelay,uint256 operatorGas) payable",
]);
const PAYMASTER_ABI = parseAbi(["function roundState() view returns (uint8)"]);
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

interface ConnectedState {
  readonly account: Address;
  readonly wallet: WalletClient;
}

interface ProgressView extends RoundProgress {
  readonly roundId: Hex;
  readonly round?: LowStakeRound;
}

interface AppState {
  account?: Address;
  checkpoint?: RoundCheckpoint;
  storageKey?: string;
  wallet?: WalletClient;
}

const state: AppState = {};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing #${id}`);
  return found as T;
}

function short(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setStatus(message: string, isError = false): void {
  const status = element("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function setCopyContractStatus(message: string, isError = false): void {
  const status = element("copy-contract-status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function copyContractAddress(): Promise<void> {
  try {
    await navigator.clipboard.writeText(element("contract-address").textContent ?? "");
    setCopyContractStatus("Copied.");
  } catch {
    setCopyContractStatus("Copy failed. Try again.", true);
  }
}

function roundLabel(): string {
  return element<HTMLInputElement>("round-label").value;
}

function connected(): ConnectedState {
  if (state.account === undefined || state.wallet === undefined) {
    throw new Error("Connect Rabby before creating a round");
  }
  return { account: state.account, wallet: state.wallet };
}

async function discoverRabby(): Promise<EIP1193Provider> {
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
  if (window.ethereum?.providers !== undefined) return selectLegacyRabbyProvider(window.ethereum.providers);
  if (window.ethereum?.isRabby === true) return window.ethereum;
  throw new Error("Rabby Wallet is unavailable. Unlock Rabby in Brave and refresh.");
}

async function connectRabby(): Promise<void> {
  setStatus("Approve the Rabby connection, then switch to Ethereum Sepolia.");
  const provider = await discoverRabby();
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const account = connectedWalletAddress(accounts);
  if (account === undefined) throw new Error("Rabby returned no connected account");
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
  const wallet = createWalletClient({ chain: sepolia, transport: custom(provider) });
  assertSepolia(await wallet.getChainId());
  state.account = getAddress(account);
  state.wallet = wallet;
  element("creator-address").textContent = short(state.account);
}

function checkpointKey(account: Address, label: string): string {
  return `chit.app.round.${deriveRoundSalt(label, account)}`;
}

function prepareCheckpoint(): void {
  const { account } = connected();
  const label = roundLabel().trim().replace(/\s+/g, " ");
  const key = checkpointKey(account, label);
  const saved = window.localStorage.getItem(key);
  state.checkpoint = saved === null ? { label } : parseRoundCheckpoint(JSON.parse(saved));
  state.storageKey = key;
  element<HTMLInputElement>("round-label").disabled = true;
}

function requireCheckpoint(): RoundCheckpoint {
  if (state.checkpoint === undefined) throw new Error("Choose a round name first");
  return state.checkpoint;
}

function saveCheckpoint(checkpoint: RoundCheckpoint): void {
  if (state.storageKey === undefined) throw new Error("Round checkpoint key is missing");
  state.checkpoint = checkpoint;
  window.localStorage.setItem(state.storageKey, JSON.stringify(checkpoint));
  if (checkpoint.lastHash !== undefined) renderTransaction(checkpoint.lastHash);
}

function renderTransaction(hash: Hash): void {
  const link = document.createElement("a");
  link.href = `https://eth-sepolia.blockscout.com/tx/${hash}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = short(hash);
  element("last-transaction").replaceChildren(link);
}

function withoutPending(lastHash?: Hash): RoundCheckpoint {
  const { label } = requireCheckpoint();
  return { label, ...(lastHash === undefined ? {} : { lastHash }) };
}

async function confirm(hash: Hash, label: string): Promise<void> {
  saveCheckpoint({ ...requireCheckpoint(), pendingHash: hash, pendingLabel: label });
  setStatus(`Waiting for ${label} confirmation on Sepolia…`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 240_000 });
  saveCheckpoint(withoutPending(hash));
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
}

function missingRound(error: unknown): boolean {
  return error instanceof BaseError &&
    error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null;
}

async function readRound(roundId: Hex): Promise<LowStakeRound | undefined> {
  try {
    const result = await publicClient.readContract({
      address: LIVE_PROFILE.factory,
      abi: FACTORY_ABI,
      functionName: "getRound",
      args: [roundId],
    });
    return parseLowStakeRound(result);
  } catch (error) {
    if (missingRound(error)) return undefined;
    throw error;
  }
}

async function readProgress(): Promise<ProgressView> {
  const { account } = connected();
  const salt = deriveRoundSalt(requireCheckpoint().label, account);
  const roundId = await publicClient.readContract({
    address: LIVE_PROFILE.factory,
    abi: FACTORY_ABI,
    functionName: "roundId",
    args: [account, salt],
  });
  const round = await readRound(roundId);
  if (round === undefined) {
    return { roundId, pending: requireCheckpoint().pendingHash !== undefined, exists: false, initializationMask: 0 };
  }
  const roundState = await publicClient.readContract({ address: round.paymaster, abi: PAYMASTER_ABI, functionName: "roundState" });
  return { roundId, round, roundState, pending: requireCheckpoint().pendingHash !== undefined, exists: true, initializationMask: round.initializedSteps };
}

function actionCopy(action: RoundAction): readonly [string, string] {
  if (action.kind === "reconcile") return ["A saved transaction needs confirmation before another write.", "Resume confirmation"];
  if (action.kind === "begin") return ["Create this round’s vault, settlement, and paymaster through the compatible factory.", "Create shared round"];
  if (action.kind === "initialize") return [`Initialize encrypted Nox state ${action.step + 1} of 5.`, `Initialize Nox ${action.step + 1} / 5`];
  if (action.kind === "activate") return [`Stake and activate this round with ${formatEther(LIVE_PROFILE.activationValue)} Sepolia ETH.`, "Activate & stake"];
  return ["This sponsorship round is active on Ethereum Sepolia.", "Create another round"];
}

function markStep(step: string, complete: boolean): void {
  document.querySelector(`[data-step="${step}"]`)?.classList.toggle("complete", complete);
}

function renderSteps(progress: ProgressView, action: RoundAction): void {
  markStep("connect", true);
  markStep("begin", progress.exists);
  markStep("initialize", progress.initializationMask === 31);
  markStep("activate", progress.roundState === 1);
  document.querySelectorAll(".steps li.current").forEach((item) => item.classList.remove("current"));
  const current = action.kind === "reconcile" ? undefined : action.kind;
  if (current !== undefined && current !== "complete") {
    document.querySelector(`[data-step="${current}"]`)?.classList.add("current");
  }
  const initialized = progress.initializationMask.toString(2).replace(/0/g, "").length;
  element("initialization-count").textContent = `${initialized} / 5`;
}

function renderRound(progress: ProgressView): void {
  element("round-id").textContent = short(progress.roundId);
  element("vault-address").textContent = progress.round === undefined ? "Not created" : short(progress.round.vault);
  element("paymaster-address").textContent = progress.round === undefined ? "Not created" : short(progress.round.paymaster);
  const lastHash = requireCheckpoint().lastHash ?? requireCheckpoint().pendingHash;
  if (lastHash !== undefined) renderTransaction(lastHash);
}

function renderNameControl(progress: ProgressView): void {
  element<HTMLButtonElement>("change-name").hidden = !canEditRoundLabel(progress);
}

async function render(): Promise<RoundAction> {
  const progress = await readProgress();
  const action = nextRoundAction(progress);
  renderSteps(progress, action);
  renderRound(progress);
  renderNameControl(progress);
  const [message, label] = actionCopy(action);
  setStatus(message);
  const button = element<HTMLButtonElement>("run");
  button.textContent = label;
  button.disabled = false;
  return action;
}

async function beginRound(): Promise<void> {
  const { account, wallet } = connected();
  const salt = deriveRoundSalt(requireCheckpoint().label, account);
  setStatus("Approve round creation in Rabby.");
  const { request } = await publicClient.simulateContract({
    account, address: LIVE_PROFILE.factory, abi: FACTORY_ABI, functionName: "beginRound",
    args: [salt, LIVE_PROFILE.operator, LIVE_PROFILE.operator, account],
  });
  await confirm(await wallet.writeContract(request), "round creation");
}

async function initializeRound(roundId: Hex, step: number): Promise<void> {
  const { account, wallet } = connected();
  setStatus(`Approve Nox initialization ${step + 1} of 5 in Rabby.`);
  const { request } = await publicClient.simulateContract({
    account, address: LIVE_PROFILE.factory, abi: FACTORY_ABI,
    functionName: "initializeRoundStep", args: [roundId, step],
  });
  await confirm(await wallet.writeContract(request), `Nox initialization ${step + 1}`);
}

async function activateRound(roundId: Hex): Promise<void> {
  const { account, wallet } = connected();
  setStatus(`Approve ${formatEther(LIVE_PROFILE.activationValue)} ETH activation in Rabby.`);
  const { request } = await publicClient.simulateContract({
    account, address: LIVE_PROFILE.factory, abi: FACTORY_ABI,
    functionName: "activateRound",
    args: [roundId, LIVE_PROFILE.paymasterDeposit, LIVE_PROFILE.minimumStake, LIVE_PROFILE.unstakeDelay, LIVE_PROFILE.operatorGas],
    value: LIVE_PROFILE.activationValue,
  });
  await confirm(await wallet.writeContract(request), "round activation");
}

async function reconcile(): Promise<void> {
  const checkpoint = requireCheckpoint();
  if (checkpoint.pendingHash === undefined || checkpoint.pendingLabel === undefined) {
    throw new Error("Saved transaction checkpoint is incomplete");
  }
  await confirm(checkpoint.pendingHash, checkpoint.pendingLabel);
}

async function execute(action: RoundAction, roundId: Hex): Promise<void> {
  if (action.kind === "reconcile") await reconcile();
  else if (action.kind === "begin") await beginRound();
  else if (action.kind === "initialize") await initializeRound(roundId, action.step);
  else if (action.kind === "activate") await activateRound(roundId);
}

function resetRoundForm(): void {
  delete state.checkpoint;
  delete state.storageKey;
  const input = element<HTMLInputElement>("round-label");
  input.disabled = false;
  input.value = "New community round";
  input.focus();
  setStatus("Choose a new round name, then continue with the connected creator wallet.");
  const button = element<HTMLButtonElement>("run");
  button.textContent = "Use this round name";
  button.disabled = false;
}

function clearPreparedRound(): void {
  if (state.storageKey !== undefined) window.localStorage.removeItem(state.storageKey);
  delete state.checkpoint;
  delete state.storageKey;
  const input = element<HTMLInputElement>("round-label");
  input.disabled = false;
  input.focus();
  element<HTMLButtonElement>("change-name").hidden = true;
  setStatus("Edit the public round name, then create the shared contracts.");
}

async function changeRoundName(): Promise<void> {
  const progress = await readProgress();
  if (!canEditRoundLabel(progress)) {
    throw new Error("The round name is locked because creation has started");
  }
  clearPreparedRound();
}

async function run(): Promise<void> {
  const button = element<HTMLButtonElement>("run");
  const changeName = element<HTMLButtonElement>("change-name");
  button.disabled = true;
  changeName.disabled = true;
  try {
    if (state.account === undefined) {
      await connectRabby();
      prepareCheckpoint();
      await render();
      return;
    }
    if (state.checkpoint === undefined) prepareCheckpoint();
    const progress = await readProgress();
    const action = nextRoundAction(progress);
    if (action.kind === "complete") resetRoundForm();
    else {
      await execute(action, progress.roundId);
      await render();
    }
  } catch (error) {
    setStatus(errorMessage(error), true);
    button.disabled = false;
  } finally {
    changeName.disabled = false;
  }
}

async function initialize(): Promise<void> {
  const [code, minimumStake] = await Promise.all([
    publicClient.getCode({ address: LIVE_PROFILE.factory }),
    publicClient.readContract({ address: LIVE_PROFILE.factory, abi: FACTORY_ABI, functionName: "minimumStake" }),
  ]);
  if (code === undefined || code === "0x" || minimumStake !== LIVE_PROFILE.minimumStake) {
    throw new Error("The compatible Sepolia factory failed its live check");
  }
  setStatus("Factory verified. Connect Rabby to create a new shared sponsorship round.");
  const button = element<HTMLButtonElement>("run");
  button.textContent = "Connect Rabby";
  button.disabled = false;
}

element("operator-address").textContent = short(LIVE_PROFILE.operator);
element("factory-address").textContent = short(LIVE_PROFILE.factory);
element("run").addEventListener("click", () => void run());
element("copy-contract-address").addEventListener("click", () => void copyContractAddress());
element("change-name").addEventListener("click", () => {
  void changeRoundName().catch((error: unknown) => setStatus(errorMessage(error), true));
});
element("round-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run();
});
void initialize().catch((error: unknown) => setStatus(errorMessage(error), true));
