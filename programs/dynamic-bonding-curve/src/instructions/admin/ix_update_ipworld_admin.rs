use anchor_lang::prelude::*;
use crate::state::IpworldState;
use crate::PoolError;
use crate::event::EvtAdminProposed;

#[derive(Accounts)]
pub struct UpdateIpworldAdminCtx<'info> {
    /// Must be current admin
    #[account(
        constraint = admin.key() == ipworld_state.admin
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [IpworldState::SEED],
        bump = ipworld_state.bump,
    )]
    pub ipworld_state: Account<'info, IpworldState>,
}

pub fn handle_update_ipworld_admin(
    ctx: Context<UpdateIpworldAdminCtx>,
    new_admin: Pubkey,
) -> Result<()> {
    require!(new_admin != Pubkey::default(), PoolError::InvalidAdmin);
    let old_admin = ctx.accounts.ipworld_state.admin;
    ctx.accounts.ipworld_state.pending_admin = new_admin;
    emit!(EvtAdminProposed {
        old_admin,
        pending_admin: new_admin,
    });
    Ok(())
}
