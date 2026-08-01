# Nox gateway temporarily rejects an on-chain viewer

- Date: 2026-07-30
- Network: Ethereum Sepolia (`11155111`)
- NoxCompute: `0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF`
- `@iexec-nox/handle`: `0.1.0-beta.13`
- `@iexec-nox/nox-protocol-contracts`: `0.2.4`
- Node.js: `26.5.0`
- Upstream issue: https://github.com/iExec-Nox/nox-handle-sdk/issues/105

## What happened

`Nox.fromExternal` accepted a gateway-generated 137-byte proof on live Sepolia.
The imported `uint256` handle reached the gateway's resolved state. The
application contract granted its designated auditor access with
`Nox.allow(handle, auditor)`.

The same auditor account then called `HandleClient.decrypt(handle)`. The SDK's
on-chain `isViewer` check passed, but the gateway initially returned:

```text
HTTP 403
{"error":"access_denied","message":"Access denied: not a viewer"}
```

The SDK threw from `methods/decrypt.js` after its on-chain viewer check and
before returning decryption material. Retrying eventually succeeded with the
same account and handle. The final evidence records `auditorDecrypt: true` and
`nonAuditorDenied: true`.

## Public evidence

- Application: `0x1eb25c8b43debbfd08427115082d3436fc15779a`
- `fromExternal` transaction: `0x8a23b9e81e8a9aec7738a6ef2fd717dfd31b399b4c0c880f3618f346c3f00036`
- Handle: `0x0000aa36a72301e9018aed77ac1829e7b76c0332551dc8c7ffc470cec464ec81`

## Minimal reproduction

1. Deploy an application contract on Sepolia with an auditor address.
2. Call `HandleClient.encryptInput(1000000n, "uint256", applicationAddress)`.
3. Import the returned handle with `Nox.fromExternal(handle, proof)`.
4. Call `Nox.allow(importedHandle, auditor)` in the same transaction.
5. Wait until `POST /v0/public/handles/status` reports `resolved: true`.
6. Create a handle client using the auditor's wallet and call
   `decrypt(importedHandle)`.

## Expected

Once the handle status endpoint reports `resolved: true` and NoxCompute reports
the caller as a viewer, `decrypt` either succeeds or returns a documented
retryable status while the ACL is still propagating.

## Actual

The gateway returned HTTP 403 and said the caller was not a viewer. There was no
signal that this was temporary. A later retry succeeded without another ACL
transaction.

## Impact

The 403 looks like a permanent authorization failure even though the caller is
authorized on-chain. Applications need to recognize this exact response and
retry, but the handle status endpoint does not expose ACL readiness. This held
up Chit's live selective-disclosure check until the gateway caught up.

## Upstream question

Is this propagation window expected? If so, is there a reliable ACL-readiness
signal, or could the SDK classify this specific 403 as retryable?
