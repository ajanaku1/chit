import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  http,
  isHex,
  parseAbi,
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
const TOKEN = "0x19c151c602484234b689c46f3d2481dc05a7bfdb" satisfies Address;
const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const TOKEN_ABI = parseAbi(["function transfer(address to,uint256 amount) returns (bool)"]);

interface RabbyProvider extends EIP1193Provider {
  readonly isRabby?: boolean;
  readonly providers?: readonly RabbyProvider[];
}

interface SponsorChallenge {
  readonly sponsor: Address;
  readonly budget: bigint;
  readonly expiresAt: number;
  readonly digest: Hex;
  readonly needsFunding: boolean;
}

interface SponsorResult {
  readonly slot: number;
  readonly transactionHash: Hex;
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
  if (window.ethereum?.providers !== undefined) return selectLegacyRabbyProvider(window.ethereum.providers);
  if (window.ethereum?.isRabby === true) return window.ethereum;
  throw new Error("Rabby Wallet is not available. Unlock Rabby and refresh.");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Operator service returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function challengeValue(value: unknown): SponsorChallenge {
  const body = record(value);
  if (typeof body.sponsor !== "string" || typeof body.budget !== "string" ||
      typeof body.expiresAt !== "number" || typeof body.digest !== "string" ||
      !isHex(body.digest) || size(body.digest) !== 32 || typeof body.needsFunding !== "boolean") {
    throw new Error("Sponsor challenge is invalid");
  }
  return { sponsor: getAddress(body.sponsor), budget: BigInt(body.budget),
    expiresAt: body.expiresAt, digest: body.digest, needsFunding: body.needsFunding };
}

function resultValue(value: unknown): SponsorResult {
  const body = record(value);
  if (!Number.isSafeInteger(body.slot) || typeof body.transactionHash !== "string" ||
      !isHex(body.transactionHash) || size(body.transactionHash) !== 32) {
    throw new Error("Sponsor registration response is invalid");
  }
  return { slot: Number(body.slot), transactionHash: body.transactionHash };
}

async function post(body: object): Promise<unknown> {
  const response = await fetch("/api/operator-sponsor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Operator sponsor service failed (${response.status})`);
  return response.json();
}

function showTransaction(hash: Hex): void {
  const link = document.createElement("a");
  link.href = `https://eth-sepolia.blockscout.com/tx/${hash}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = hash;
  element("transaction").replaceChildren(link);
}

async function run(): Promise<void> {
  const provider = await discoverRabby();
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (classifyWalletAccount(accounts, CREATOR).kind !== "match") {
    throw new Error(`Switch Rabby to the creator ${CREATOR}`);
  }
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
  complete("connect");
  const wallet = createWalletClient({ account: CREATOR, chain: sepolia, transport: custom(provider) });
  const challenge = challengeValue(await post({ action: "challenge" }));
  element("sponsor").textContent = challenge.sponsor;
  if (challenge.needsFunding) {
    setStatus("Approve the 1,000 CHIT transfer to sponsor two in Rabby.");
    const hash = await wallet.writeContract({ account: CREATOR, address: TOKEN,
      abi: TOKEN_ABI, functionName: "transfer", args: [challenge.sponsor, challenge.budget] });
    const receipt = await createPublicClient({ chain: sepolia, transport: http(RPC_URL) })
      .waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("CHIT transfer reverted");
  }
  complete("transfer");
  setStatus("Sign the vault admission in Rabby. This costs no gas.");
  const signature = await wallet.signMessage({ account: CREATOR, message: { raw: challenge.digest } });
  complete("admission");
  setStatus("Operator is wrapping collateral, creating the Nox proof, and registering…");
  const result = resultValue(await post({ action: "register",
    expiresAt: challenge.expiresAt, signature }));
  complete("nox");
  complete("register");
  showTransaction(result.transactionHash);
  setStatus(`Sponsor two registered in slot ${result.slot}.`);
  element<HTMLButtonElement>("run").textContent = "Sponsor two confirmed";
}

element<HTMLButtonElement>("run").addEventListener("click", async () => {
  const button = element<HTMLButtonElement>("run");
  button.disabled = true;
  try { await run(); } catch (error) {
    setStatus(errorMessage(error), true);
    button.disabled = false;
  }
});
