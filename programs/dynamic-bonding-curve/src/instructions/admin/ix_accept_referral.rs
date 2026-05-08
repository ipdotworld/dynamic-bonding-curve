use anchor_lang::prelude::*;
use crate::state::TokenVerification;
use crate::PoolError;

/// Accepts a pending referral change proposed by `set_referral`.
///
/// Must be signed by the current `ip_owner`. On success, `pending_referral`
/// becomes the active `referral` and `pending_referral` is cleared.
///
/// Follows the EVM `acceptReferral()` pattern (E-02).
#[derive(Accounts)]
pub struct AcceptReferralCtx<'info> {
    /// Must be the current IP owner to authorize the referral change.
    #[account(
        constraint = ip_owner.key() == token_verification.ip_owner @ PoolError::Unauthorized
    )]
    pub ip_owner: Signer<'info>,

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
}

pub fn handle_accept_referral(ctx: Context<AcceptReferralCtx>) -> Result<()> {
    let tv = &mut ctx.accounts.token_verification;

    require!(
        tv.pending_referral != Pubkey::default(),
        PoolError::NoPendingReferral
    );

    tv.referral = tv.pending_referral;
    tv.pending_referral = Pubkey::default();

    Ok(())
}
