use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    const_pda,
    state::{
        PoolConfig, VirtualPool, CREATOR_MIGRATION_FEE_MASK,
        PARTNER_MIGRATION_FEE_MASK,
    },
    token::transfer_token_from_pool_authority,
    EvtWithdrawMigrationFee, PoolError,
};

/// Accounts for creator withdraw migration fee
#[event_cpi]
#[derive(Accounts)]
pub struct WithdrawMigrationFeeCtx<'info> {
    /// CHECK: pool authority
    #[account(
        address = const_pda::pool_authority::ID
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(has_one = quote_mint)]
    pub config: AccountLoader<'info, PoolConfig>,

    #[account(
        mut,
        has_one = quote_vault,
        has_one = config,
    )]
    pub virtual_pool: AccountLoader<'info, VirtualPool>,

    /// The receiver token account
    #[account(mut)]
    pub token_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The vault token account for output token
    #[account(mut, token::token_program = token_quote_program, token::mint = quote_mint)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The mint of quote token
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    pub sender: Signer<'info>,

    /// Token b program
    pub token_quote_program: Interface<'info, TokenInterface>,
}

pub fn handle_withdraw_migration_fee<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, WithdrawMigrationFeeCtx<'info>>,
) -> Result<()> {
    let config = ctx.accounts.config.load()?;
    let mut pool = ctx.accounts.virtual_pool.load_mut()?;

    // Make sure pool has been completed
    require!(
        pool.is_curve_complete(config.migration_quote_threshold),
        PoolError::NotPermitToDoThisAction
    );

    // A-04: Partner/creator split removed. The entire migration fee goes to the
    // operator/treasury. The `SenderFlag`/`flag` parameter was a vestigial no-op
    // (only flag=0 was ever valid); the real authorization is the fee_claimer
    // check below.
    require!(
        ctx.accounts.sender.key() == config.fee_claimer,
        PoolError::NotPermitToDoThisAction
    );

    // Collect total migration fee (partner + creator shares combined)
    let total_migration_fee = {
        let crate::state::MigrationFeeDistribution {
            creator_migration_fee,
            partner_migration_fee,
        } = config.get_migration_fee_distribution()?;
        partner_migration_fee.checked_add(creator_migration_fee)
            .ok_or(PoolError::MathOverflow)?
    };

    // Ensure neither portion has been withdrawn yet
    require!(
        pool.eligible_to_withdraw_migration_fee(PARTNER_MIGRATION_FEE_MASK),
        PoolError::MigrationFeeHasBeenWithdraw
    );
    require!(
        pool.eligible_to_withdraw_migration_fee(CREATOR_MIGRATION_FEE_MASK),
        PoolError::MigrationFeeHasBeenWithdraw
    );

    // Mark both portions as withdrawn
    pool.update_withdraw_migration_fee(PARTNER_MIGRATION_FEE_MASK);
    pool.update_withdraw_migration_fee(CREATOR_MIGRATION_FEE_MASK);

    transfer_token_from_pool_authority(
        ctx.accounts.pool_authority.to_account_info(),
        &ctx.accounts.quote_mint,
        &ctx.accounts.quote_vault,
        ctx.accounts.token_quote_account.to_account_info(),
        &ctx.accounts.token_quote_program,
        total_migration_fee,
        ctx.remaining_accounts,
    )?;

    emit_cpi!(EvtWithdrawMigrationFee {
        pool: ctx.accounts.virtual_pool.key(),
        fee: total_migration_fee,
    });
    Ok(())
}
