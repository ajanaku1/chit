import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  getAddress,
  http,
  type Abi,
} from "viem";
import { sepolia } from "viem/chains";
import {
  SepoliaRoundReader,
  parseSepoliaServiceTarget,
  type SepoliaReadClient,
} from "../src/sepolia-round-reader.js";

const DEFAULT_RPC_URL = "https://sepolia.drpc.org";
const TARGET_PATH = path.resolve(
  process.env.CHIT_SERVICE_TARGET_PATH ?? "deployments/factory-browser-gate.json",
);

function expectedOperator(): `0x${string}` {
  const value = process.argv[2];
  if (value === undefined) {
    throw new Error("Pass the expected public service operator address");
  }
  return getAddress(value);
}

const rpcUrl = process.env.SEPOLIA_RPC_URL ?? DEFAULT_RPC_URL;
const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const reads: SepoliaReadClient = {
  getChainId: () => client.getChainId(),
  getCode: (input) => client.getCode(input),
  getBalance: (input) => client.getBalance(input),
  readContract: (input) => client.readContract({
    address: input.address,
    abi: input.abi as Abi,
    functionName: input.functionName,
    ...(input.args === undefined ? {} : { args: input.args }),
  }),
};

const target = parseSepoliaServiceTarget(
  JSON.parse(await readFile(TARGET_PATH, "utf8")) as unknown,
);
const reader = new SepoliaRoundReader({
  client: reads,
  factory: target.factory,
  expectedOperator: expectedOperator(),
});
const snapshot = await reader.read(target.round, AbortSignal.timeout(30_000));
process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
