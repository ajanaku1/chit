# Contract: the token registry

A repository file, reviewed like code. Not a runtime list and not user-editable.

```jsonc
{
  "chainId": 4663,
  "tokens": [
    {
      "token": "0xd523a627030509021cc39b6d7c8543417d3e50d8",
      "symbol": "CHIT",
      "decimals": 18,
      "poolKey": {
        "currency0": "0x0000000000000000000000000000000000000000",
        "currency1": "0xd523a627030509021cc39b6d7c8543417d3e50d8",
        "fee": 0,
        "tickSpacing": 200,
        "hooks": "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044"
      },
      "poolId": "0x84a4f18cfab0b389a63c4d8a56d08f021a6fd5efb0b0b3617cfbbd6706f09f41",
      "slippageBps": 100,
      "enabled": true,
      "checks": {
        "ordinaryTransfer": true,
        "holderRestrictions": false,
        "liquidityEth": "…",
        "liquidityMultipleOfDrawCap": 50,
        "forkTest": "quote and execution agreed within slippageBps",
        "checkedAt": "2026-09-…"
      }
    }
  ]
}
```

## Rules

1. `poolId` must equal the id derived from `poolKey`. A mismatch is a hard
   failure at load, not a warning.
2. A token with `enabled: false` is never offered and no path exists to trade it.
3. `slippageBps` defaults to 100. A hooked pool records the bound measured on a
   fork, because the hook's fee is not in the local quote.
4. Liquidity is re-measured on the day the beta opens; below fifty times the
   draw cap, the token is not offered.
5. Tokenized equities carry `enabled: false` until the legal question is resolved.
