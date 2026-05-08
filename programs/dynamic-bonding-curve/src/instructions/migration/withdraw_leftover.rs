use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    const_pda,
    safe_math::SafeMath,
    state::{MigrationProgress, PoolConfig, TokenVerification, VirtualPool},
    token::transfer_token_from_pool_authority,
    EvtWithdrawLeftover, PoolError,
};

/// Accounts for withdraw leftover
///
/// AC-A08: leftover is sent to `ip_treasury` from the pool's TokenVerification PDA.
/// If `ip_treasury` is not yet set (== Pubkey::default()), the instruction reverts
/// with `IpTreasuryNotSet`. The leftover stays in the vault until `set_ip_treasury`
/// is called for this pool.
#[event_cpi]
#[derive(Accounts)]
pub struct WithdrawLeftoverCtx<'info> {
    /// CHECK: pool authority
    #[account(
        address = const_pda::pool_authority::ID
    )]
    pub pool_authority: UncheckedAccount<'info>,

    pub config: AccountLoader<'info, PoolConfig>,

    #[account(
        mut,
        has_one = base_mint,
        has_one = base_vault,
        has_one = config,
    )]
    pub virtual_pool: AccountLoader<'info, VirtualPool>,

    /// The TokenVerification PDA for this pool.
    /// Holds `ip_treasury` — the destination for leftover tokens.
    #[account(
        seeds = [TokenVerification::SEED, virtual_pool.key().as_ref()],
        bump = token_verification.bump,
    )]
    pub token_verification: Account<'info, TokenVerification>,

    /// The receiver token account, withdraw to ATA of ip_treasury
    #[account(mut,
        associated_token::authority = token_verification.ip_treasury,
        associated_token::mint = base_mint,
        associated_token::token_program = token_base_program
    )]
    pub token_base_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The vault token account for output token
    #[account(mut, token::token_program = token_base_program, token::mint = base_mint)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The mint of base token
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Token base program
    pub token_base_program: Interface<'info, TokenInterface>,
}

pub fn handle_withdraw_leftover<'c: 'info, 'info>(ctx: Context<'_, '_, 'c, 'info, WithdrawLeftoverCtx<'info>>) -> Result<()> {
    let config = ctx.accounts.config.load()?;

    // AC-A08: ip_treasury must be set before withdrawing leftover.
    let ip_treasury = ctx.accounts.token_verification.ip_treasury;
    require!(
        ip_treasury != Pubkey::default(),
        PoolError::IpTreasuryNotSet
    );

    let mut virtual_pool = ctx.accounts.virtual_pool.load_mut()?;
    require!(
        virtual_pool.get_migration_progress()? == MigrationProgress::CreatedPool,
        PoolError::NotPermitToDoThisAction
    );

    require!(
        config.is_fixed_token_supply(),
        PoolError::NotPermitToDoThisAction
    );

    // Ensure the leftover has never been withdrawn
    require!(
        virtual_pool.is_withdraw_leftover == 0,
        PoolError::LeftoverHasBeenWithdraw
    );

    let leftover_amount = ctx
        .accounts
        .base_vault
        .amount
        .safe_sub(virtual_pool.get_protocol_and_trading_base_fee()?)?
        .safe_sub(virtual_pool.protocol_migration_base_fee_amount)?;

    transfer_token_from_pool_authority(
        ctx.accounts.pool_authority.to_account_info(),
        &ctx.accounts.base_mint,
        &ctx.accounts.base_vault,
        ctx.accounts.token_base_account.to_account_info(),
        &ctx.accounts.token_base_program,
        leftover_amount,
        ctx.remaining_accounts,
    )?;

    // update partner withdraw leftover
    virtual_pool.update_withdraw_leftover();

    emit_cpi!(EvtWithdrawLeftover {
        pool: ctx.accounts.virtual_pool.key(),
        ip_treasury,
        leftover_amount,
    });
    Ok(())
}
