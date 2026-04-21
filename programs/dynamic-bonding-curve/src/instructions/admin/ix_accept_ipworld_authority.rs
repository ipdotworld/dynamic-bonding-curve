use anchor_lang::prelude::*;
use crate::state::IpworldState;
use crate::PoolError;
use crate::event::EvtAuthorityAccepted;

#[derive(Accounts)]
pub struct AcceptIpworldAuthorityCtx<'info> {
    /// Must be the pending authority to accept the rotation
    #[account(
        constraint = new_authority.key() == ipworld_state.pending_authority @ PoolError::Unauthorized
    )]
    pub new_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [IpworldState::SEED],
        bump = ipworld_state.bump,
    )]
    pub ipworld_state: Account<'info, IpworldState>,
}

pub fn handle_accept_ipworld_authority(
    ctx: Context<AcceptIpworldAuthorityCtx>,
) -> Result<()> {
    let state = &mut ctx.accounts.ipworld_state;
    require!(state.pending_authority != Pubkey::default(), PoolError::NoPendingAuthority);
    let old_authority = state.authority;
    state.authority = state.pending_authority;
    state.pending_authority = Pubkey::default();
    emit!(EvtAuthorityAccepted {
        old_authority,
        new_authority: state.authority,
    });
    Ok(())
}
