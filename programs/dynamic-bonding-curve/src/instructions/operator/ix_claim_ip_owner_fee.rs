use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    const_pda,
    state::{TokenVerification, VirtualPool},
    token::transfer_token_from_pool_authority,
    PoolError,
};

/// Allows the verified IP owner to withdraw their accumulated SOL (quote) fees.
///
/// Authorization: caller must be `token_verification.ip_owner`.
/// Requires a valid TokenVerification PDA — created by `verify_token`.
#[derive(Accounts)]
pub struct ClaimIpOwnerFeeCtx<'info> {
    /// Pool authority PDA that signs token transfers.
    /// CHECK: Validated by address constraint to be the pool authority.
    #[account(address = const_pda::pool_authority::ID)]
    pub pool_authority: AccountInfo<'info>,

    /// The bonding curve pool holding accumulated fee counters.
    #[account(mut, has_one = quote_vault, has_one = config)]
    pub pool: AccountLoader<'info, VirtualPool>,

    /// Pool config — required by `has_one = config` on pool.
    /// CHECK: Used only to satisfy the has_one constraint.
    pub config: AccountInfo<'info>,

    /// IP owner verification record for this pool.
    /// Constraint: caller must match the recorded ip_owner.
    #[account(
        seeds = [TokenVerification::SEED, pool.key().as_ref()],
        bump = token_verification.bump,
        constraint = token_verification.ip_owner == ip_owner.key() @ PoolError::Unauthorized,
    )]
    pub token_verification: Account<'info, TokenVerification>,

    /// The verified IP owner — must sign this transaction.
    pub ip_owner: Signer<'info>,

    /// Quote mint (SOL wrapper / WSOL or other quote token).
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Pool's quote vault — source of the fee transfer.
    #[account(mut, token::mint = quote_mint)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// IP owner's token account that will receive the fees.
    #[account(mut, token::mint = quote_mint)]
    pub ip_owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Token program for the quote mint.
    pub token_quote_program: Interface<'info, TokenInterface>,
}

pub fn handle_claim_ip_owner_fee<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ClaimIpOwnerFeeCtx<'info>>,
    max_amount: u64,
) -> Result<()> {
    let mut pool = ctx.accounts.pool.load_mut()?;

    // Cap by the requested max and the available balance.
    let amount = pool.ip_owner_quote_fee.min(max_amount);
    require!(amount > 0, PoolError::AmountIsZero);

    pool.ip_owner_quote_fee = pool
        .ip_owner_quote_fee
        .checked_sub(amount)
        .ok_or(PoolError::MathOverflow)?;

    drop(pool);

    transfer_token_from_pool_authority(
        ctx.accounts.pool_authority.to_account_info(),
        &ctx.accounts.quote_mint,
        &ctx.accounts.quote_vault,
        ctx.accounts.ip_owner_token_account.to_account_info(),
        &ctx.accounts.token_quote_program,
        amount,
        ctx.remaining_accounts,
    )?;

    Ok(())
}
