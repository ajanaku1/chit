import { neon } from "@neondatabase/serverless";
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

const FACTORY = "0xae9f63B7E7b0aC875AaDBEC56efCccFb88Ea87e6" satisfies Address;
const ROUND = "0xdf1b4073be7e71e17e9b09eaa4f203b80f801e9639b7fbbd3f07b2c0f8643478" satisfies Hex;
const EXPECTED_OPERATOR = "0x527e7Bdc2ef3eA0A10592Cc1B2DC40B974CD8c2F" satisfies Address;
const RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const FACTORY_ABI = parseAbi([
  "function getRound(bytes32 id) view returns ((address creator,address operator,address verifier,address auditor,address vault,address settlement,address paymaster,uint8 initializedSteps))",
]);
const PAYMASTER_ABI = parseAbi([
  "function roundState() view returns (uint8)",
  "function operator() view returns (address)",
  "function verifier() view returns (address)",
]);
const SETTLEMENT_ABI = parseAbi(["function operator() view returns (address)"]);
const VAULT_ABI = parseAbi(["function sponsorCount() view returns (uint256)"]);

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("DATABASE_URL is not configured");
  }
  return value;
}

interface RpcSuccess {
  result: Hex;
}

interface RpcFailure {
  error: { message?: string };
}

function isRpcSuccess(value: unknown): value is RpcSuccess {
  if (typeof value !== "object" || value === null || !("result" in value)) return false;
  const result = Reflect.get(value, "result");
  return typeof result === "string" && result.startsWith("0x");
}

function rpcError(value: unknown): string {
  if (typeof value !== "object" || value === null || !("error" in value)) return "invalid RPC response";
  const error = Reflect.get(value, "error") as RpcFailure["error"];
  return typeof error?.message === "string" ? error.message : "Sepolia RPC call failed";
}

async function ethCall(address: Address, data: Hex): Promise<Hex> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: address, data }, "latest"],
    }),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !isRpcSuccess(payload)) throw new Error(rpcError(payload));
  return payload.result;
}

async function readRound() {
  const result = await ethCall(FACTORY, encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "getRound",
    args: [ROUND],
  }));
  return decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getRound", data: result });
}

async function readRoundState(address: Address) {
  const result = await ethCall(address, encodeFunctionData({ abi: PAYMASTER_ABI, functionName: "roundState" }));
  return decodeFunctionResult({ abi: PAYMASTER_ABI, functionName: "roundState", data: result });
}

async function readPaymasterOperator(address: Address) {
  const result = await ethCall(address, encodeFunctionData({ abi: PAYMASTER_ABI, functionName: "operator" }));
  return decodeFunctionResult({ abi: PAYMASTER_ABI, functionName: "operator", data: result });
}

async function readVerifier(address: Address) {
  const result = await ethCall(address, encodeFunctionData({ abi: PAYMASTER_ABI, functionName: "verifier" }));
  return decodeFunctionResult({ abi: PAYMASTER_ABI, functionName: "verifier", data: result });
}

async function readOperator(address: Address) {
  const result = await ethCall(address, encodeFunctionData({
    abi: SETTLEMENT_ABI,
    functionName: "operator",
  }));
  return decodeFunctionResult({ abi: SETTLEMENT_ABI, functionName: "operator", data: result });
}

async function readSponsorCount(address: Address) {
  const result = await ethCall(address, encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "sponsorCount",
  }));
  return decodeFunctionResult({ abi: VAULT_ABI, functionName: "sponsorCount", data: result });
}

export async function GET(): Promise<Response> {
  try {
    const sql = neon(databaseUrl());
    const [database, round] = await Promise.all([
      sql`SELECT 1 AS ready`,
      readRound(),
    ]);
    const [state, sponsorCount, paymasterOperator, verifier, settlementOperator] = await Promise.all([
      readRoundState(round.paymaster),
      readSponsorCount(round.vault),
      readPaymasterOperator(round.paymaster),
      readVerifier(round.paymaster),
      readOperator(round.settlement),
    ]);
    const rolesReady = [paymasterOperator, verifier, settlementOperator]
      .every((address) => address.toLowerCase() === EXPECTED_OPERATOR.toLowerCase());
    return Response.json({
      database: database.length === 1 ? "ready" : "unavailable",
      network: "ethereum-sepolia",
      round: ROUND,
      state: Number(state),
      initializedSteps: round.initializedSteps,
      sponsorCount: sponsorCount.toString(),
      operator: paymasterOperator,
      rolesReady,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("operator round health failed", error);
    return Response.json({ error: "operator_unavailable" }, { status: 503 });
  }
}
