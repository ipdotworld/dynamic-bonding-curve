use anchor_lang::prelude::*;

#[error_code]
pub enum HookError {
    #[msg("Pre-graduation transfers must involve the curve vault")]
    TransferNotThroughCurve,

    #[msg("Hook config initializer must be the DBC pool authority PDA")]
    InvalidAuthority,

    #[msg("pool_vault is not the canonical per-pool base vault for this mint/pool")]
    InvalidPoolVault,

    // SPEC-DBC-AUDIT-001 Phase 6 (REQ-B-001): persistent 5% holding cap. A
    // non-exempt recipient may not end a transfer holding strictly more than 5%
    // of the mint's total supply.
    #[msg("Recipient post-transfer balance would exceed 5% of total supply")]
    HoldingCapExceeded,

    // SPEC-DBC-AUDIT-001 Phase 6 (REQ-B-001): the holding-cap math overflowed
    // its u128 intermediate. Should be unreachable for real SPL supplies
    // (<= u64::MAX), but checked rather than allowed to wrap.
    #[msg("Holding-cap arithmetic overflow")]
    HoldingCapMathOverflow,
}
