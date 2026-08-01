import { type Address, type Hex } from "viem";

interface LiveProfile {
  readonly entryPoint: Address;
  readonly factory: Address;
  readonly operator: Address;
  readonly minimumStake: bigint;
  readonly paymasterDeposit: bigint;
  readonly operatorGas: bigint;
  readonly activationValue: bigint;
  readonly unstakeDelay: number;
}

interface ProvenRound {
  readonly vault: Address;
  readonly settlement: Address;
  readonly paymaster: Address;
  readonly activationTx: Hex;
  readonly explorerUrl: string;
  readonly sponsorCount: number;
}

export const LIVE_PROFILE: LiveProfile = {
  entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  factory: "0xae9f63B7E7b0aC875AaDBEC56efCccFb88Ea87e6",
  operator: "0xd39229508DA2126D0e1B4f68bb14E1b48810134b",
  minimumStake: 100_000_000_000_000_000n,
  paymasterDeposit: 10_000_000_000_000_000n,
  operatorGas: 1_000_000_000_000_000n,
  activationValue: 111_000_000_000_000_000n,
  unstakeDelay: 86_400,
};

export const PROVEN_ROUND: ProvenRound = {
  vault: "0x207037E290572Bd8839365203182aA5f0F9FdDAD",
  settlement: "0x81a5001c7D5aEf6A9215035Da229d052a722db0f",
  paymaster: "0x421afB0667Faf8B2Aa1d4e03EAb68c327875D54F",
  activationTx: "0xdada3e22b069bdb4f3c076f682f4ad1b4c9749413ef8fe9d4a8c563fa6184032",
  explorerUrl: "https://eth-sepolia.blockscout.com/tx/0xdada3e22b069bdb4f3c076f682f4ad1b4c9749413ef8fe9d4a8c563fa6184032",
  sponsorCount: 1,
};
