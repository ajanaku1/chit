/**
 * What a deploy must be given before it sends anything, read from the
 * environment and refused in words. Pure, so a test can hand it any
 * environment: the deploy scripts call these first and the refusals are
 * pinned in test/fleet/deploy-guards.test.ts rather than rehearsed by hand.
 */

import { isAddress, type Address } from "viem";

type Env = Record<string, string | undefined>;

/**
 * The cold admin: the key that rotates the operator, unpauses, names the
 * guardian and claims gas, and nothing else. Required and never defaulted,
 * and never the deployer: a hot key that is its own admin can unpause itself,
 * which is the thing the split exists to prevent.
 */
export const adminFromEnv = (env: Env, deployer: Address): Address => {
  const value = env["FLEET_ADMIN_ADDRESS"];
  if (!value || !isAddress(value)) throw new Error("Set FLEET_ADMIN_ADDRESS to the cold admin key's address (not the deployer)");
  if (value.toLowerCase() === deployer.toLowerCase()) throw new Error("FLEET_ADMIN_ADDRESS must not be the deployer: the admin is a different, cold key");
  return value;
};

/**
 * The guardian: a second key that can only pause. Optional on testnet,
 * required on mainnet (FR-009: deployment refuses without one), and never the
 * operator, because a brake only the hot key can pull is no brake.
 */
export const guardianFromEnv = (env: Env, operator: Address, mainnet: boolean): Address | undefined => {
  const value = env["FLEET_GUARDIAN_ADDRESS"];
  if (value === undefined || value === "") {
    if (mainnet) throw new Error("a mainnet beta needs a guardian before anything is deployed: set FLEET_GUARDIAN_ADDRESS to a key that is not the operator's");
    return undefined;
  }
  if (!isAddress(value)) throw new Error("FLEET_GUARDIAN_ADDRESS is not an address");
  if (value.toLowerCase() === operator.toLowerCase()) throw new Error("the guardian must not be the operator; the point is a second key that can only pause");
  return value;
};
