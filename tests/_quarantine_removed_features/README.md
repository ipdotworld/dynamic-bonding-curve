# Quarantined tests — SPEC-DBC-AUDIT-001

This directory previously held post-audit test files that asserted fundamentally
changed (not merely renamed) behavior. They are **excluded from `tsconfig.json`**
and outside the `tests/*.tests.ts` runner glob. As of the T3 coverage pass all of
them have been resolved — the directory now holds only this README.

## Disposition (T3 pass)

| File | Original reason | Resolution |
|------|-----------------|------------|
| `fee_swap.tests.ts` | Asserted the legacy partner/protocol fee split via `virtualPool.partnerBaseFee` / `partnerQuoteFee`, now zeroed padding. | **Rewritten** as `tests/fee_distribution.tests.ts` (top-level): asserts the IPWorld fixed-share buckets — BUY base fee → `token_airdrop_base_fee` (40%) + `ip_treasury_base_fee` (60%, no `protocol_base_fee` double-write); SELL quote fee → `ip_owner_quote_fee` (10%) / `airdrop_quote_fee` (10%) / `protocol_quote_fee` (80% residual); shares are fixed program constants. |
| `ip_owner_verify.tests.ts` | Used the pre-audit relayed-Ed25519 admin-op pattern. | **Deleted** — superseded by `tests/operator_admin_ops.tests.ts` (T2), which covers all five backend ops via the new operator-direct-signing model + the replay-vector-gone check, plus the two-step `accept_ip_owner` (current-owner finalize + wrong-signer `Unauthorized`) and `set_ip_treasury` one-time immutability (`IpTreasuryAlreadySet`) added in T3. |
| `ip_owner_vault_flow.tests.ts` | `distribute_to_vault` / `claim_vested` gained a `pool` account + cross-pool binding guards. | **Deleted** — superseded by `tests/ip_owner_vault.tests.ts` (T2): vault cross-pool spoof rejection (`PoolMismatch`), `TokenVerificationWrongOwner`, `Unauthorized`, and the `distribute_to_vault` authority gate (`InvalidDistributeAuthority`). |

Deleted earlier (foundation pass) because the whole feature was removed:
`zap_protocol_fee.tests.ts` (zap removed).
