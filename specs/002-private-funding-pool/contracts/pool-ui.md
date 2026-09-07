# Balance Page and Wizard UI Contract

## `/app/balance.html`
- Header: available ETH, deposited, spent, open draws; pool paused banner when applicable.
- Deposit card: one button per allowed size; disabled with reason (`cap`, `pool cap`, `paused`); pending state during confirmation; balance refresh on receipt.
- Withdraw card: amount, destination; inline warning when destination is the connected wallet; signed submit; paid state showing the payout tx.
- Exit card: delay, posted spend, exit amount, and the exact contract call; states: none requested, requested with availableAt, available now, paid.
- Empty state: no deposits yet, with the privacy note from FR-015.

## Wizard changes (`fleet.html`, `fleet-page.ts`)
- Fund step removed. Activate step: draw amount with cap and available balance; refused before signing when short, with a link to Balance.
- "Funding your fleet" state: delay range, countdown to the latest due time, live status via `read`.

## Control Room (`fleet-dashboard.html`)
- Balance strip; per campaign: draw, spent, remaining; top-up action when Depleted; close message "credited to your balance".

## Copy (all surfaces)
- Replace "No trail back to you" and "The chain never shows it funding the fleet" with FR-015 wording. Tests assert the forbidden words are absent.
