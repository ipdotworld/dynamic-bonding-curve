use anchor_lang::prelude::*;

use crate::{
    state::{MigrationOption, MigrationProgress, PoolConfig, VirtualPool},
    EvtUpdatePoolCreator, PoolError,
};

/// Accounts for transfer pool creator
#[event_cpi]
#[derive(Accounts)]
pub struct TransferPoolCreatorCtx<'info> {
    #[account(
        mut,
        has_one = config,
    )]
    pub virtual_pool: AccountLoader<'info, VirtualPool>,

    pub config: AccountLoader<'info, PoolConfig>,

    pub creator: Signer<'info>,

    /// CHECK: new creator address, can be anything except old creator
    #[account(
        constraint = new_creator.key().ne(creator.key) @ PoolError::InvalidNewCreator,
    )]
    pub new_creator: UncheckedAccount<'info>,
}

pub fn handle_transfer_pool_creator<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, TransferPoolCreatorCtx>,
) -> Result<()> {
    let mut pool = ctx.accounts.virtual_pool.load_mut()?;

    let migration_progress = pool.get_migration_progress()?;
    let config = ctx.accounts.config.load()?;
    match migration_progress {
        MigrationProgress::PreBondingCurve => {
            // always work
        }
        MigrationProgress::CreatedPool => {
            let migration_option = MigrationOption::try_from(config.migration_option)
                .map_err(|_| PoolError::InvalidMigrationOption)?;
            // DAMM v1 (MeteoraDammDisabled) is no longer supported; all pools use DammV2.
            // DammV2 pools have no LP-token lock requirements here.
            let _ = migration_option;
        }
        _ => return Err(PoolError::NotPermitToDoThisAction.into()),
    }

    // SPEC-DBC-004 Phase 3 (REQ-I-001): `creator_quote_fee` field removed —
    // creator-side trading fee accumulation eliminated alongside
    // `creator_share`. Pre-transfer balance check no longer needed; any
    // unclaimed creator surplus is handled by the existing
    // `creator_withdraw_surplus` flow before transfer.

    pool.creator = ctx.accounts.new_creator.key();

    emit_cpi!(EvtUpdatePoolCreator {
        pool: ctx.accounts.virtual_pool.key(),
        creator: ctx.accounts.creator.key(),
        new_creator: ctx.accounts.new_creator.key(),
    });
    Ok(())
}
