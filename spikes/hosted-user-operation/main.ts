import {
  createWalletClient,
  custom,
  getAddress,
  isHex,
  size,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import {
  classifyWalletAccount,
  selectLegacyRabbyProvider,
  selectRabbyProvider,
  type InjectedWalletProvider,
} from "../../src/browser-nox.js";

const CREATOR = "0x34b0Ba20669f3ec4F1056853780c381e5e35F724" satisfies Address;

interface RabbyProvider extends EIP1193Provider {
  readonly isRabby?: boolean;
  readonly providers?: readonly RabbyProvider[];
}

interface PreparedOperation {
  readonly operation: Record<string, string>;
  readonly hash: Hex;
  readonly validUntil: number;
  readonly reservationSignature: Hex;
  readonly counterBefore: string;
}

interface SubmittedOperation {
  readonly transactionHash: Hex;
  readonly userOperationHash: Hex;
  readonly claimWei: string;
  readonly counterAfter: string;
}

interface ConfirmedStatus extends SubmittedOperation {
  readonly confirmed: boolean;
  readonly nonce: string;
  readonly accountDeployed: boolean;
}

declare global { interface Window { ethereum?: RabbyProvider } }

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing #${id}`);
  return value as T;
}

function setStatus(message: string, error = false): void {
  const status = element("status");
  status.textContent = message;
  status.classList.toggle("error", error);
}

function complete(step: string): void {
  document.querySelector(`[data-step="${step}"]`)?.classList.add("complete");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  throw new Error("Rabby Wallet is not available. Unlock Rabby and refresh.");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("UserOperation service returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function validHash(value: unknown): value is Hex {
  return typeof value === "string" && isHex(value) && size(value) === 32;
}

function validSignature(value: unknown): value is Hex {
  return typeof value === "string" && isHex(value) && size(value) === 65;
}

function preparedValue(value: unknown): PreparedOperation {
  const body = record(value);
  const operation = record(body.operation);
  if (!validHash(body.hash) || !Number.isSafeInteger(body.validUntil) ||
      !validSignature(body.reservationSignature) || typeof body.counterBefore !== "string" ||
      !Object.values(operation).every((item) => typeof item === "string")) {
    throw new Error("Prepared UserOperation is invalid");
  }
  return {
    operation: operation as Record<string, string>,
    hash: body.hash,
    validUntil: Number(body.validUntil),
    reservationSignature: body.reservationSignature,
    counterBefore: body.counterBefore,
  };
}

function submittedValue(value: unknown): SubmittedOperation {
  const body = record(value);
  if (!validHash(body.transactionHash) || !validHash(body.userOperationHash) ||
      typeof body.claimWei !== "string" || typeof body.counterAfter !== "string") {
    throw new Error("Submitted UserOperation response is invalid");
  }
  return {
    transactionHash: body.transactionHash,
    userOperationHash: body.userOperationHash,
    claimWei: body.claimWei,
    counterAfter: body.counterAfter,
  };
}

function confirmedStatusValue(value: unknown): ConfirmedStatus {
  const body = record(value);
  const submitted = submittedValue(body);
  if (typeof body.confirmed !== "boolean" || typeof body.nonce !== "string" ||
      typeof body.accountDeployed !== "boolean") {
    throw new Error("UserOperation status response is invalid");
  }
  return { ...submitted, confirmed: body.confirmed, nonce: body.nonce,
    accountDeployed: body.accountDeployed };
}

async function post(body: object): Promise<unknown> {
  const response = await fetch("/api/user-operation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(responseText || `UserOperation service failed (${response.status})`);
  }
  if (!response.ok) {
    const message = record(payload).error;
    throw new Error(typeof message === "string" ? message : `UserOperation service failed (${response.status})`);
  }
  return payload;
}

function transactionLink(hash: Hex): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = `https://eth-sepolia.blockscout.com/tx/${hash}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = hash;
  return link;
}

async function loadConfirmedStatus(): Promise<void> {
  const response = await fetch("/api/user-operation", { method: "GET" });
  if (!response.ok) return;
  const result = confirmedStatusValue(await response.json());
  if (!result.confirmed) return;
  for (const step of ["connect", "prepare", "sign", "bundle", "claim"]) complete(step);
  element("counter").textContent = `1 → ${result.counterAfter}`;
  element("userop").textContent = result.userOperationHash;
  element("transaction").replaceChildren(transactionLink(result.transactionHash));
  element("claim").textContent = `${result.claimWei} wei`;
  setStatus(`Confirmed on Sepolia · account nonce ${result.nonce}.`);
  const button = element<HTMLButtonElement>("run");
  button.textContent = "UserOperation confirmed";
  button.disabled = true;
}

async function run(): Promise<void> {
  const provider = await discoverRabby();
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (classifyWalletAccount(accounts, CREATOR).kind !== "match") {
    throw new Error(`Switch Rabby to the creator ${CREATOR}`);
  }
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
  complete("connect");
  setStatus("Authorizing the fixed operation against live Sepolia state…");
  const prepared = preparedValue(await post({ action: "prepare" }));
  complete("prepare");
  element("counter").textContent = `${prepared.counterBefore} → pending`;
  element("userop").textContent = prepared.hash;
  setStatus("Approve the EntryPoint hash signature in Rabby. This costs no wallet gas.");
  const wallet = createWalletClient({ account: CREATOR, chain: sepolia, transport: custom(provider) });
  const signature = await wallet.signMessage({ account: CREATOR, message: { raw: prepared.hash } });
  complete("sign");
  setStatus("Operator is simulating and submitting handleOps on Sepolia…");
  const result = submittedValue(await post({
    action: "submit",
    operation: prepared.operation,
    signature,
    validUntil: prepared.validUntil,
    reservationSignature: prepared.reservationSignature,
  }));
  complete("bundle");
  complete("claim");
  element("counter").textContent = `${prepared.counterBefore} → ${result.counterAfter}`;
  element("transaction").replaceChildren(transactionLink(result.transactionHash));
  element("claim").textContent = `${result.claimWei} wei`;
  setStatus("Sponsored UserOperation confirmed and Chit gas claim recorded.");
  element<HTMLButtonElement>("run").textContent = "UserOperation confirmed";
}

element<HTMLButtonElement>("run").addEventListener("click", async () => {
  const button = element<HTMLButtonElement>("run");
  button.disabled = true;
  try {
    await run();
  } catch (error) {
    setStatus(errorMessage(error), true);
    button.disabled = false;
  }
});

void loadConfirmedStatus().catch(() => undefined);
