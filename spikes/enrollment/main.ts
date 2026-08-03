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

interface Challenge {
  readonly account: Address;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly message: string;
}

interface EnrollmentResult {
  readonly account: Address;
  readonly transactionHash: Hex;
}

declare global {
  interface Window { ethereum?: RabbyProvider }
}

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
  if (window.ethereum?.providers !== undefined) return selectLegacyRabbyProvider(window.ethereum.providers);
  if (window.ethereum?.isRabby === true) return window.ethereum;
  throw new Error("Rabby Wallet is not available. Unlock Rabby and refresh.");
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

function challengeValue(value: unknown): Challenge {
  const record = objectValue(value, "Challenge");
  if (typeof record.account !== "string" || typeof record.nonce !== "string" ||
      typeof record.expiresAt !== "number" || typeof record.message !== "string") {
    throw new Error("Challenge returned an invalid response");
  }
  return { account: getAddress(record.account), nonce: record.nonce,
    expiresAt: record.expiresAt, message: record.message };
}

function enrollmentValue(value: unknown): EnrollmentResult {
  const record = objectValue(value, "Enrollment");
  if (typeof record.account !== "string" ||
      typeof record.transactionHash !== "string" || !isHex(record.transactionHash) ||
      size(record.transactionHash) !== 32) {
    throw new Error("Enrollment returned an invalid response");
  }
  return { account: getAddress(record.account), transactionHash: record.transactionHash as Hex };
}

async function post(body: object): Promise<unknown> {
  const response = await fetch("/api/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Operator service is unavailable (${response.status})`);
  return response.json();
}

async function runEnrollment(): Promise<void> {
  const provider = await discoverRabby();
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const connection = classifyWalletAccount(accounts, CREATOR);
  if (connection.kind !== "match") throw new Error(`Switch Rabby to the creator ${CREATOR}`);
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
  complete("connect");
  setStatus("Preparing the creator-bound enrollment challenge…");
  const challenge = challengeValue(await post({ action: "challenge", owner: CREATOR }));
  element("account").textContent = challenge.account;
  const wallet = createWalletClient({ account: CREATOR, chain: sepolia, transport: custom(provider) });
  setStatus("Approve the enrollment signature in Rabby. This signature costs no gas.");
  const signature = await wallet.signMessage({ account: CREATOR, message: challenge.message });
  complete("sign");
  setStatus("The operator is creating the Nox proof and waiting for Sepolia confirmation…");
  const result = enrollmentValue(await post({
    action: "enroll",
    owner: CREATOR,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    signature,
  }));
  complete("nox");
  const link = document.createElement("a");
  link.href = `https://eth-sepolia.blockscout.com/tx/${result.transactionHash}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = result.transactionHash;
  element("transaction").replaceChildren(link);
  setStatus("Account enrolled with a Nox encrypted sponsor slot.");
  element<HTMLButtonElement>("run").textContent = "Enrollment confirmed";
}

element<HTMLButtonElement>("run").addEventListener("click", async () => {
  const button = element<HTMLButtonElement>("run");
  button.disabled = true;
  try {
    await runEnrollment();
  } catch (error) {
    setStatus(errorMessage(error), true);
    button.disabled = false;
  }
});
