use crate::state::{Operator, TokenVerification};
use crate::PoolError;
use anchor_lang::prelude::*;

/// Proposes a new referral wallet for the pool (backend-authorized).
///
/// SPEC-DBC-AUDIT-001 Phase 4 (REQ-D-002): authorization is now **operator
/// direct-signing**. The operator signs directly AND must hold the
/// `OperatorPermission::VerifyToken` role (enforced by `#[access_control(...)]` in
/// `lib.rs`). The relayed-Ed25519 path is removed; `new_referral` is an instruction
/// argument. The current IP owner must call `accept_referral` to activate the new
/// referral (EVM `setReferral()` / `acceptReferral()` 2-step pattern).
#[derive(Accounts)]
pub struct SetReferralCtx<'info> {
    /// Per-pool IP owner verification record.
    #[account(
        mut,
        seeds = [TokenVerification::SEED, pool.key().as_ref()],
        bump = token_verification.bump,
    )]
    pub token_verification: Account<'info, TokenVerification>,

    /// The pool this verification record belongs to.
    /// CHECK: Validated indirectly via TokenVerification PDA seeds.
    pub pool: AccountInfo<'info>,

    /// Operator account holding the `VerifyToken` role. Validated by
    /// `#[access_control(is_valid_operator_role(.., VerifyToken))]` in lib.rs.
    pub operator: AccountLoader<'info, Operator>,

    /// The operator's whitelisted signer — must sign the transaction directly.
    pub signer: Signer<'info>,
}

pub fn handle_set_referral(ctx: Context<SetReferralCtx>, new_referral: Pubkey) -> Result<()> {
    // Reject zero address.
    require!(
        new_referral != Pubkey::default(),
        PoolError::InvalidOwnerAccount
    );

    ctx.accounts.token_verification.pending_referral = new_referral;

    Ok(())
}
