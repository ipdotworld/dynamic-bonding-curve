use anchor_lang::prelude::*;

/// Vault program error codes (SPEC-DBC-004 Phase 6, REQ-I-003).
#[error_code]
pub enum VaultError {
    #[msg("Vesting clock has not been stamped — no deposit has occurred yet.")]
    VestingNotStarted,

    #[msg("No claimable amount — either nothing released yet or already fully claimed.")]
    NothingToClaim,

    #[msg("Caller is not the verified ip_owner for this token mint.")]
    Unauthorized,

    #[msg("Math overflow during vault accounting.")]
    MathOverflow,

    #[msg("Vault token mint does not match the expected mint.")]
    MintMismatch,

    #[msg("TokenVerification account discriminator does not match.")]
    InvalidTokenVerification,

    #[msg("Distribution amount is zero — refusing to record empty deposit.")]
    AmountIsZero,
}
