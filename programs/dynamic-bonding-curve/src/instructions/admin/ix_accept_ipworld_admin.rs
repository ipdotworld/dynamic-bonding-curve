use anchor_lang::prelude::*;
use crate::state::IpworldState;
use crate::PoolError;
use crate::event::EvtAdminAccepted;

#[derive(Accounts)]
pub struct AcceptIpworldAdminCtx<'info> {
    /// Must be the pending admin to accept the transfer
    #[account(
        constraint = new_admin.key() == ipworld_state.pending_admin @ PoolError::Unauthorized
    )]
    pub new_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [IpworldState::SEED],
        bump = ipworld_state.bump,
    )]
    pub ipworld_state: Account<'info, IpworldState>,
}

pub fn handle_accept_ipworld_admin(
    ctx: Context<AcceptIpworldAdminCtx>,
) -> Result<()> {
    let state = &mut ctx.accounts.ipworld_state;
    require!(state.pending_admin != Pubkey::default(), PoolError::NoPendingAdmin);
    let old_admin = state.admin;
    state.admin = state.pending_admin;
    state.pending_admin = Pubkey::default();
    emit!(EvtAdminAccepted {
        old_admin,
        new_admin: state.admin,
    });
    Ok(())
}
