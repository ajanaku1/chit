/**
 * A campaign's public state, read without a signature.
 *
 * Watching a fleet be funded polls, and a signed read would prompt the wallet
 * on every tick. Everything here is already readable on chain by anyone holding
 * the campaign id, and it names no depositor.
 */

import { fleetApi } from "./page-shared.js";

export type CampaignStatus = {
  campaign: string;
  state: string;
  draw?: { amount: string; spent: string; remaining: string; dueAt: string; state: string };
};

export class StatusUnavailable extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "StatusUnavailable";
    this.code = code;
  }
}

export const readStatus = async (campaign: string): Promise<CampaignStatus> => {
  const { status, body } = await fleetApi("status", { action: "status", body: { campaign } });
  if (status < 200 || status >= 300) throw new StatusUnavailable(String(body["code"] ?? `status_${status}`));
  return body as unknown as CampaignStatus;
};
