use anchor_lang::prelude::*;
use crate::state::IpworldState;
use crate::PoolError;
use crate::event::EvtAuthorityProposed;

#[derive(Accounts)]
pub struct UpdateIpworldAuthorityCtx<'info> {
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

pub fn handle_update_ipworld_authority(
    ctx: Context<UpdateIpworldAuthorityCtx>,
    new_authority: Pubkey,
) -> Result<()> {
    require!(new_authority != Pubkey::default(), PoolError::InvalidAuthority);
    let old_authority = ctx.accounts.ipworld_state.authority;
    ctx.accounts.ipworld_state.pending_authority = new_authority;
    emit!(EvtAuthorityProposed {
        old_authority,
        pending_authority: new_authority,
    });
    Ok(())
}
