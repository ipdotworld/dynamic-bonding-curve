use anchor_lang::prelude::*;

#[error_code]
pub enum HookError {
    #[msg("Pre-graduation transfers must involve the curve vault")]
    TransferNotThroughCurve,

    #[msg("Hook config initializer must be the DBC pool authority PDA")]
    InvalidAuthority,

    #[msg("pool_vault is not the canonical per-pool base vault for this mint/pool")]
    InvalidPoolVault,
}
