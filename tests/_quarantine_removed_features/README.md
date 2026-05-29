# Quarantined tests — SPEC-DBC-AUDIT-001 foundation pass

These test files do **not** compile/run against the post-audit IDL because the
behavior they assert was fundamentally changed (not just renamed). They are
parked here — excluded from `tsconfig.json` and outside the `tests/*.tests.ts`
runner glob — so the rest of the suite stays green. Each needs a **semantic
rewrite** in the coverage-expansion pass, not a mechanical fix.

| File | Why quarantined | Rewrite needed |
|------|-----------------|----------------|
| `fee_swap.tests.ts` | Asserts the legacy partner/protocol fee split via `virtualPool.partnerBaseFee` / `partnerQuoteFee`, which are now zeroed padding (`_padding_partner_base/_quote`). The trading fee now splits into IPWorld buckets (`ipOwnerQuoteFee`, `airdropQuoteFee`, `ipTreasuryBaseFee`, `tokenAirdropBaseFee`, `protocol*`). | Rewrite assertions around the IPWorld fee buckets and the documented share math (ip_owner_share / airdrop_share / token_airdrop_share). Was already `describe.skip`-ed. |
| `ip_owner_verify.tests.ts` | Uses the pre-audit relayed-Ed25519 admin-op pattern (`serializeVerifyAuth` + `Ed25519Program` + `.verifyToken()` with `ipworldState`/`instructionsSysvar`). The audit switched the 5 backend admin ops to OPERATOR-DIRECT-SIGNING: `.verifyToken(ipOwner)` / `.setReferral(newReferral)` / `.transferIpOwner(newIpOwner)` / `.linkTokenToIp(ipaId)` with `operator` (Operator PDA, `VerifyToken` permission bit 2) + `signer` accounts; the ed25519/sysvar/ipworld_state accounts are gone. It is also a `describe.skip`-ed `solana-test-validator` test. | Rewrite as **LiteSVM** operator-direct tests (the validator harness is unavailable in CI). This is the primary coverage gap for the 5 admin ops + replay-rejection. |
| `ip_owner_vault_flow.tests.ts` | `distribute_to_vault` and `claim_vested` gained a NEW `pool` account (claim also gained `token_verification`). The audit binds `authority == DBC pool_authority` on distribute, stamps `vault.pool` TOFU on first deposit, and binds `pool == vault.pool` + keys `TokenVerification[pool]` on claim. The existing test uses a synthetic mint with `authority: payer` and no DBC pool / TokenVerification wiring, so every distribute/claim call fails account validation (`pool` not provided) and would then fail the authority/binding checks. | Rewrite to wire a real DBC pool + pool_authority signer + seeded TokenVerification, then assert: no-clawback 180d vesting, vault cross-pool spoof rejection (claim with a pool != vault.pool must fail), immediate-quote vs vested-token split. Major coverage gap. |

Deleted outright (not quarantined) because the whole feature was removed:
`zap_protocol_fee.tests.ts` (zap removed).
