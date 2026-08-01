# Discord draft: temporary 403 after an on-chain ACL grant

Hi Nox team, I hit a confusing ACL propagation issue while testing selective
disclosure on Sepolia.

I imported a `uint256` handle with `Nox.fromExternal`, granted an auditor access
with `Nox.allow(handle, auditor)`, and waited for the handle status endpoint to
report `resolved: true`. When that auditor called `HandleClient.decrypt`, the
SDK's on-chain viewer check passed, but the gateway returned:

```text
HTTP 403
{"error":"access_denied","message":"Access denied: not a viewer"}
```

Retrying later with the same account and handle succeeded. No second ACL
transaction was needed, so this looks like a delay between the on-chain ACL and
the gateway rather than a bad grant.

Environment:

- Ethereum Sepolia (`11155111`)
- `@iexec-nox/handle` `0.1.0-beta.13`
- `@iexec-nox/nox-protocol-contracts` `0.2.4`
- `viem` `2.55.10`
- NoxCompute `0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF`

Public reproduction:

- App: `0x1eb25c8b43debbfd08427115082d3436fc15779a`
- Transaction: `https://sepolia.etherscan.io/tx/0x8a23b9e81e8a9aec7738a6ef2fd717dfd31b399b4c0c880f3618f346c3f00036`
- Handle: `0x0000aa36a72301e9018aed77ac1829e7b76c0332551dc8c7ffc470cec464ec81`

Is this delay expected? If it is, is there an ACL-readiness signal clients can
check? It would also help if the SDK treated this specific 403 as retryable,
since `resolved: true` currently makes the handle look ready when decryption may
still fail.
