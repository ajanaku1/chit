# Session keys

Anyone running a bot today gives it their wallet key. Chit sells the
opposite: a bounded key with a kill switch.

You keep your wallet. You create a small account of your own, fund it with
what the bot may spend, and hand the bot a session: which contract it may
call, which function, how much ETH per call and in total, until when. The
bot signs with its own key and pays its own gas; your account pays the
trades. Pause the key or revoke it from your wallet, in one transaction.
Chit is not in the loop: there is no operator, no service, no Chit key that
can touch your account. The rules are in the contract and anyone can read
them.

## For traders: the Sessions page

`/app/sessions.html`, with your wallet on Robinhood Chain.

1. **Create my account.** The address is known before it exists (one per
   wallet; it never changes). One transaction.
2. **Fund it.** ETH from your wallet to the account. Take it back any time.
3. **Grant a session.** The bot's key (the address its process signs with),
   the contract it may call (the Universal Router is filled in, since
   trading is what most bots do), the function (blank for any function of
   that contract), max ETH per call, max ETH in total, valid for how long.
4. **Watch it.** Every session shows its spend, its calls and its state:
   active, paused, expired, spent, revoked. Read from the chain, not from us.
5. **Pause** holds the key; **Resume** releases it; **Revoke** ends it for
   good. To let the same bot back in, grant it a new key.

Withdraw ETH and tokens the account holds with the owner's own path; a
session can never do that, since transfers out are not a rule it can hold.

## For bot builders: one call

The account is `contracts/fleet/SessionAccount.sol`; the SDK is
`src/fleet/session-keys.ts`: the ABI, the encoders, and `canExecute` so a
bot never spends gas on a refusal.

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SESSION_ACCOUNT_ABI, encodeSessionExecute } from "chit-fleet/src/fleet/session-keys.js";

const bot = privateKeyToAccount(process.env.BOT_KEY);          // the key the owner granted
const account = "0x…";                                          // the owner's session account
const wallet = createWalletClient({ account: bot, chain, transport: http(rpc) });

// ask first: (true, "") or (false, "value over cap" | "rule not allowed" | "paused" | "revoked" | "expired" | "unknown")
const [ok, why] = await publicClient.readContract({
  address: account, abi: SESSION_ACCOUNT_ABI, functionName: "canExecute",
  args: [bot.address, router, "0x3593564c", amountInWei],
});

// the account executes with its own ETH; the bot only signs
await wallet.sendTransaction({ to: account, data: encodeSessionExecute(router, amountInWei, swapCalldata) });
```

A rule is `(target, selector)`; `selector` zero means any function of that
target; up to eight rules per session. Value is the account's ETH sent with
the call, capped per call and in total for the session. A revoke is
terminal for that key.

Proven on a fork of Robinhood Chain testnet against the live Uniswap v4
router: `test/fork/session-keys.test.ts` has a bot buy 0.47 FLEET for
0.0005 ETH through its session, get refused outside it, get revoked, and the
owner take the tokens and the ETH back. The contract's own suite is
`test/fleet/SessionAccount.t.sol`, thirteen tests including a fuzz that
spend never passes a cap.

## What Chit gets out of it

Nothing on chain, on purpose: there is no fee in the contract and no Chit
address in it. It is the primitive under two things Chit does sell: the
non-custodial trading bot (a bot whose key every user bounds themselves),
and a place where bots are the good kind. A fee, if there is ever one, is
the founder's and legal's decision and would be a new contract, not a
change to this one.

## Deploying

`npm run session-deploy:live` deploys the factory (no owner, no operator; any
funded key can run it), records it under `sessionKeys` in the deployment
file and in `app/session-target.json`, which the page reads. Rebuild the
app after.
