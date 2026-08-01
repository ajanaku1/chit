import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  getAddress,
  hexToBytes,
  http,
  parseAbi,
  type Address,
} from "viem";
import { sepolia } from "viem/chains";
import { deriveOperatorAddress } from "../src/service-crypto.js";
import {
  parseSecretHex,
  parseServiceOperatorRecord,
} from "../src/service-role-rotation.js";

const SOURCE_PATH = path.resolve("deployments/factory-browser-gate.json");
const TARGET_PATH = path.resolve("deployments/service-operator.json");
const RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://sepolia.drpc.org";
const PAYMASTER_ABI = parseAbi([
  "function creator() view returns (address)",
]);

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Factory evidence is malformed");
  }
  return value as Record<string, unknown>;
}

function textField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`${field} is missing`);
  return value;
}

function addressField(record: Record<string, unknown>, field: string): Address {
  try {
    return getAddress(textField(record, field));
  } catch {
    throw new Error(`${field} is invalid`);
  }
}

function masterSecret(): Uint8Array {
  const value = process.env.SERVICE_MASTER_SECRET;
  if (value === undefined) throw new Error("SERVICE_MASTER_SECRET is missing");
  return hexToBytes(parseSecretHex(value, "SERVICE_MASTER_SECRET"));
}

const source = objectRecord(
  JSON.parse(await readFile(SOURCE_PATH, "utf8")) as unknown,
);
if (source.chainId !== sepolia.id) throw new Error("Factory evidence is not Sepolia");
const factory = addressField(source, "factory");
const paymaster = addressField(source, "paymaster");
const settlement = addressField(source, "settlement");
const round = textField(source, "roundId");
const roundSalt = textField(source, "roundSalt");
const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
const creator = getAddress(await client.readContract({
  address: paymaster,
  abi: PAYMASTER_ABI,
  functionName: "creator",
}));
const serviceOperator = deriveOperatorAddress(masterSecret(), {
  chainId: sepolia.id,
  factory,
  creator,
  roundSalt,
});
if (serviceOperator.toLowerCase() === creator.toLowerCase()) {
  throw new Error("Service authority must differ from the creator");
}
const target = parseServiceOperatorRecord({
  chainId: sepolia.id,
  factory,
  round,
  creator,
  paymaster,
  settlement,
  serviceOperator,
});
await writeFile(TARGET_PATH, `${JSON.stringify(target, null, 2)}\n`);
process.stdout.write(`Derived public service operator ${serviceOperator}\n`);
