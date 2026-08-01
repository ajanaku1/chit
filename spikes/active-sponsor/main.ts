import {
  createViemHandleClient,
  type HandleClient,
} from "@iexec-nox/handle";
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  recoverMessageAddress,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
  type WalletClient,
} from "viem";
import { sepolia } from "viem/chains";

import {
  ADMISSION_LIFETIME_SECONDS,
  SPONSOR_BUDGET,
  admissionIsUsable,
  nextActiveSponsorAction,
  parseActiveSponsorTarget,
  parseSponsorCheckpoint,
  type ActiveSponsorAction,
  type ActiveSponsorProgress,
  type ActiveSponsorTarget,
  type SponsorCheckpoint,
  type SponsorPendingLabel,
} from "../../src/active-sponsor.js";
import {
  assertNoxProof,
  assertSepolia,
  classifyWalletAccount,
  selectLegacyRabbyProvider,
  selectRabbyProvider,
  type InjectedWalletProvider,
} from "../../src/browser-nox.js";

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
const CHECKPOINT_PREFIX = "chit.active-sponsor.v1";
const tokenAbi = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
const wrapperAbi = parseAbi([
  "function isOperator(address holder,address spender) view returns (bool)",
  "function setOperator(address operator,uint48 until)",
  "function wrap(address to,uint256 amount) returns (bytes32)",
]);
const vaultAbi = parseAbi([
  "function active() view returns (bool)",
  "function creator() view returns (address)",
  "function factory() view returns (address)",
  "function wrapper() view returns (address)",
  "function admissionDigest(address sponsor,uint48 validUntil) view returns (bytes32)",
  "function sponsorCount() view returns (uint256)",
  "function sponsorAt(uint256 slot) view returns (address)",
  "function registeredSponsor(address sponsor) view returns (bool)",
  "function registerSponsor(bytes32 encryptedBudget,bytes inputProof,uint48 validUntil,bytes creatorSignature) returns (uint256)",
  "function budgetHandle(uint256 slot) view returns (bytes32)",
]);
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

interface EncryptedBudget {
  readonly handle: Hex;
  readonly handleProof: Hex;
}

interface PageState {
  account?: Address;
  checkpoint: SponsorCheckpoint;
  handleClient?: HandleClient;
  provider?: EIP1193Provider;
  target?: ActiveSponsorTarget;
  wallet?: WalletClient;
}

const state: PageState = { checkpoint: {} };

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing #${id}`);
  return value as T;
}

function short(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setStatus(message: string, error = false): void {
  const status = element("status");
  status.textContent = message;
  status.classList.toggle("error", error);
}

function complete(step: string, value: boolean): void {
  document
    .querySelector(`[data-step="${step}"]`)
    ?.classList.toggle("complete", value);
}

function requireTarget(): ActiveSponsorTarget {
  if (state.target === undefined) throw new Error("Active sponsor target is not loaded");
  return state.target;
}

function checkpointKey(): string {
  return `${CHECKPOINT_PREFIX}.${requireTarget().roundId}`;
}

async function requireSponsorWallet(): Promise<
  Required<Pick<PageState, "account" | "wallet">>
> {
  const target = requireTarget();
  if (state.provider === undefined || state.wallet === undefined) {
    throw new Error(`Switch Rabby to the previous sponsor ${target.sponsor}`);
  }
  const accounts = await state.provider.request({ method: "eth_accounts" });
  const connection = classifyWalletAccount(accounts, target.sponsor);
  if (connection.kind !== "match") {
    throw new Error(`Switch Rabby to the previous sponsor ${target.sponsor}`);
  }
  state.account = getAddress(connection.account);
  return { account: state.account, wallet: state.wallet };
}

function loadCheckpoint(): SponsorCheckpoint {
  const value = window.localStorage.getItem(checkpointKey());
  return value === null ? {} : parseSponsorCheckpoint(JSON.parse(value));
}

function saveCheckpoint(checkpoint: SponsorCheckpoint): void {
  state.checkpoint = checkpoint;
  window.localStorage.setItem(checkpointKey(), JSON.stringify(checkpoint));
  const hash = checkpoint.lastHash ?? checkpoint.pendingHash;
  if (hash !== undefined) element("transaction").textContent = short(hash);
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return response.json();
}

async function discoverRabby(): Promise<EIP1193Provider> {
  const announced: InjectedWalletProvider<EIP1193Provider>[] = [];
  function announce(event: Event): void {
    const detail = (event as CustomEvent<InjectedWalletProvider<EIP1193Provider>>).detail;
    if (!announced.some(({ provider }) => provider === detail.provider)) announced.push(detail);
  }
  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => window.setTimeout(resolve, 500));
  window.removeEventListener("eip6963:announceProvider", announce);
  if (announced.length > 0) return selectRabbyProvider(announced);
  if (window.ethereum?.providers !== undefined) {
    return selectLegacyRabbyProvider(window.ethereum.providers);
  }
  if (window.ethereum?.isRabby === true) return window.ethereum;
  throw new Error("Rabby did not announce itself. Unlock Rabby in Brave and refresh.");
}

async function connectExpected(expected: Address, role: string): Promise<WalletClient> {
  const provider = state.provider ?? await discoverRabby();
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const connection = classifyWalletAccount(accounts, expected);
  if (connection.kind === "none") throw new Error("Rabby returned no account");
  if (connection.kind === "mismatch") {
    throw new Error(`Switch Rabby to the ${role} ${expected}. Connected: ${connection.account}.`);
  }
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: "0xaa36a7" }],
  });
  const wallet = createWalletClient({ chain: sepolia, transport: custom(provider) });
  assertSepolia(await wallet.getChainId());
  state.provider = provider;
  state.account = getAddress(connection.account);
  state.wallet = wallet;
  return wallet;
}

async function liveAdmissionDigest(expiry: number): Promise<Hex> {
  const target = requireTarget();
  return publicClient.readContract({
    address: target.vault,
    abi: vaultAbi,
    functionName: "admissionDigest",
    args: [target.sponsor, expiry],
  });
}

async function signAdmission(): Promise<void> {
  const target = requireTarget();
  setStatus("Connect the creator wallet in Rabby, then approve the off-chain signature.");
  const wallet = await connectExpected(target.creator, "creator wallet");
  const expiry = Math.floor(Date.now() / 1_000) + ADMISSION_LIFETIME_SECONDS;
  const digest = await liveAdmissionDigest(expiry);
  const signature = await wallet.signMessage({
    account: target.creator,
    message: { raw: digest },
  });
  const recovered = await recoverMessageAddress({ message: { raw: digest }, signature });
  if (getAddress(recovered) !== target.creator) {
    throw new Error("Rabby signature did not recover to the creator wallet");
  }
  saveCheckpoint({
    ...state.checkpoint,
    admissionExpiry: expiry,
    admissionDigest: digest,
    admissionSignature: signature,
  });
}

async function confirmedCall(
  hash: Hash,
  from: Address,
  to: Address,
  input: Hex,
): Promise<boolean> {
  const [receipt, transaction] = await Promise.all([
    publicClient.getTransactionReceipt({ hash }),
    publicClient.getTransaction({ hash }),
  ]);
  if (receipt.status !== "success") throw new Error(`Saved transaction failed: ${hash}`);
  if (
    transaction.from.toLowerCase() !== from.toLowerCase() ||
    transaction.to?.toLowerCase() !== to.toLowerCase() ||
    transaction.input !== input
  ) {
    throw new Error(`Saved transaction does not match this sponsor flow: ${hash}`);
  }
  return true;
}

async function wrapIsConfirmed(target: ActiveSponsorTarget): Promise<boolean> {
  if (state.checkpoint.wrapTx === undefined) return false;
  const input = encodeFunctionData({
    abi: wrapperAbi,
    functionName: "wrap",
    args: [target.sponsor, SPONSOR_BUDGET],
  });
  return confirmedCall(state.checkpoint.wrapTx, target.sponsor, target.chitBudgetToken, input);
}

async function readProgress(): Promise<ActiveSponsorProgress> {
  const target = requireTarget();
  const [allowance, operator, registered] = await Promise.all([
    publicClient.readContract({ address: target.chitToken, abi: tokenAbi, functionName: "allowance", args: [target.sponsor, target.chitBudgetToken] }),
    publicClient.readContract({ address: target.chitBudgetToken, abi: wrapperAbi, functionName: "isOperator", args: [target.sponsor, target.vault] }),
    publicClient.readContract({ address: target.vault, abi: vaultAbi, functionName: "registeredSponsor", args: [target.sponsor] }),
  ]);
  const digest = state.checkpoint.admissionExpiry === undefined
    ? undefined
    : await liveAdmissionDigest(state.checkpoint.admissionExpiry);
  const admission = digest !== undefined &&
    admissionIsUsable(state.checkpoint, digest, Math.floor(Date.now() / 1_000));
  return {
    pending: state.checkpoint.pendingHash !== undefined,
    admission: registered || admission,
    sponsorWallet: registered || state.account === target.sponsor,
    allowance: registered || allowance >= SPONSOR_BUDGET,
    wrapped: registered || await wrapIsConfirmed(target),
    operator: registered || operator,
    registered,
  };
}

function updateSteps(progress: ActiveSponsorProgress, action: ActiveSponsorAction): void {
  complete("admission", progress.admission);
  complete("wallet", progress.sponsorWallet);
  complete("allowance", progress.allowance);
  complete("collateral", progress.wrapped);
  complete("operator", progress.operator);
  complete("proof", progress.registered || state.checkpoint.pendingLabel === "register");
  complete("register", progress.registered);
  document.querySelectorAll("li.current").forEach((item) => item.classList.remove("current"));
  const step = actionStep(action);
  if (step !== undefined) document.querySelector(`[data-step="${step}"]`)?.classList.add("current");
}

function actionStep(action: ActiveSponsorAction): string | undefined {
  const steps: Partial<Record<ActiveSponsorAction["kind"], string>> = {
    "sign-admission": "admission",
    "switch-sponsor": "wallet",
    "approve-token": "allowance",
    "wrap-token": "collateral",
    "authorize-vault": "operator",
    "register-sponsor": "proof",
  };
  return steps[action.kind];
}

function actionCopy(action: ActiveSponsorAction): readonly [string, string] {
  const copy: Record<ActiveSponsorAction["kind"], readonly [string, string]> = {
    "reconcile-pending": ["Resume pending transaction", "Resume confirmation"],
    "sign-admission": ["Connect the creator and sign a fresh admission. This costs no gas.", "Sign creator admission"],
    "switch-sponsor": ["Switch Rabby to the previous sponsor wallet, then continue.", "Connect previous sponsor"],
    "approve-token": ["Approve the wrapper to use 1,000 CHIT base units.", "Approve CHIT wrapper"],
    "wrap-token": ["Wrap 1,000 CHIT base units for this registration.", "Wrap sponsor budget"],
    "authorize-vault": ["Authorize only the new low-stake vault as transfer operator.", "Authorize new vault"],
    "register-sponsor": ["Create the 137-byte proof and register the sponsor on-chain.", "Create proof & register"],
    "complete": ["The previous sponsor is registered in the active low-stake round.", "Sponsor registered"],
  };
  return copy[action.kind];
}

async function displayRegisteredHandle(target: ActiveSponsorTarget): Promise<void> {
  const count = await publicClient.readContract({ address: target.vault, abi: vaultAbi, functionName: "sponsorCount" });
  for (let slot = 0n; slot < count; slot += 1n) {
    const sponsor = await publicClient.readContract({ address: target.vault, abi: vaultAbi, functionName: "sponsorAt", args: [slot] });
    if (sponsor.toLowerCase() !== target.sponsor.toLowerCase()) continue;
    const handle = await publicClient.readContract({ address: target.vault, abi: vaultAbi, functionName: "budgetHandle", args: [slot] });
    element("handle").textContent = short(handle);
    element("proof").textContent = "137 bytes";
    return;
  }
}

async function render(): Promise<ActiveSponsorAction> {
  const target = requireTarget();
  const progress = await readProgress();
  const action = nextActiveSponsorAction(progress);
  updateSteps(progress, action);
  const [message, label] = actionCopy(action);
  setStatus(message);
  element("admission").textContent = progress.admission ? "Creator signed" : "Not signed";
  const button = element<HTMLButtonElement>("run");
  button.textContent = label;
  button.disabled = action.kind === "complete";
  if (progress.registered) await displayRegisteredHandle(target);
  return action;
}

function withoutPending(): SponsorCheckpoint {
  const { pendingHash: _hash, pendingLabel: _label, ...remaining } = state.checkpoint;
  return remaining;
}

function recordConfirmed(label: SponsorPendingLabel, hash: Hash): void {
  const checkpoint = { ...withoutPending(), lastHash: hash };
  if (label === "wrap") saveCheckpoint({ ...checkpoint, wrapTx: hash });
  else if (label === "authorize") saveCheckpoint({ ...checkpoint, operatorTx: hash });
  else if (label === "register") saveCheckpoint({ ...checkpoint, registrationTx: hash });
  else if (label === "approve") saveCheckpoint(checkpoint);
  else throw new Error(`Unknown pending sponsor action: ${label}`);
}

async function reconcilePending(): Promise<void> {
  const { pendingHash, pendingLabel } = state.checkpoint;
  if (pendingHash === undefined || pendingLabel === undefined) {
    throw new Error("Pending transaction checkpoint is incomplete");
  }
  setStatus(`Waiting for ${pendingLabel} transaction confirmation…`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: pendingHash, confirmations: 1 });
  if (receipt.status !== "success") {
    saveCheckpoint(withoutPending());
    throw new Error(`Sepolia transaction failed: ${pendingHash}`);
  }
  recordConfirmed(pendingLabel, pendingHash);
}

async function trackTransaction(label: SponsorPendingLabel, promise: Promise<Hash>): Promise<void> {
  const hash = await promise;
  saveCheckpoint({ ...state.checkpoint, pendingHash: hash, pendingLabel: label });
  await reconcilePending();
}

async function approveToken(): Promise<void> {
  const target = requireTarget();
  const { account, wallet } = await requireSponsorWallet();
  const balance = await publicClient.readContract({ address: target.chitToken, abi: tokenAbi, functionName: "balanceOf", args: [account] });
  if (balance < SPONSOR_BUDGET) throw new Error("Previous sponsor has fewer than 1,000 CHIT base units");
  setStatus("Approve the CHIT wrapper transaction in Rabby.");
  await trackTransaction("approve", wallet.writeContract({
    account, address: target.chitToken, abi: tokenAbi, functionName: "approve",
    args: [target.chitBudgetToken, SPONSOR_BUDGET], chain: sepolia,
  }));
}

async function wrapToken(): Promise<void> {
  const target = requireTarget();
  const { account, wallet } = await requireSponsorWallet();
  setStatus("Approve wrapping 1,000 CHIT base units in Rabby.");
  await trackTransaction("wrap", wallet.writeContract({
    account, address: target.chitBudgetToken, abi: wrapperAbi, functionName: "wrap",
    args: [account, SPONSOR_BUDGET], chain: sepolia,
  }));
}

async function authorizeVault(): Promise<void> {
  const target = requireTarget();
  const { account, wallet } = await requireSponsorWallet();
  const expiry = state.checkpoint.admissionExpiry;
  if (expiry === undefined) throw new Error("Sign the creator admission first");
  setStatus("Approve the new vault operator authorization in Rabby.");
  await trackTransaction("authorize", wallet.writeContract({
    account, address: target.chitBudgetToken, abi: wrapperAbi, functionName: "setOperator",
    args: [target.vault, expiry], chain: sepolia,
  }));
}

async function encryptedBudget(): Promise<EncryptedBudget> {
  const target = requireTarget();
  const wallet = state.wallet;
  if (wallet === undefined) throw new Error("Connect the sponsor wallet first");
  state.handleClient ??= await createViemHandleClient(wallet);
  const encrypted = await state.handleClient.encryptInput(SPONSOR_BUDGET, "uint256", target.vault);
  assertNoxProof(encrypted.handleProof);
  element("proof").textContent = "137 bytes";
  complete("proof", true);
  return encrypted;
}

async function registerSponsor(): Promise<void> {
  const target = requireTarget();
  const { account, wallet } = await requireSponsorWallet();
  const { admissionExpiry, admissionSignature } = state.checkpoint;
  if (admissionExpiry === undefined || admissionSignature === undefined) {
    throw new Error("Sign the creator admission first");
  }
  setStatus("Requesting a vault-bound proof from the Nox gateway…");
  const encrypted = await encryptedBudget();
  const digest = await liveAdmissionDigest(admissionExpiry);
  if (!admissionIsUsable(state.checkpoint, digest, Math.floor(Date.now() / 1_000))) {
    throw new Error("Creator admission expired while creating the Nox proof; sign a fresh one");
  }
  setStatus("Approve the sponsor registration transaction in Rabby.");
  await trackTransaction("register", wallet.writeContract({
    account, address: target.vault, abi: vaultAbi, functionName: "registerSponsor",
    args: [encrypted.handle, encrypted.handleProof, admissionExpiry, admissionSignature], chain: sepolia,
  }));
}

async function execute(action: ActiveSponsorAction): Promise<void> {
  const target = requireTarget();
  if (action.kind === "reconcile-pending") await reconcilePending();
  else if (action.kind === "sign-admission") await signAdmission();
  else if (action.kind === "switch-sponsor") {
    setStatus("Switch Rabby to the previous sponsor, then approve the connection.");
    await connectExpected(target.sponsor, "previous sponsor wallet");
  } else if (action.kind === "approve-token") await approveToken();
  else if (action.kind === "wrap-token") await wrapToken();
  else if (action.kind === "authorize-vault") await authorizeVault();
  else if (action.kind === "register-sponsor") await registerSponsor();
}

async function runNext(): Promise<void> {
  const button = element<HTMLButtonElement>("run");
  button.disabled = true;
  try {
    await execute(await render());
    await render();
  } catch (error) {
    setStatus(errorMessage(error), true);
    button.disabled = false;
  }
}

async function assertLiveTarget(target: ActiveSponsorTarget): Promise<void> {
  const [active, creator, factory, wrapper] = await Promise.all([
    publicClient.readContract({ address: target.vault, abi: vaultAbi, functionName: "active" }),
    publicClient.readContract({ address: target.vault, abi: vaultAbi, functionName: "creator" }),
    publicClient.readContract({ address: target.vault, abi: vaultAbi, functionName: "factory" }),
    publicClient.readContract({ address: target.vault, abi: vaultAbi, functionName: "wrapper" }),
  ]);
  if (!active) throw new Error("The low-stake vault is not active");
  if (creator !== target.creator || factory !== target.factory || wrapper !== target.chitBudgetToken) {
    throw new Error("Live vault roles do not match the deployment evidence");
  }
}

async function initialize(): Promise<void> {
  const [round, assets] = await Promise.all([
    fetchJson("../../deployments/low-stake-round.json"),
    fetchJson("../../deployments/sepolia.json"),
  ]);
  const target = parseActiveSponsorTarget(round, assets);
  await assertLiveTarget(target);
  state.target = target;
  state.checkpoint = loadCheckpoint();
  element("creator").textContent = short(target.creator);
  element("sponsor").textContent = short(target.sponsor);
  element("vault").textContent = short(target.vault);
  if (state.checkpoint.admissionSignature !== undefined) {
    element("admission").textContent = "Creator signed";
  }
  await render();
}

element("run").addEventListener("click", () => void runNext());
void initialize().catch((error: unknown) => {
  setStatus(errorMessage(error), true);
});
