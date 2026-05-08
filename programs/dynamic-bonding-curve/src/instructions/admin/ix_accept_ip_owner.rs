use anchor_lang::prelude::*;
use crate::state::TokenVerification;
use crate::PoolError;

/// Accepts a pending IP owner transfer proposed by `transfer_ip_owner`.
///
/// Must be signed by the current `ip_owner`. On success, `pending_ip_owner`
/// becomes the new `ip_owner` and `pending_ip_owner` is cleared.
///
/// Follows the EVM `acceptRecipient` pattern (V-03).
#[derive(Accounts)]
pub struct AcceptIpOwnerCtx<'info> {
    /// Must be the current IP owner to authorize the transfer.
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

pub fn handle_accept_ip_owner(ctx: Context<AcceptIpOwnerCtx>) -> Result<()> {
    let tv = &mut ctx.accounts.token_verification;

    require!(
        tv.pending_ip_owner != Pubkey::default(),
        PoolError::NoPendingIpOwner
    );

    tv.ip_owner = tv.pending_ip_owner;
    tv.pending_ip_owner = Pubkey::default();

    Ok(())
}
