/**
 * T092: verify the source of every deployed contract on the chain's explorer.
 *
 * Reads deployments/fleet-<FLEET_CHAIN_ID>.json, takes each contract's
 * constructor arguments from its own creation transaction, and submits the
 * standard-JSON input to Blockscout through hardhat-verify. Before anything
 * is sent, every contract's standard input and encoded arguments are written
 * to verify/<chain>/, so the same verification can be done by hand in the
 * explorer's form when its API is not reachable from a script (the mainnet
 * explorer sits behind a browser challenge).
 *
 *   EXPLORER_DRY=1 npm run explorer:verify        # read, decode, export; send nothing
 *   npm run explorer:verify                       # and submit each unverified contract
 *   npm run explorer:verify:mainnet               # the same against 4663
 *
 * Runs under `hardhat run --network …`: the network chosen there is the chain
 * whose record is read and whose explorer is asked.
 *
 * A contract whose creation code is not this checkout's bytecode is reported
 * and skipped: check out the commit that deployed it and run again from there.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import hre, { artifacts, network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import type { Hex } from "viem";

import { constructorArgsOf, contractsOf } from "../src/fleet/explorer-set.js";

const DRY = process.env.EXPLORER_DRY === "1";

const main = async (): Promise<void> => {
  const connection = await network.connect();
  const publicClient = await connection.viem.getPublicClient();
  const CHAIN_ID = await publicClient.getChainId();
  const record = JSON.parse(await readFile(path.resolve(`deployments/fleet-${CHAIN_ID}.json`), "utf8"));
  const set = contractsOf(record);
  if (set.length === 0) throw new Error(`deployments/fleet-${CHAIN_ID}.json names no deployed contract`);
  const outDir = path.resolve(`verify/${CHAIN_ID}`);
  await mkdir(outDir, { recursive: true });

  let failed = 0;
  for (const entry of set) {
    const artifact = await artifacts.readArtifact(entry.contract);
    const tx = await publicClient.getTransaction({ hash: entry.deployTx });
    const args = constructorArgsOf(tx.input, artifact.bytecode as Hex, artifact.abi);
    if (!args) {
      failed += 1;
      console.log(`${entry.key.padEnd(20)} ${entry.address}  SKIP: creation code is not this checkout's ${artifact.contractName}; verify from the commit that deployed it`);
      continue;
    }
    const buildInfo = JSON.parse(await readFile(path.resolve(`artifacts/build-info/${artifact.buildInfoId}.json`), "utf8"));
    const exported = path.join(outDir, `${artifact.contractName}.json`);
    await writeFile(exported, `${JSON.stringify({
      address: entry.address, contract: entry.contract, compiler: `v${buildInfo.solcLongVersion}`,
      constructorArguments: args.encoded, decoded: args.decoded.map(String), input: buildInfo.input,
    }, null, 2)}\n`);
    console.log(`${entry.key.padEnd(20)} ${entry.address}  args ${args.decoded.map(String).join(", ") || "(none)"}  -> ${path.relative(process.cwd(), exported)}`);
    if (DRY) continue;
    try {
      const ok = await verifyContract({ address: entry.address, constructorArgs: args.decoded, contract: entry.contract, provider: "blockscout" }, hre);
      if (!ok) failed += 1;
    } catch (error) {
      failed += 1;
      console.log(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(DRY ? `dry run: ${set.length} contracts read, ${failed} not verifiable from this checkout, nothing sent` : `${set.length - failed} of ${set.length} verified`);
  if (failed > 0) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
