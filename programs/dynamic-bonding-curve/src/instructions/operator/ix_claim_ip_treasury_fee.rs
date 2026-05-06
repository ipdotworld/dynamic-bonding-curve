use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    const_pda,
    state::{TokenVerification, VirtualPool},
    token::transfer_token_from_pool_authority,
    PoolError,
};

/// Allows the per-pool IP treasury address to withdraw accumulated base (token) fees.
///
/// The `ip_treasury` field in the TokenVerification PDA must be set by `set_ip_treasury`
/// before this instruction can be called.  The treasury address is immutable once set.
///
/// Authorization: caller must be `token_verification.ip_treasury`.
#[derive(Accounts)]
pub struct ClaimIpTreasuryFeeCtx<'info> {
    /// Pool authority PDA that signs token transfers.
    /// CHECK: Validated by address constraint to be the pool authority.
    #[account(address = const_pda::pool_authority::ID)]
    pub pool_authority: AccountInfo<'info>,

    /// The bonding curve pool holding accumulated fee counters.
    #[account(mut, has_one = base_vault, has_one = config)]
    pub pool: AccountLoader<'info, VirtualPool>,

    /// Pool config — required by `has_one = config` on pool.
    /// CHECK: Used only to satisfy the has_one constraint.
    pub config: AccountInfo<'info>,

    /// IP owner verification record for this pool.
    /// Constraint: ip_treasury must be set (REQ-I-005) and match the caller.
    #[account(
        seeds = [TokenVerification::SEED, pool.key().as_ref()],
        bump = token_verification.bump,
        constraint = token_verification.ip_treasury != Pubkey::default() @ PoolError::IpTreasuryNotSet,
        constraint = token_verification.ip_treasury == ip_treasury.key() @ PoolError::Unauthorized,
    )]
    pub token_verification: Account<'info, TokenVerification>,

    /// The IP treasury address — must sign this transaction.
    pub ip_treasury: Signer<'info>,

    /// Base mint (the bonding curve token).
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Pool's base vault — source of the treasury fee transfer.
    #[account(mut, token::mint = base_mint)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// IP treasury's token account that will receive the fees.
    #[account(mut, token::mint = base_mint)]
    pub ip_treasury_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Token program for the base mint.
    pub token_base_program: Interface<'info, TokenInterface>,
}

pub fn handle_claim_ip_treasury_fee<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ClaimIpTreasuryFeeCtx<'info>>,
    max_amount: u64,
) -> Result<()> {
    let mut pool = ctx.accounts.pool.load_mut()?;

    // Cap by the requested max and the available balance.
    let amount = pool.ip_treasury_base_fee.min(max_amount);
    require!(amount > 0, PoolError::AmountIsZero);

    pool.ip_treasury_base_fee = pool
        .ip_treasury_base_fee
        .checked_sub(amount)
        .ok_or(PoolError::MathOverflow)?;

    drop(pool);

    transfer_token_from_pool_authority(
        ctx.accounts.pool_authority.to_account_info(),
        &ctx.accounts.base_mint,
        &ctx.accounts.base_vault,
        ctx.accounts.ip_treasury_token_account.to_account_info(),
        &ctx.accounts.token_base_program,
        amount,
        ctx.remaining_accounts,
    )?;

    Ok(())
}
