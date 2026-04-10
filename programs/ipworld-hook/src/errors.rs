use anchor_lang::prelude::*;

#[error_code]
pub enum HookError {
    #[msg("Pre-graduation transfers must involve the curve vault")]
    TransferNotThroughCurve,
    #[msg("Wallet would exceed maximum ownership cap")]
    ExceedsMaxOwnership,
}
