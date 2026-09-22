/**
 * The deployed set a deployment record names, as the explorer needs it:
 * which contract sits at which address, and the transaction that created it.
 * The constructor arguments are never typed by hand; they are what the
 * creation transaction carried after the creation bytecode, so what is
 * verified is what was deployed (T092).
 */

import { decodeAbiParameters, type Abi, type Address, type Hex } from "viem";

export type DeployedContract = {
  /** The key in the record, for the report. */
  key: string;
  /** Fully qualified name, `<source>:<contract>`, as the artifacts name it. */
  contract: string;
  address: Address;
  deployTx: Hex;
};

type Record = {
  sessionPolicy?: string; sessionPolicyTx?: string;
  accountFactory?: string; accountFactoryTx?: string;
  campaignEscrow?: string; campaignEscrowTx?: string;
  paymaster?: string; paymasterTx?: string;
  pool?: { address?: string; deployTx?: string };
  sessionKeys?: { factory?: string; deployTx?: string };
};

const FLEET = "contracts/fleet";

/** Every contract the record says is live, in deployment order; an entry without both an address and a creation hash is left out. */
export const contractsOf = (record: Record): DeployedContract[] => {
  const pairs: Array<[string, string, string | undefined, string | undefined]> = [
    ["campaignEscrow", `${FLEET}/FleetCampaignEscrow.sol:FleetCampaignEscrow`, record.campaignEscrow, record.campaignEscrowTx],
    ["paymaster", `${FLEET}/FleetPaymaster.sol:FleetPaymaster`, record.paymaster, record.paymasterTx],
    ["sessionPolicy", `${FLEET}/FleetSessionPolicy.sol:FleetSessionPolicy`, record.sessionPolicy, record.sessionPolicyTx],
    ["accountFactory", `${FLEET}/FleetAccountFactory.sol:FleetAccountFactory`, record.accountFactory, record.accountFactoryTx],
    ["pool", `${FLEET}/FleetPool.sol:FleetPool`, record.pool?.address, record.pool?.deployTx],
    ["sessionKeys.factory", `${FLEET}/SessionAccountFactory.sol:SessionAccountFactory`, record.sessionKeys?.factory, record.sessionKeys?.deployTx],
  ];
  return pairs.flatMap(([key, contract, address, deployTx]) =>
    address && deployTx ? [{ key, contract, address: address as Address, deployTx: deployTx as Hex }] : []);
};

export type ConstructorArgs = { encoded: Hex; decoded: unknown[] };

/**
 * The constructor arguments a creation transaction carried, decoded against
 * the artifact's constructor. Undefined when the transaction's creation code
 * is not this artifact's bytecode: the source in this checkout is not the
 * source that was deployed, and nothing here guesses at which commit was.
 */
export const constructorArgsOf = (creationInput: Hex, bytecode: Hex, abi: Abi): ConstructorArgs | undefined => {
  if (!creationInput.toLowerCase().startsWith(bytecode.toLowerCase())) return undefined;
  const encoded = `0x${creationInput.slice(bytecode.length)}` as Hex;
  const constructor = abi.find((entry) => entry.type === "constructor");
  const inputs = constructor && "inputs" in constructor ? constructor.inputs : [];
  const decoded = inputs.length === 0 ? [] : [...decodeAbiParameters(inputs, encoded)];
  return { encoded, decoded };
};
