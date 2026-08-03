import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";

interface OperatorSponsorChain {
  admissionDigest(sponsor: Address, expiresAt: number): Promise<Hex>;
  register(input: {
    readonly sponsor: Address;
    readonly budget: bigint;
    readonly expiresAt: number;
    readonly creatorSignature: Hex;
  }): Promise<OperatorSponsorResult>;
}

interface OperatorSponsorOptions {
  readonly creator: Address;
  readonly sponsor: Address;
  readonly budget: bigint;
  readonly admissionTtlSeconds: number;
  readonly clock: () => number;
  readonly chain: OperatorSponsorChain;
}

export interface OperatorSponsorChallenge {
  readonly sponsor: Address;
  readonly budget: string;
  readonly expiresAt: number;
  readonly digest: Hex;
}

export interface OperatorSponsorRequest {
  readonly expiresAt: number;
  readonly signature: Hex;
}

export interface OperatorSponsorResult {
  readonly slot: number;
  readonly transactionHash: Hex;
}

export class OperatorSponsorService {
  constructor(private readonly options: OperatorSponsorOptions) {}

  async challenge(): Promise<OperatorSponsorChallenge> {
    const expiresAt = this.options.clock() + this.options.admissionTtlSeconds;
    const digest = await this.options.chain.admissionDigest(
      this.options.sponsor,
      expiresAt,
    );
    return {
      sponsor: this.options.sponsor,
      budget: this.options.budget.toString(),
      expiresAt,
      digest,
    };
  }

  async register(request: OperatorSponsorRequest): Promise<OperatorSponsorResult> {
    if (request.expiresAt < this.options.clock()) {
      throw new Error("Creator admission has expired");
    }
    const digest = await this.options.chain.admissionDigest(
      this.options.sponsor,
      request.expiresAt,
    );
    const signer = await recoverMessageAddress({
      message: { raw: digest },
      signature: request.signature,
    });
    if (getAddress(signer) !== getAddress(this.options.creator)) {
      throw new Error("Creator signature is invalid");
    }
    return this.options.chain.register({
      sponsor: this.options.sponsor,
      budget: this.options.budget,
      expiresAt: request.expiresAt,
      creatorSignature: request.signature,
    });
  }
}
